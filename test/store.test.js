import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_EXCLUDE, diff, discover, isSyncable, parse, serialise } from '../core/dotenv.js';
import { findConfig, loadConfig } from '../core/config.js';
import { ConflictError, assertRef, resolveProvider } from '../core/provider.js';
import { create as createLocal } from '../providers/local.js';
import { generateIdentity } from '../core/crypto/identity.js';
import { seal } from '../core/crypto/envelope.js';

let dir;

beforeEach(async () => (dir = await mkdtemp(path.join(tmpdir(), 'wenv-'))));

afterEach(async () => await rm(dir, { recursive: true, force: true }));

describe('dotenv discovery', () => {
  it('finds env files and skips examples, backups and ciphertext', async () => {
    for (const name of ['.env', '.env.local', '.env.production', '.env.example', '.env.production.example', '.env.enc', '.env.bak', 'README.md']) {
      await writeFile(path.join(dir, name), 'A=1\n');
    }

    expect(await discover(dir)).toEqual(['.env', '.env.local', '.env.production']);
  });

  it('keeps .env.local, which is the whole point of syncing', () => {
    expect(isSyncable('.env.local')).toBe(true);
    expect(isSyncable('.env.example', { exclude: DEFAULT_EXCLUDE })).toBe(false);
  });

  it('returns nothing for a directory that is not there', async () => expect(await discover(path.join(dir, 'nope'))).toEqual([]));

  it('treats similar names as distinct files rather than normalising them', async () => {
    for (const name of ['.env.dev', '.env.development']) await writeFile(path.join(dir, name), 'A=1\n');

    expect(await discover(dir)).toEqual(['.env.dev', '.env.development']);
  });
});

describe('dotenv parsing', () => {
  it('handles the shapes a real file contains', () => {
    const parsed = parse(
      ['# a comment', 'PLAIN=value', 'SPACED = spaced ', 'export EXPORTED=yes', "SINGLE='raw $notexpanded #nothash'", 'DOUBLE="line\\nbreak"', 'EMPTY=', 'TRAILING=value # trailing comment', 'URL=postgres://user:pass@host:5432/db?ssl=true'].join('\n')
    );

    expect(parsed.get('PLAIN')).toBe('value');
    expect(parsed.get('SPACED')).toBe('spaced');
    expect(parsed.get('EXPORTED')).toBe('yes');
    expect(parsed.get('SINGLE')).toBe('raw $notexpanded #nothash');
    expect(parsed.get('DOUBLE')).toBe('line\nbreak');
    expect(parsed.get('EMPTY')).toBe('');
    expect(parsed.get('TRAILING')).toBe('value');
    expect(parsed.get('URL')).toBe('postgres://user:pass@host:5432/db?ssl=true');
  });

  it('survives CRLF', () => expect(parse('A=1\r\nB=2\r\n').get('B')).toBe('2'));

  it('round-trips through serialise', () => {
    const original = 'A=1\nB="has spaces"\nC=\n';
    expect(parse(serialise(parse(original)))).toEqual(parse(original));
  });

  it('reports what changed', () => {
    const d = diff('A=1\nB=2\nC=3\n', 'B=2\nC=changed\nD=4\n');

    expect(d.added).toEqual(['D']);
    expect(d.removed).toEqual(['A']);
    expect(d.changed).toEqual(['C']);
    expect(d.unchanged).toEqual(['B']);
  });
});

