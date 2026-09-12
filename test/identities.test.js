import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pull } from '../cli/commands/pull.js';
import { push } from '../cli/commands/push.js';
import { setup } from '../cli/commands/setup.js';
import { loadConfig } from '../core/config.js';
import { findIdentity, openSession } from '../core/session.js';
import { create as createLocal } from '../providers/local.js';

/*
  Identity blobs used to live at the single name "default", so the second person
  to run setup against a shared store silently destroyed the first person's key
  and wiped them out of the recipient list. These tests pin the addressing that
  fixed it.
*/

const ALICE = 'alice passphrase, long enough';
const BOB = 'bob passphrase, also long enough';

let dir;
let logs;

const args = (flags = {}, positional = []) => ({ flags: { cwd: dir, ...flags }, positional, rest: [] });
const store = () => createLocal({}, { dir });
const identities = async () => (await store().list('demo')).filter((e) => e.kind === 'identity');

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wenv-id-'));
  process.env.WILSOON_ENV_STATE_DIR = dir;

  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));

  await writeFile(path.join(dir, '.env'), 'A=1\n');

  process.env.WILSOON_ENV_PASSPHRASE = ALICE;
  await setup(args({ project: 'demo', name: 'alice' }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.WILSOON_ENV_PASSPHRASE;
  delete process.env.WILSOON_ENV_STATE_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function bobJoins() {
  process.env.WILSOON_ENV_PASSPHRASE = BOB;
  await setup(args({ force: true, yes: true, name: 'bob' }));
}

describe('two people, one store', () => {
  it('stores a separate identity blob per person', async () => {
    await bobJoins();

    const stored = await identities();
    expect(stored).toHaveLength(2);

    // Named by key id, so they cannot collide.
    const keyids = (await loadConfig(dir)).config.recipients.map((r) => r.keyid).sort();
    expect(stored.map((e) => e.name).sort()).toEqual(keyids);
  });

  it('keeps the first person in the recipient list', async () => {
    await bobJoins();

    const names = (await loadConfig(dir)).config.recipients.map((r) => r.name).sort();
    expect(names).toEqual(['alice', 'bob']);
  });

  it('does not destroy the access of whoever set up first', async () => {
    process.env.WILSOON_ENV_PASSPHRASE = ALICE;
    await push(args({ yes: true }));

    await bobJoins();
    await push(args({ yes: true }));

    await rm(path.join(dir, '.env'));

    // Alice can still read, with her own passphrase.
    process.env.WILSOON_ENV_PASSPHRASE = ALICE;
    expect(await pull(args({ force: true, as: 'alice' }))).toBe(0);
    expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe('A=1\n');
  });

  it('lets each person unlock with their own passphrase', async () => {
    await bobJoins();
    await push(args({ yes: true }));
    await rm(path.join(dir, '.env'));

    process.env.WILSOON_ENV_PASSPHRASE = BOB;
    expect(await pull(args({ force: true, as: 'bob' }))).toBe(0);
  });

  it('refuses the wrong passphrase for the named identity', async () => {
    await bobJoins();
    await push(args({ yes: true }));

    process.env.WILSOON_ENV_PASSPHRASE = BOB;
    await expect(pull(args({ force: true, as: 'alice' }))).rejects.toThrow(/wrong passphrase|altered/i);
  });
});

describe('choosing an identity', () => {
  it('needs no flag when there is only one', async () => {
    const session = await openSession({ cwd: dir });
    const chosen = await findIdentity(session);

    expect(chosen.name).toBe('alice');
  });

  it('asks which one when several are stored, and names them', async () => {
    await bobJoins();

    const session = await openSession({ cwd: dir });
    await expect(findIdentity(session)).rejects.toThrow(/Choose one with --as.*alice.*bob/s);
  });

  it('accepts a name or a key id', async () => {
    await bobJoins();

    const session = await openSession({ cwd: dir });
    const alice = (await loadConfig(dir)).config.recipients.find((r) => r.name === 'alice');

    expect((await findIdentity(session, { as: 'alice' })).keyid).toBe(alice.keyid);
    expect((await findIdentity(session, { as: alice.keyid })).name).toBe('alice');
  });

  it('says so when the name is not a recipient at all', async () => {
    const session = await openSession({ cwd: dir });
    await expect(findIdentity(session, { as: 'nobody' })).rejects.toThrow(/No recipient called "nobody"/);
  });

  it('distinguishes a recipient whose key lives elsewhere', async () => {
    // A CI key is a recipient with no stored identity blob - that is normal.
    const loaded = await loadConfig(dir);
    await writeFile(loaded.file, JSON.stringify({ ...loaded.config, recipients: [...loaded.config.recipients, { name: 'ci', keyid: 'ffffffffffffffff', pubkey: loaded.config.recipients[0].pubkey }] }, null, 2));

    const session = await openSession({ cwd: dir });
    await expect(findIdentity(session, { as: 'ci' })).rejects.toThrow(/No identity key is stored for "ci"/);
  });
});

describe('replacing your own identity', () => {
  it('leaves no orphaned blob behind', async () => {
    const before = (await loadConfig(dir)).config.recipients[0].keyid;

    await setup(args({ force: true, yes: true, name: 'alice' }));

    const after = (await loadConfig(dir)).config.recipients[0].keyid;
    expect(after).not.toBe(before);

    const stored = await identities();
    expect(stored.map((e) => e.name)).toEqual([after]);
  });
});
