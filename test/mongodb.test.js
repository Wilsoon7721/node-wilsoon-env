import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConflictError } from '../core/provider.js';
import { generateIdentity } from '../core/crypto/identity.js';
import { seal } from '../core/crypto/envelope.js';

/*
  A stand-in for the driver, not a MongoDB.

  These prove the adapter issues the right operations with the right filters -
  above all that the expected version travels *into* the updateOne filter, which
  is what makes this compare-and-swap atomic rather than a read-then-write.

  The semantics the server owns were checked separately against a real Atlas
  cluster: unique-index enforcement on a duplicate first write, a stale update
  matching no document, and blobs round-tripping as BSON Binary. Those are not
  reproduced here because they need a live server; this file is the fast check
  that the query shapes have not drifted.
*/
const calls = [];
let docs;
let failNextInsert;

class FakeCollection {
  async createIndex(spec, opts) {
    calls.push({ op: 'createIndex', spec, opts });
  }

  async findOne(filter) {
    calls.push({ op: 'findOne', filter });
    return docs.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v)) ?? null;
  }

  async insertOne(doc) {
    calls.push({ op: 'insertOne', doc });

    if (failNextInsert) {
      failNextInsert = false;
      const err = new Error('E11000 duplicate key error');
      err.code = 11000;
      throw err;
    }

    docs.push({ ...doc });
    return { insertedId: '1' };
  }

  async replaceOne(filter, doc, opts) {
    calls.push({ op: 'replaceOne', filter, opts });

    const found = docs.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
    if (found) Object.assign(found, doc);
    else docs.push({ ...doc });

    return { matchedCount: found ? 1 : 0 };
  }

  async updateOne(filter, update) {
    calls.push({ op: 'updateOne', filter, update });

    const found = docs.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v));
    if (found) Object.assign(found, update.$set);

    return { matchedCount: found ? 1 : 0 };
  }

  find(filter, opts) {
    calls.push({ op: 'find', filter, opts });
    const matched = docs.filter((d) => Object.entries(filter).every(([k, v]) => d[k] === v));

    return { toArray: async () => matched };
  }

  async deleteOne(filter) {
    calls.push({ op: 'deleteOne', filter });
    const before = docs.length;
    docs = docs.filter((d) => !Object.entries(filter).every(([k, v]) => d[k] === v));

    return { deletedCount: before - docs.length };
  }
}

let closed;

vi.mock('mongodb', () => ({
  MongoClient: class {
    constructor(uri, opts) {
      calls.push({ op: 'construct', uri, opts });
    }
    async connect() {
      calls.push({ op: 'connect' });
    }
    db(name) {
      calls.push({ op: 'db', name });
      return { collection: (c) => { calls.push({ op: 'collection', name: c }); return new FakeCollection(); } };
    }
    async close() {
      closed = true;
    }
  }
}));

const { create } = await import('../providers/mongodb.js');

const me = generateIdentity();
const ref = { project: 'demo', kind: 'env', name: '.env.production' };
const blobAt = (version) => seal({ plaintext: 'A=1\n', recipients: [me.publicRaw], project: ref.project, name: ref.name, version });

const options = { uri: 'mongodb://127.0.0.1:27017', db: 'wenv', collection: 'blobs' };

beforeEach(() => {
  docs = [];
  calls.length = 0;
  failNextInsert = false;
  closed = false;
});

afterEach(() => vi.restoreAllMocks());

describe('mongodb provider', () => {
  it('needs a uri', () => expect(() => create({})).toThrow(/needs a "uri"/));

  it('connects once and reuses the connection', async () => {
    const db = create(options);
    await db.get(ref);
    await db.get(ref);

    expect(calls.filter((c) => c.op === 'connect')).toHaveLength(1);
  });

  it('creates the unique index that makes a first write safe', async () => {
    await create(options).get(ref);

    const index = calls.find((c) => c.op === 'createIndex');
    expect(index.spec).toEqual({ project: 1, kind: 1, name: 1 });
    expect(index.opts).toEqual({ unique: true });
  });

  it('returns null for a document that is not there', async () => expect(await create(options).get(ref)).toBe(null));

  it('round-trips a blob', async () => {
    const db = create(options);
    const blob = blobAt(3);

    expect((await db.put(ref, blob)).version).toBe(3n);

    const got = await db.get(ref);
    expect(got.blob.equals(blob)).toBe(true);
    expect(got.version).toBe(3n);
  });

  it('puts the expected version into the filter, so the server does the comparing', async () => {
    const db = create(options);
    await db.put(ref, blobAt(1), { ifVersion: 0 });
    await db.put(ref, blobAt(2), { ifVersion: 1 });

    const update = calls.filter((c) => c.op === 'updateOne').at(-1);

    // This is the whole point: no read-then-write in the client.
    expect(update.filter).toEqual({ project: 'demo', kind: 'env', name: '.env.production', version: 1 });
    expect(create(options).atomicCas).toBe(true);
  });

  it('inserts rather than updates for a first write', async () => {
    const db = create(options);
    await db.put(ref, blobAt(1), { ifVersion: 0 });

    expect(calls.some((c) => c.op === 'insertOne')).toBe(true);
    expect(calls.some((c) => c.op === 'updateOne')).toBe(false);
  });

  it('treats a duplicate key on first write as a conflict', async () => {
    const db = create(options);
    failNextInsert = true;

    await expect(db.put(ref, blobAt(1), { ifVersion: 0 })).rejects.toThrow(ConflictError);
  });

  it('raises a conflict when no document matches the expected version', async () => {
    const db = create(options);
    await db.put(ref, blobAt(1), { ifVersion: 0 });

    await expect(db.put(ref, blobAt(2), { ifVersion: 7 })).rejects.toThrow(ConflictError);
  });

  it('upserts unconditionally when no version is expected', async () => {
    const db = create(options);
    await db.put(ref, blobAt(1));

    const replace = calls.find((c) => c.op === 'replaceOne');
    expect(replace.opts).toEqual({ upsert: true });
  });

  it('reads BSON Binary back as a Buffer', async () => {
    const db = create(options);
    const blob = blobAt(2);
    await db.put(ref, blob);

    // The real driver returns Binary, not Buffer.
    docs[0].blob = { buffer: new Uint8Array(blob) };

    expect((await db.get(ref)).blob.equals(blob)).toBe(true);
  });

  it('lists a project', async () => {
    const db = create(options);
    await db.put(ref, blobAt(4));
    await db.put({ ...ref, name: '.env.local' }, blobAt(2));

    expect(await db.list('demo')).toEqual([
      { kind: 'env', name: '.env.local', version: 2n },
      { kind: 'env', name: '.env.production', version: 4n }
    ]);
  });

  it('removes, reporting whether a document was there', async () => {
    const db = create(options);
    await db.put(ref, blobAt(1));

    expect(await db.remove(ref)).toBe(true);
    expect(await db.remove(ref)).toBe(false);
  });

  it('hangs up when closed, and can reconnect after', async () => {
    const db = create(options);
    await db.get(ref);
    await db.close();

    expect(closed).toBe(true);

    calls.length = 0;
    await db.get(ref);
    expect(calls.filter((c) => c.op === 'connect')).toHaveLength(1);
  });

  it('refuses a ref that would escape the collection', async () => {
    await expect(create(options).get({ project: 'demo', kind: 'env', name: '../escape' })).rejects.toThrow(/escape the store/);
  });
});
