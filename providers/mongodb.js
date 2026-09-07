import { ConflictError, KIND_ENV, assertRef } from '../core/provider.js';
import { PAYLOAD_HEADER_LEN } from '../core/crypto/header.js';

/**
 * MongoDB using its driver
 * Uses a socket, close() handled by library.
 */

const DEFAULT_DB = 'wilsoon_env';
const DEFAULT_COLLECTION = 'blobs';

function versionOf(blob, kind) {
  if (kind !== KIND_ENV) return 0n;
  if (blob.length < PAYLOAD_HEADER_LEN) throw new Error('Stored blob is truncated.');

  return blob.readBigUInt64LE(8);
}

/* The driver gives BSON binary, convert to buffer */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value?.buffer) return Buffer.from(value.buffer);

  return Buffer.from(value);
}

export function create(options = {}, { dir } = {}) {
  const uri = options.uri ?? process.env.MONGODB_URI;

  if (!uri) throw new Error('The mongodb provider needs a "uri" in its options, or MONGODB_URI.');

  const dbName = options.db ?? DEFAULT_DB;
  const collectionName = options.collection ?? DEFAULT_COLLECTION;

  let client = null;
  let ready = null;

  async function collection() {
    if (!ready)
      ready = (async () => {
        let driver;
        try {
          driver = await import('mongodb');
        } catch (err) {
          const missing = err?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module) 'mongodb'|Could not resolve "mongodb"/.test(String(err?.message));

          if (missing) throw new Error('The "mongodb" provider needs its driver installed:\n\n  npm i mongodb\n');

          throw err;
        }

        client = new driver.MongoClient(uri, { ignoreUndefined: true });
        await client.connect();

        const col = client.db(dbName).collection(collectionName);

        await col.createIndex({ project: 1, kind: 1, name: 1 }, { unique: true });

        return col;
      })();

    return await ready;
  }

  const filterFor = (ref) => {
    assertRef(ref);
    return { project: ref.project, kind: ref.kind, name: ref.name };
  };

  return {
    name: 'mongodb',
    atomicCas: true,
    describe: () => `mongodb ${dbName}.${collectionName}`,

    async get(ref) {
      const found = await (await collection()).findOne(filterFor(ref));
      if (!found) return null;

      const blob = toBuffer(found.blob);
      return { blob, version: versionOf(blob, ref.kind) };
    },

    async put(ref, blob, { ifVersion } = {}) {
      const col = await collection();
      const filter = filterFor(ref);
      const version = versionOf(blob, ref.kind);
      const document = { ...filter, version: Number(version), blob, updatedAt: new Date() };

      if (ifVersion === undefined) {
        await col.replaceOne(filter, document, { upsert: true });
        return { version };
      }

      if (BigInt(ifVersion) === 0n)
        try {
          await col.insertOne(document);
          return { version };
        } catch (err) {
          // 11000 is duplicate key
          if (err?.code === 11000) {
            const current = await this.get(ref);
            throw new ConflictError(0n, current?.version ?? 0n);
          }

          throw err;
        }

      const result = await col.updateOne({ ...filter, version: Number(ifVersion) }, { $set: document });

      if (result.matchedCount === 0) {
        const current = await this.get(ref);
        throw new ConflictError(BigInt(ifVersion), current?.version ?? 0n);
      }

      return { version };
    },

    async list(project) {
      const col = await collection();
      const found = await col.find({ project }, { projection: { kind: 1, name: 1, version: 1 } }).toArray();

      return found.map((d) => ({ kind: d.kind, name: d.name, version: BigInt(d.version ?? 0) })).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    },

    async remove(ref) {
      const result = await (await collection()).deleteOne(filterFor(ref));
      return result.deletedCount > 0;
    },

    async close() {
      if (client) await client.close();

      client = null;
      ready = null;
    }
  };
}
