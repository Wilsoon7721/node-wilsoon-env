import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { setup } from '../cli/commands/setup.js';
import { push } from '../cli/commands/push.js';
import { pull } from '../cli/commands/pull.js';
import { status } from '../cli/commands/status.js';
import { loadConfig } from '../core/config.js';
import { create as createLocal } from '../providers/local.js';
import { encodePublic, generateIdentity } from '../core/crypto/identity.js';

/*
  A conflict needs two machines pushing at once, which a single test process
  cannot reliably stage - the pushes just serialise. The provider's own
  compare-and-swap is covered deterministically in store.test.js; what is left to
  prove here is that push reacts correctly when a provider raises one.
*/
vi.mock('../providers/local.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { ConflictError } = await import('../core/provider.js');

  return {
    ...actual,
    create(options, ctx) {
      const real = actual.create(options, ctx);
      const wrapped = Object.create(real);

      wrapped.put = async (ref, blob, opts) => {
        if (process.env.WENV_TEST_CONFLICT && ref.kind === 'env') throw new ConflictError(0n, 7n);

        return real.put(ref, blob, opts);
      };

      return wrapped;
    }
  };
});

const PASSPHRASE = 'a sufficiently long passphrase';

const PROD = 'DATABASE_URL=postgres://prod/db\nSTRIPE_SECRET_KEY=sk_live_xyz\n';
const LOCAL = 'DATABASE_URL=postgres://localhost/db\nDEBUG=true\n';

let dir;
let logs;

const args = (flags = {}, positional = []) => ({ flags: { cwd: dir, ...flags }, positional, rest: [] });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wenv-cli-'));

  process.env.WILSOON_ENV_PASSPHRASE = PASSPHRASE;
  process.env.WILSOON_ENV_STATE_DIR = dir;

  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.WILSOON_ENV_PASSPHRASE;
  delete process.env.WILSOON_ENV_STATE_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function withEnvFiles() {
  await writeFile(path.join(dir, '.env.production'), PROD);
  await writeFile(path.join(dir, '.env.local'), LOCAL);
  await writeFile(path.join(dir, '.env.example'), 'DATABASE_URL=\n');
}

async function project() {
  await setup(args({ project: 'demo' }));
}

describe('setup', () => {
  it('writes a committable config, stores an identity, and guards .gitignore', async () => {
    expect(await project()).toBe(undefined);

    const loaded = await loadConfig(dir);
    expect(loaded.config.project).toBe('demo');
    expect(loaded.config.provider).toBe('local');
    expect(loaded.config.recipients).toHaveLength(1);
    expect(loaded.config.recipients[0].pubkey).toMatch(/^wenv1/);

    // The config is committed, so it must never contain key material.
    const raw = await readFile(loaded.file, 'utf8');
    expect(raw).not.toContain(PASSPHRASE);

    // Addressed by key id, not a shared "default" slot, so two people can use one store.
    const store = createLocal({}, { dir });
    expect(await store.get({ project: 'demo', kind: 'identity', name: loaded.config.recipients[0].keyid })).toBeTruthy();

    const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('!.env.example');
  });

  it('refuses to clobber an existing project without --force', async () => {
    await project();
    expect(await setup(args({ project: 'demo' }))).toBe(1);
  });
});