describe('config', () => {
  it('reads a standalone config file', async () => {
    await writeFile(path.join(dir, 'wilsoon-env.config.json'), JSON.stringify({ project: 'demo', provider: 'local' }));

    const loaded = await loadConfig(dir);

    expect(loaded.config.project).toBe('demo');
    expect(loaded.source).toBe('wilsoon-env.config.json');
    expect(loaded.config.recipients).toEqual([]);
  });

  it('prefers a package.json key over a config file in the same directory', async () => {
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', 'wilsoon-env': { project: 'from-pkg', provider: 'local' } }));
    await writeFile(path.join(dir, 'env.config.json'), JSON.stringify({ project: 'from-file', provider: 'local' }));

    expect((await loadConfig(dir)).config.project).toBe('from-pkg');
  });

  it('walks up from a subdirectory', async () => {
    await writeFile(path.join(dir, 'env.config.json'), JSON.stringify({ project: 'demo', provider: 'local' }));
    const nested = path.join(dir, 'src', 'deep');
    await mkdir(nested, { recursive: true });

    expect((await findConfig(nested)).dir).toBe(dir);
  });

  it('returns null when there is no config anywhere above', async () => expect(await loadConfig(dir)).toBe(null));

  it('interpolates environment variables', async () => {
    process.env.WENV_TEST_ENDPOINT = 'https://example.test';
    await writeFile(path.join(dir, 'env.config.json'), JSON.stringify({ project: 'demo', provider: 'local', options: { endpoint: '${WENV_TEST_ENDPOINT}' } }));

    expect((await loadConfig(dir)).config.options.endpoint).toBe('https://example.test');
    delete process.env.WENV_TEST_ENDPOINT;
  });

  it('refuses an unset variable rather than substituting empty string', async () => {
    await writeFile(path.join(dir, 'env.config.json'), JSON.stringify({ project: 'demo', provider: 'local', options: { endpoint: '${WENV_DEFINITELY_UNSET}' } }));

    await expect(loadConfig(dir)).rejects.toThrow(/WENV_DEFINITELY_UNSET/);
  });

  it('rejects incomplete or malformed config', async () => {
    const file = path.join(dir, 'env.config.json');

    await writeFile(file, JSON.stringify({ provider: 'local' }));
    await expect(loadConfig(dir)).rejects.toThrow(/missing "project"/);

    await writeFile(file, JSON.stringify({ project: 'demo' }));
    await expect(loadConfig(dir)).rejects.toThrow(/missing "provider"/);

    await writeFile(file, JSON.stringify({ project: 'a/b', provider: 'local' }));
    await expect(loadConfig(dir)).rejects.toThrow(/path separators/);

    await writeFile(file, JSON.stringify({ project: 'demo', provider: 'local', recipients: [{ name: 'bob' }] }));
    await expect(loadConfig(dir)).rejects.toThrow(/missing "pubkey"/);

    await writeFile(file, '{ not json');
    await expect(loadConfig(dir)).rejects.toThrow(/not valid JSON/);
  });
});

describe('refs', () => {
  it('refuses anything that would escape the store', () => {
    for (const bad of ['..', '.', 'a/b', 'a\\b', 'a\0b']) {
      expect(() => assertRef({ project: bad, kind: 'env', name: '.env' })).toThrow();
      expect(() => assertRef({ project: 'demo', kind: 'env', name: bad })).toThrow();
    }

    expect(() => assertRef({ project: 'demo', kind: 'nope', name: '.env' })).toThrow(/Unknown blob kind/);
    expect(() => assertRef({ project: 'demo', kind: 'env', name: '.env.production' })).not.toThrow();
  });
});

describe('local provider', () => {
  const ref = { project: 'demo', kind: 'env', name: '.env.production' };
  const me = generateIdentity();

  const blobAt = (version) => seal({ plaintext: 'A=1\n', recipients: [me.publicRaw], project: ref.project, name: ref.name, version });

  it('returns null for something that was never stored', async () => expect(await createLocal({}, { dir }).get(ref)).toBe(null));

  it('round-trips a blob and reads its version out of the header', async () => {
    const store = createLocal({}, { dir });
    const blob = blobAt(3);

    expect((await store.put(ref, blob)).version).toBe(3n);

    const got = await store.get(ref);
    expect(got.blob.equals(blob)).toBe(true);
    expect(got.version).toBe(3n);
  });

  it('enforces compare-and-swap so a concurrent push cannot be clobbered', async () => {
    const store = createLocal({}, { dir });
    await store.put(ref, blobAt(1));

    await expect(store.put(ref, blobAt(2), { ifVersion: 0 })).rejects.toThrow(ConflictError);
    await expect(store.put(ref, blobAt(2), { ifVersion: 1 })).resolves.toMatchObject({ version: 2n });
  });

  it('treats a first write as version 0 for CAS purposes', async () => {
    const store = createLocal({}, { dir });
    await expect(store.put(ref, blobAt(1), { ifVersion: 0 })).resolves.toBeTruthy();
  });

  it('lists what it holds and leaves no temp files behind', async () => {
    const store = createLocal({}, { dir });
    await store.put(ref, blobAt(1));
    await store.put({ ...ref, name: '.env.local' }, blobAt(1));

    const listed = await store.list('demo');

    expect(listed.map((e) => e.name)).toEqual(['.env.local', '.env.production']);
    expect(listed.every((e) => !e.name.endsWith('.tmp'))).toBe(true);
  });

  it('removes, and reports whether there was anything to remove', async () => {
    const store = createLocal({}, { dir });
    await store.put(ref, blobAt(1));

    expect(await store.remove(ref)).toBe(true);
    expect(await store.remove(ref)).toBe(false);
    expect(await store.get(ref)).toBe(null);
  });
});

describe('provider resolution', () => {
  it('loads the built-in local provider', async () => {
    const provider = await resolveProvider({ provider: 'local', options: {} }, dir);
    expect(provider.name).toBe('local');
  });

  it('says an unbuilt provider is unbuilt, rather than blaming a missing driver', async () => await expect(resolveProvider({ provider: 'mongodb', options: {} }, dir)).rejects.toThrow(/not available in this version/));

  it('lists what is available for an unknown provider', async () => await expect(resolveProvider({ provider: 'dropbox', options: {} }, dir)).rejects.toThrow(/Available: local/));
});
