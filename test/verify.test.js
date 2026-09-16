import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { push } from '../cli/commands/push.js';
import { setup } from '../cli/commands/setup.js';
import { normalise, verifyRoundTrip } from '../cli/lib/verify.js';
import { keychainDays } from '../core/keychain.js';
import { openSession } from '../core/session.js';

let dir;
let logs;

const args = (flags = {}) => ({ flags: { cwd: dir, ...flags }, positional: [], rest: [] });
const SECRET = 'sk_live_do_not_print_me';

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wenv-verify-'));
  process.env.WILSOON_ENV_STATE_DIR = dir;
  process.env.WILSOON_ENV_PASSPHRASE = 'a sufficiently long passphrase';

  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));

  await writeFile(path.join(dir, '.env'), `API_KEY=${SECRET}\nDEBUG=true\n`);
  await setup(args({ project: 'demo' }));
  await push(args({ yes: true }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.WILSOON_ENV_PASSPHRASE;
  delete process.env.WILSOON_ENV_STATE_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('normalise', () => {
  it('ignores trailing newlines', () => expect(normalise('A=1\n\n\n')).toBe(normalise('A=1')));

  it('ignores Windows line endings', () => expect(normalise('A=1\r\nB=2\r\n')).toBe(normalise('A=1\nB=2\n')));

  // Trailing spaces can be part of a value, so they are not an editor's business.
  it('keeps trailing spaces on a value', () => expect(normalise('A=1   ')).not.toBe(normalise('A=1')));

  it('keeps a real change', () => expect(normalise('A=1\n')).not.toBe(normalise('A=2\n')));
});

describe('the round trip after a first push', () => {
  it('passes silently when what comes back is identical', async () => {
    expect(await verifyRoundTrip(await openSession({ cwd: dir }), ['.env'], args())).toBe(true);
    expect(logs.join('\n')).toMatch(/Round trip checked/);
  });

  it('does not ask about a trailing newline an editor added', async () => {
    await writeFile(path.join(dir, '.env'), `API_KEY=${SECRET}\r\nDEBUG=true\r\n\r\n`);

    expect(await verifyRoundTrip(await openSession({ cwd: dir }), ['.env'], args())).toBe(true);
  });

  // Non-interactive, so "Does that look right?" falls back to no.
  it('stops on a meaningful difference, naming keys but never values', async () => {
    await writeFile(path.join(dir, '.env'), `API_KEY=${SECRET}\nDEBUG=false\nEXTRA=1\n`);

    expect(await verifyRoundTrip(await openSession({ cwd: dir }), ['.env'], args())).toBe(false);

    const said = logs.join('\n');
    expect(said).toMatch(/not what is on disk/);
    expect(said).toMatch(/DEBUG/);
    expect(said).not.toContain(SECRET);
  });

  it('never writes a decrypted copy into the project', async () => {
    const before = (await readdir(dir)).sort();
    await verifyRoundTrip(await openSession({ cwd: dir }), ['.env'], args());

    expect((await readdir(dir)).sort()).toEqual(before);
  });
});

describe('how long an unlocked key stays cached', () => {
  it('defaults to fourteen days', () => {
    vi.stubEnv('WILSOON_ENV_KEYCHAIN_DAYS', '');
    expect(keychainDays()).toBe(14);
  });

  it('takes a number of days', () => {
    vi.stubEnv('WILSOON_ENV_KEYCHAIN_DAYS', '90');
    expect(keychainDays()).toBe(90);
  });

  it('can be told never to expire', () => {
    vi.stubEnv('WILSOON_ENV_KEYCHAIN_DAYS', 'never');
    expect(keychainDays()).toBe(Infinity);
  });

  it('falls back to the default for nonsense rather than caching forever', () => {
    vi.stubEnv('WILSOON_ENV_KEYCHAIN_DAYS', '-3');
    expect(keychainDays()).toBe(14);
  });
});
