import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm as rmFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { setup } from '../cli/commands/setup.js';
import { push } from '../cli/commands/push.js';
import { keys } from '../cli/commands/keys.js';
import { rm } from '../cli/commands/rm.js';
import { loadConfig } from '../core/config.js';
import { create as createLocal } from '../providers/local.js';
import { generateIdentity, sealIdentity } from '../core/crypto/identity.js';

const PASSPHRASE = 'a sufficiently long passphrase';

let dir;
let logs;

const args = (flags = {}, positional = []) => ({ flags: { cwd: dir, ...flags }, positional, rest: [] });
const store = () => createLocal({}, { dir });
const stored = (name) => store().get({ project: 'demo', kind: 'env', name });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wenv-ra-'));

  process.env.WILSOON_ENV_PASSPHRASE = PASSPHRASE;
  process.env.WILSOON_ENV_STATE_DIR = dir;

  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));

  await writeFile(path.join(dir, '.env'), 'A=1\n');
  await writeFile(path.join(dir, '.env.staging'), 'B=2\n');
  await setup(args({ project: 'demo' }));
  await push(args({ yes: true }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.WILSOON_ENV_PASSPHRASE;
  delete process.env.WILSOON_ENV_STATE_DIR;
  await rmFile(dir, { recursive: true, force: true });
});

describe('rm', () => {
  it('needs filenames', async () => {
    expect(await rm(args())).toBe(1);
    expect(logs.join('\n')).toMatch(/Name the files/);
  });

  it('deletes from the store but never the local copy', async () => {
    expect(await rm(args({ yes: true }, ['.env.staging']))).toBe(0);

    expect(await stored('.env.staging')).toBe(null);
    await expect(readFile(path.join(dir, '.env.staging'), 'utf8')).resolves.toBe('B=2\n');
  });

  it('leaves the other files alone', async () => {
    await rm(args({ yes: true }, ['.env.staging']));

    expect(await stored('.env')).toBeTruthy();
  });

  it('reports a name that is not in the store, and does nothing', async () => {
    expect(await rm(args({ yes: true }, ['.env.nope']))).toBe(1);
    expect(logs.join('\n')).toMatch(/not in the store/);
    expect(await stored('.env')).toBeTruthy();
  });

  it('removes what it can when only some names exist', async () => {
    expect(await rm(args({ yes: true }, ['.env.staging', '.env.nope']))).toBe(0);

    expect(await stored('.env.staging')).toBe(null);
    expect(logs.join('\n')).toMatch(/\.env\.nope is not in the store/);
  });

  it('does nothing without confirmation', async () => {
    // Non-interactive, so confirm() falls back to no.
    expect(await rm(args({}, ['.env.staging']))).toBe(1);

    expect(await stored('.env.staging')).toBeTruthy();
    expect(logs.join('\n')).toMatch(/Nothing was removed/);
  });
});

describe('keys audit', () => {
  // Replaces the identity setup created, rather than adding a second one beside it.
  async function sealIdentityAt(params) {
    const { keyid } = (await loadConfig(dir)).config.recipients[0];
    const { privateRaw } = generateIdentity();
    await store().put({ project: 'demo', kind: 'identity', name: keyid }, await sealIdentity(privateRaw, PASSPHRASE, params));
  }

  it('passes an identity sealed at the shipped parameters', async () => {
    expect(await keys(args({}, ['audit']))).toBe(0);

    const out = logs.join('\n');
    expect(out).toMatch(/64 MiB/);
    expect(out).toMatch(/t=3/);
  });

  it('flags one sealed below the policy, and exits non-zero', async () => {
    await sealIdentityAt({ id: 1, log2m: 10, t: 1, p: 1 });

    logs = [];
    expect(await keys(args({}, ['audit']))).toBe(1);

    const out = logs.join('\n');
    expect(out).toMatch(/1 MiB/);
    expect(out).toMatch(/below policy/);
  });

  it('honours a stricter policy from the config', async () => {
    const loaded = await loadConfig(dir);
    await writeFile(loaded.file, JSON.stringify({ ...loaded.config, kdf: { id: 1, log2m: 20, t: 4, p: 1 } }, null, 2));

    logs = [];
    // The shipped default is now below the project's own policy.
    expect(await keys(args({}, ['audit']))).toBe(1);
    expect(logs.join('\n')).toMatch(/below policy \(1024 MiB, t=4\)/);
  });

  it('says which recipients it cannot check', async () => {
    await keys(args({ name: 'ci', files: '.env' }, ['new']));

    logs = [];
    await keys(args({}, ['audit']));

    expect(logs.join('\n')).toMatch(/1 recipient with keys held elsewhere/);
  });

  it('is explicit that passphrase strength is not auditable', async () => {
    await keys(args({}, ['audit']));

    expect(logs.join('\n')).toMatch(/never recorded, and cannot be audited/);
  });
});
