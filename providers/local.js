import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { ConflictError, KIND_ENV, assertRef } from '../core/provider.js';
import { PAYLOAD_HEADER_LEN } from '../core/crypto/header.js';

export const DEFAULT_PATH = '.wilsoon-store';

// Blobs can be plain files since an env blob carries its own version at an offset
function versionOf(blob, kind) {
  if (kind !== KIND_ENV) return 0n;

  if (blob.length < PAYLOAD_HEADER_LEN) throw new Error('Stored blob is truncated.');

  return blob.readBigUInt64LE(8);
}

export function create(options = {}, { dir } = {}) {
  const root = path.resolve(dir ?? process.cwd(), options.path ?? DEFAULT_PATH);

  const fileFor = (ref) => {
    assertRef(ref);
    return path.join(root, ref.project, ref.kind, ref.name);
  };

  return {
    name: 'local',
    atomicCas: false,
    singleMachine: true,
    describe: () => root,

    async get(ref) {
      try {
        const blob = await readFile(fileFor(ref));
        return { blob, version: versionOf(blob, ref.kind) };
      } catch (err) {
        if (err.code === 'ENOENT') return null;

        throw err;
      }
    },

    async put(ref, blob, { ifVersion } = {}) {
      const file = fileFor(ref);

      if (ifVersion !== undefined) {
        const current = await this.get(ref);
        const actual = current?.version ?? 0n;
        if (actual !== BigInt(ifVersion)) throw new ConflictError(BigInt(ifVersion), actual);
      }

      await mkdir(path.dirname(file), { recursive: true });

      const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFile(tmp, blob, { mode: 0o600 });
      await rename(tmp, file);

      return { version: versionOf(blob, ref.kind) };
    },

    async list(project) {
      const out = [];

      for (const kind of ['identity', 'env']) {
        let names;
        try {
          names = await readdir(path.join(root, project, kind));
        } catch (err) {
          if (err.code === 'ENOENT') continue;

          throw err;
        }

        for (const name of names) {
          if (name.endsWith('.tmp')) continue;

          const found = await this.get({ project, kind, name });
          if (found) out.push({ kind, name, version: found.version });
        }
      }

      return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    },

    async remove(ref) {
      try {
        await rm(fileFor(ref));
        return true;
      } catch (err) {
        if (err.code === 'ENOENT') return false;

        throw err;
      }
    }
  };
}
