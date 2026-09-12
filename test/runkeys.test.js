import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { keys } from '../cli/commands/keys.js';
import { pull } from '../cli/commands/pull.js';
import { push } from '../cli/commands/push.js';
import { run } from '../cli/commands/run.js';
import { setup } from '../cli/commands/setup.js';
import { loadConfig } from '../core/config.js';
import { open, recipientsOf } from '../core/crypto/envelope.js';
import { decodePrivate, encodePublic, generateIdentity } from '../core/crypto/identity.js';
import { create as createLocal } from '../providers/local.js';

const PASSPHRASE = 'a sufficiently long passphrase';
const PROD = 'DATABASE_URL=postgres://prod/db\nSTRIPE_SECRET_KEY=sk_live_xyz\n';
const LOCAL = 'DEBUG=true\nLOCAL_ONLY=yes\n';

let dir;
let logs;

const args = (flags = {}, positional = [], rest = []) => ({ flags: { cwd: dir, ...flags }, positional, rest });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wenv-rk-'));

  process.env.WILSOON_ENV_PASSPHRASE = PASSPHRASE;
  process.env.WILSOON_ENV_STATE_DIR = dir;
  delete process.env.WILSOON_ENV_KEY;

  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));

  await writeFile(path.join(dir, '.env.production'), PROD);
  await writeFile(path.join(dir, '.env.local'), LOCAL);
  await setup(args({ project: 'demo' }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.WILSOON_ENV_PASSPHRASE;
  delete process.env.WILSOON_ENV_STATE_DIR;
  delete process.env.WILSOON_ENV_KEY;
  await rm(dir, { recursive: true, force: true });
});

const store = () => createLocal({}, { dir });
const stored = (name) => store().get({ project: 'demo', kind: 'env', name });

describe('keys', () => {
  it('lists the recipient created by setup', async () => {
    expect(await keys(args({}, ['list']))).toBe(0);
    expect(logs.join('\n')).toMatch(/1 recipient for/);
    expect(logs.join('\n')).toMatch(/all files/);
  });

  it('adds a recipient without granting access until the next push', async () => {
    await push(args({ yes: true }));
    const bob = generateIdentity();

    expect(await keys(args({ name: 'bob', pubkey: encodePublic(bob.publicRaw) }, ['add']))).toBe(0);

    // Config changed, but the stored blob was sealed before that.
    expect((await loadConfig(dir)).config.recipients).toHaveLength(2);

    const blob = (await stored('.env.production')).blob;
    expect(() => open({ blob, privateRaw: bob.privateRaw, project: 'demo', name: '.env.production' })).toThrow();
  });

  it('refuses a malformed public key', async () => await expect(keys(args({ name: 'bob', pubkey: 'wenv1notarealkey' }, ['add']))).rejects.toThrow(/checksum|length/i));

  it('refuses to add the same key twice', async () => {
    const existing = (await loadConfig(dir)).config.recipients[0].pubkey;
    expect(await keys(args({ name: 'again', pubkey: existing }, ['add']))).toBe(1);
  });

  it('refuses to remove the last recipient', async () => {
    expect(await keys(args({ name: 'me' }, ['remove']))).toBe(1);
    expect(logs.join('\n')).toMatch(/unreadable by anyone/);
  });

  it('issues a scoped CI key and prints the private half once', async () => {
    expect(await keys(args({ name: 'ci', files: '.env.production' }, ['new']))).toBe(0);

    const printed = logs.join('\n').match(/wenvsk1[a-z2-7]+/)?.[0];
    expect(printed).toBeTruthy();
    expect(decodePrivate(printed)).toHaveLength(32);

    const recipients = (await loadConfig(dir)).config.recipients;
    expect(recipients).toHaveLength(2);
    expect(recipients[1]).toMatchObject({ name: 'ci', files: ['.env.production'] });

    // Never persisted anywhere.
    expect(await readFile((await loadConfig(dir)).file, 'utf8')).not.toContain(printed);
  });
});

