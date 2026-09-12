import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logout } from '../cli/commands/logout.js';
import { pull } from '../cli/commands/pull.js';
import { push } from '../cli/commands/push.js';
import { setup } from '../cli/commands/setup.js';
import { loadConfig } from '../core/config.js';

/*
  Only the Windows backend runs here, because it is the only one this was
  developed against. macOS `security` and Linux `secret-tool` are written to
  their documented interfaces and are covered by the degradation tests below -
  which is a weaker claim, and deliberately stated as one.
*/
const onWindows = process.platform === 'win32';

const PASSPHRASE = 'a sufficiently long passphrase';

let dir;
let cacheDir;
let logs;

const args = (flags = {}, positional = []) => ({ flags: { cwd: dir, ...flags }, positional, rest: [] });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wenv-kc-'));
  cacheDir = await mkdtemp(path.join(tmpdir(), 'wenv-cache-'));

  process.env.WILSOON_ENV_PASSPHRASE = PASSPHRASE;
  process.env.WILSOON_ENV_STATE_DIR = dir;
  process.env.WILSOON_ENV_CACHE_DIR = cacheDir;
  delete process.env.WILSOON_ENV_NO_KEYCHAIN;

  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));

  await writeFile(path.join(dir, '.env'), 'A=1\n');
  await setup(args({ project: 'demo' }));
  await push(args({ yes: true }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env.WILSOON_ENV_NO_KEYCHAIN = '1';
  delete process.env.WILSOON_ENV_PASSPHRASE;
  delete process.env.WILSOON_ENV_STATE_DIR;
  delete process.env.WILSOON_ENV_CACHE_DIR;
  await rm(dir, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
});

describe.skipIf(!onWindows)('keychain, on this platform', () => {
  it('round-trips a key through the OS', async () => {
    const { accountFor, recall, remember, forget } = await import('../core/keychain.js');
    const secret = Buffer.from('ab'.repeat(32), 'hex');
    const account = accountFor('demo', 'keyid');

    expect(await remember(account, secret)).toBe(true);
    expect((await recall(account))?.equals(secret)).toBe(true);
    expect(await forget(account)).toBe(true);
    expect(await recall(account)).toBe(null);
  });

  it('does not leave the key readable on disk', async () => {
    const { accountFor, remember } = await import('../core/keychain.js');
    const secret = Buffer.from('deadbeef'.repeat(8), 'hex');

    await remember(accountFor('demo', 'k'), secret);

    const files = await readdir(cacheDir);
    const raw = await readFile(path.join(cacheDir, files[0]), 'utf8');

    expect(raw.toLowerCase()).not.toContain('deadbeef');
    expect(raw).not.toContain(secret.toString('base64'));
    // The filename must not name the project either.
    expect(files[0]).not.toContain('demo');
  });

  it('expires a cached key rather than holding it forever', async () => {
    const { accountFor, recall, remember } = await import('../core/keychain.js');
    const account = accountFor('demo', 'k');

    await remember(account, Buffer.alloc(32, 7), { days: -1 });

    expect(await recall(account)).toBe(null);
  });

  it('caches on the first unlock and skips the passphrase after', async () => {
    await rm(path.join(dir, '.env'));
    expect(await pull(args({ force: true }))).toBe(0);

    // No passphrase available at all - only the cache can satisfy this.
    delete process.env.WILSOON_ENV_PASSPHRASE;
    await rm(path.join(dir, '.env'));

    expect(await pull(args({ force: true }))).toBe(0);
    expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe('A=1\n');
  });

  it('does not use the cache when told not to', async () => {
    await rm(path.join(dir, '.env'));
    await pull(args({ force: true }));

    delete process.env.WILSOON_ENV_PASSPHRASE;

    await expect(pull(args({ force: true, 'no-cache': true }))).rejects.toThrow(/needs a terminal/);
  });

  it('ignores a cache left over from a replaced identity', async () => {
    await rm(path.join(dir, '.env'));
    await pull(args({ force: true }));

    const before = (await loadConfig(dir)).config.recipients[0].keyid;

    // A new identity at a new key id; the old cache entry must not be used.
    await setup(args({ force: true, yes: true }));
    await push(args({ yes: true }));

    const after = (await loadConfig(dir)).config.recipients[0].keyid;
    expect(after).not.toBe(before);

    await rm(path.join(dir, '.env'));
    expect(await pull(args({ force: true }))).toBe(0);
  });

  it('forgets on logout, and says nothing was destroyed', async () => {
    await rm(path.join(dir, '.env'));
    await pull(args({ force: true }));

    logs = [];
    expect(await logout(args())).toBe(0);
    expect(logs.join('\n')).toMatch(/forgotten/);
    expect(logs.join('\n')).toMatch(/secrets are untouched/);

    // The passphrase is required again.
    delete process.env.WILSOON_ENV_PASSPHRASE;
    await rm(path.join(dir, '.env'));
    await expect(pull(args({ force: true }))).rejects.toThrow(/needs a terminal/);
  });
});

describe('degradation', () => {
  it('works normally with no keychain at all', async () => {
    process.env.WILSOON_ENV_NO_KEYCHAIN = '1';

    const { describe: describeKeychain, recall, remember, forget, accountFor } = await import('../core/keychain.js');

    expect(describeKeychain()).toBe(null);

    // Never throws, never pretends to have worked.
    const account = accountFor('demo', 'k');
    expect(await remember(account, Buffer.alloc(32))).toBe(false);
    expect(await recall(account)).toBe(null);
    expect(await forget(account)).toBe(false);
  });

  it('still pulls when caching is unavailable', async () => {
    process.env.WILSOON_ENV_NO_KEYCHAIN = '1';

    await rm(path.join(dir, '.env'));
    expect(await pull(args({ force: true }))).toBe(0);
  });

  it('tells you plainly when logout has no keychain to clear', async () => {
    process.env.WILSOON_ENV_NO_KEYCHAIN = '1';

    logs = [];
    expect(await logout(args())).toBe(0);
    expect(logs.join('\n')).toMatch(/No keychain is available/);
  });
});