describe('push and pull', () => {
  it('round-trips every .env file, skipping examples', async () => {
    await withEnvFiles();
    await project();

    expect(await push(args({ yes: true }))).toBe(0);

    await rm(path.join(dir, '.env.production'));
    await rm(path.join(dir, '.env.local'));

    expect(await pull(args({ force: true }))).toBe(0);

    expect(await readFile(path.join(dir, '.env.production'), 'utf8')).toBe(PROD);
    expect(await readFile(path.join(dir, '.env.local'), 'utf8')).toBe(LOCAL);

    // Never stored, so never restored.
    const store = createLocal({}, { dir });
    expect(await store.get({ project: 'demo', kind: 'env', name: '.env.example' })).toBe(null);
  });

  it('is a no-op when the local files already match', async () => {
    await withEnvFiles();
    await project();
    await push(args({ yes: true }));

    logs = [];
    expect(await pull(args())).toBe(0);
    expect(logs.join('\n')).toMatch(/already up to date/);
  });

  it('increments the version on each push', async () => {
    await withEnvFiles();
    await project();

    await push(args({ yes: true }));
    await push(args({ yes: true }));

    const store = createLocal({}, { dir });
    expect((await store.get({ project: 'demo', kind: 'env', name: '.env.production' })).version).toBe(2n);
  });

  it('pushes only the files named', async () => {
    await withEnvFiles();
    await project();

    await push(args({ yes: true }, ['.env.production']));

    const store = createLocal({}, { dir });
    expect(await store.get({ project: 'demo', kind: 'env', name: '.env.production' })).toBeTruthy();
    expect(await store.get({ project: 'demo', kind: 'env', name: '.env.local' })).toBe(null);
  });

  it('refuses the wrong passphrase, and writes nothing', async () => {
    await withEnvFiles();
    await project();
    await push(args({ yes: true }));
    await rm(path.join(dir, '.env.production'));

    process.env.WILSOON_ENV_PASSPHRASE = 'not the passphrase';

    await expect(pull(args({ force: true }))).rejects.toThrow(/wrong passphrase|altered/i);
    await expect(readFile(path.join(dir, '.env.production'), 'utf8')).rejects.toThrow();
  });

  it('picks up where the store left off rather than restarting the version', async () => {
    await withEnvFiles();
    await project();
    await push(args({ yes: true }));

    // Another machine pushed while we were away. push must build on that version,
    // not overwrite it with a lower one.
    const store = createLocal({}, { dir });
    const stored = await store.get({ project: 'demo', kind: 'env', name: '.env.production' });
    const bumped = Buffer.from(stored.blob);
    bumped.writeBigUInt64LE(99n, 8);
    await store.put({ project: 'demo', kind: 'env', name: '.env.production' }, bumped);

    expect(await push(args({ yes: true }))).toBe(0);
    expect((await store.get({ project: 'demo', kind: 'env', name: '.env.production' })).version).toBe(100n);
  });

  it('skips the file and reports failure when the store rejects a stale write', async () => {
    await withEnvFiles();
    await project();

    process.env.WENV_TEST_CONFLICT = '1';
    logs = [];

    try {
      expect(await push(args({ yes: true }))).toBe(1);
      expect(logs.join('\n')).toMatch(/changed in the store/);
      expect(logs.join('\n')).toMatch(/Pull first/);
    } finally {
      delete process.env.WENV_TEST_CONFLICT;
    }
  });
});

describe('recipients', () => {
  it('asks before granting access to a newly added recipient', async () => {
    await withEnvFiles();
    await project();
    await push(args({ yes: true }));

    const loaded = await loadConfig(dir);
    const outsider = generateIdentity();

    await writeFile(loaded.file, JSON.stringify({ ...loaded.config, recipients: [...loaded.config.recipients, { name: 'bob', pubkey: encodePublic(outsider.publicRaw) }] }, null, 2));

    // Non-interactive, so confirm() falls back to "no" and nothing is granted.
    logs = [];
    expect(await push(args())).toBe(1);
    expect(logs.join('\n')).toMatch(/grants access to 1 new recipient/);
    expect(logs.join('\n')).toMatch(/Nothing was pushed/);
  });

  it('lets a second recipient decrypt once the push is confirmed', async () => {
    await withEnvFiles();
    await project();
    await push(args({ yes: true }));

    const loaded = await loadConfig(dir);
    const bob = generateIdentity();

    await writeFile(loaded.file, JSON.stringify({ ...loaded.config, recipients: [...loaded.config.recipients, { name: 'bob', pubkey: encodePublic(bob.publicRaw) }] }, null, 2));

    expect(await push(args({ yes: true }))).toBe(0);

    const store = createLocal({}, { dir });
    const stored = await store.get({ project: 'demo', kind: 'env', name: '.env.production' });

    const { open } = await import('../core/crypto/envelope.js');
    expect(open({ blob: stored.blob, privateRaw: bob.privateRaw, project: 'demo', name: '.env.production' }).plaintext.toString()).toBe(PROD);
  });
});

describe('status', () => {
  it('reports drift in both directions without decrypting', async () => {
    await withEnvFiles();
    await project();
    await push(args({ yes: true }));

    await writeFile(path.join(dir, '.env.staging'), 'A=1\n');
    await rm(path.join(dir, '.env.local'));

    // No passphrase available at all - status must still work.
    delete process.env.WILSOON_ENV_PASSPHRASE;

    logs = [];
    expect(await status(args())).toBe(0);

    const out = logs.join('\n');
    expect(out).toMatch(/\.env\.staging/);
    expect(out).toMatch(/local only/);
    expect(out).toMatch(/remote only/);
  });
});

describe('errors', () => {
  it('says what to run when there is no config', async () => await expect(push(args())).rejects.toThrow(/@wilsoon\/env setup/));

  it('says what to run when nothing has been pushed', async () => {
    await project();
    expect(await pull(args())).toBe(1);
    expect(logs.join('\n')).toMatch(/Nothing stored/);
  });
});