describe('scoped recipients', () => {
  async function withCi() {
    await keys(args({ name: 'ci', files: '.env.production' }, ['new']));
    const ciKey = logs.join('\n').match(/wenvsk1[a-z2-7]+/)[0];
    await push(args({ yes: true }));
    return ciKey;
  }

  it('gives the scoped key a slot only on the files it covers', async () => {
    await withCi();

    expect(recipientsOf((await stored('.env.production')).blob)).toHaveLength(2);
    expect(recipientsOf((await stored('.env.local')).blob)).toHaveLength(1);
  });

  it('lets the CI key open its file and not the others', async () => {
    const ciKey = await withCi();
    const ciPrivate = decodePrivate(ciKey);

    const prodBlob = (await stored('.env.production')).blob;
    const localBlob = (await stored('.env.local')).blob;

    expect(open({ blob: prodBlob, privateRaw: ciPrivate, project: 'demo', name: '.env.production' }).plaintext.toString()).toBe(PROD);
    expect(() => open({ blob: localBlob, privateRaw: ciPrivate, project: 'demo', name: '.env.local' })).toThrow(/no usable recipient slot/);
  });

  it('pulls in CI with WILSOON_ENV_KEY and no passphrase at all', async () => {
    const ciKey = await withCi();

    await rm(path.join(dir, '.env.production'));
    delete process.env.WILSOON_ENV_PASSPHRASE;
    process.env.WILSOON_ENV_KEY = ciKey;

    expect(await pull(args({ force: true }, ['.env.production']))).toBe(0);
    expect(await readFile(path.join(dir, '.env.production'), 'utf8')).toBe(PROD);
  });

  it('skips a file no recipient covers rather than sealing it to nobody', async () => {
    const config = await loadConfig(dir);
    await writeFile(config.file, JSON.stringify({ ...config.config, recipients: [{ ...config.config.recipients[0], files: ['.env.production'] }] }, null, 2));

    logs = [];
    await push(args({ yes: true }));

    expect(logs.join('\n')).toMatch(/no recipient covers this file/);
    expect(await stored('.env.local')).toBe(null);
    expect(await stored('.env.production')).toBeTruthy();
  });
});

describe('run', () => {
  beforeEach(async () => {
    await writeFile(path.join(dir, '.env'), 'GREETING=hello\nSHARED=base\n');
    await push(args({ yes: true }));
  });

  it('needs a command', async () => {
    expect(await run(args())).toBe(1);
    expect(logs.join('\n')).toMatch(/double dash/);
  });

  it('injects variables into the child process', async () => {
    const code = await run(args({ quiet: true }, [], [process.execPath, '-e', 'process.exit(process.env.GREETING === "hello" ? 0 : 9)']));

    expect(code).toBe(0);
  });

  it('never writes plaintext to disk', async () => {
    await rm(path.join(dir, '.env'));
    await run(args({ quiet: true }, [], [process.execPath, '-e', '0']));

    await expect(readFile(path.join(dir, '.env'), 'utf8')).rejects.toThrow();
  });

  it('propagates the child exit code', async () => expect(await run(args({ quiet: true }, [], [process.execPath, '-e', 'process.exit(3)']))).toBe(3));

  it('merges several files, with later ones winning', async () => {
    await writeFile(path.join(dir, '.env.production'), 'SHARED=override\n');
    await push(args({ yes: true, force: true }));

    const code = await run(args({ quiet: true, file: '.env,.env.production' }, [], [process.execPath, '-e', 'process.exit(process.env.SHARED === "override" ? 0 : 9)']));

    expect(code).toBe(0);
  });

  it('reports a file that is not in the store', async () => {
    expect(await run(args({ file: '.env.nope' }, [], ['node', '-e', '0']))).toBe(1);
    expect(logs.join('\n')).toMatch(/not in the store/);
  });

  it('reports a command that does not exist', async () => {
    const code = await run(args({ quiet: true }, [], ['definitely-not-a-real-binary-xyz']));

    expect(code).toBe(1);
  });
});
