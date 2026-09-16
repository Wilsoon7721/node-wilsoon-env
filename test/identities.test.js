import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pull } from '../cli/commands/pull.js';
import { push } from '../cli/commands/push.js';
import { setup } from '../cli/commands/setup.js';
import { loadConfig } from '../core/config.js';
import { generateIdentity, sealIdentity } from '../core/crypto/identity.js';
import { IDENTITY_PROJECT, personalRef, readPersonal } from '../core/personal.js';
import { findIdentity, openSession } from '../core/session.js';
import { create as createLocal } from '../providers/local.js';

/*
  One identity per person, shared by every project they use. Each person here is
  a separate machine - a home directory of their own - because that is what two
  people are. Sharing one home would make them the same person.
*/

const ALICE = 'alice passphrase, long enough';
const BOB = 'bob passphrase, also long enough';

let dir;
let logs;
let homes;

const args = (flags = {}, positional = [], cwd = dir) => ({ flags: { cwd, ...flags }, positional, rest: [] });
const store = () => createLocal({}, { dir });
const identities = async () => (await store().list(IDENTITY_PROJECT)).filter((e) => e.kind === 'identity');

async function as(person, passphrase) {
  homes[person] ??= await mkdtemp(path.join(tmpdir(), `wenv-${person}-`));
  process.env.WILSOON_ENV_CREDENTIALS_DIR = homes[person];

  if (passphrase === undefined) delete process.env.WILSOON_ENV_PASSPHRASE;
  else process.env.WILSOON_ENV_PASSPHRASE = passphrase;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wenv-id-'));
  homes = {};
  process.env.WILSOON_ENV_STATE_DIR = dir;

  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));

  await writeFile(path.join(dir, '.env'), 'A=1\n');

  await as('alice', ALICE);
  await setup(args({ project: 'demo', name: 'alice' }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.WILSOON_ENV_PASSPHRASE;
  delete process.env.WILSOON_ENV_STATE_DIR;
  await rm(dir, { recursive: true, force: true });
  for (const home of Object.values(homes)) await rm(home, { recursive: true, force: true });
});

async function bobJoins() {
  await as('bob', BOB);
  await setup(args({ force: true, yes: true, name: 'bob' }));
}

describe('two people, one store', () => {
  it('stores one identity blob per person, outside any project', async () => {
    await bobJoins();

    const stored = await identities();
    expect(stored).toHaveLength(2);

    const keyids = (await loadConfig(dir)).config.recipients.map((r) => r.keyid).sort();
    expect(stored.map((e) => e.name).sort()).toEqual(keyids);

    expect((await store().list('demo')).filter((e) => e.kind === 'identity')).toHaveLength(0);
  });

  it('keeps the first person in the recipient list', async () => {
    await bobJoins();

    const names = (await loadConfig(dir)).config.recipients.map((r) => r.name).sort();
    expect(names).toEqual(['alice', 'bob']);
  });

  it('does not destroy the access of whoever set up first', async () => {
    await push(args({ yes: true }));

    await bobJoins();
    await push(args({ yes: true }));

    await rm(path.join(dir, '.env'));

    await as('alice', ALICE);
    expect(await pull(args({ force: true }))).toBe(0);
    expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe('A=1\n');
  });

  // Each machine knows whose identity it holds, so nobody needs --as on their own machine.
  it('lets each person unlock their own identity, with no flag', async () => {
    await bobJoins();
    await push(args({ yes: true }));
    await rm(path.join(dir, '.env'));

    await as('bob', BOB);
    expect(await pull(args({ force: true }))).toBe(0);
  });

  it('refuses the wrong passphrase for the named identity', async () => {
    await bobJoins();
    await push(args({ yes: true }));

    await as('bob', BOB);
    await expect(pull(args({ force: true, as: 'alice' }))).rejects.toThrow(/wrong passphrase|altered/i);
  });
});

describe('one identity, many projects', () => {
  let second;

  beforeEach(async () => {
    second = await mkdtemp(path.join(tmpdir(), 'wenv-second-'));
    await writeFile(path.join(second, '.env'), 'B=2\n');
  });

  afterEach(async () => await rm(second, { recursive: true, force: true }));

  it('lists the same key in a second project, and stores no new blob', async () => {
    await setup(args({ project: 'other', name: 'alice', unattended: true, path: path.join(dir, '.wilsoon-store') }, [], second));

    const first = (await loadConfig(dir)).config.recipients[0].keyid;
    const other = (await loadConfig(second)).config.recipients[0].keyid;

    expect(other).toBe(first);
    expect(await identities()).toHaveLength(1);
  });

  // Non-interactive with no passphrase set, so any prompt would throw "needs a terminal".
  it('asks for no passphrase in a second project', async () => {
    await as('alice');

    expect(await setup(args({ project: 'other', name: 'alice', unattended: true, path: path.join(dir, '.wilsoon-store') }, [], second))).toBe(0);
  });

  it('teaches a new machine whose identity it is on the first pull', async () => {
    await push(args({ yes: true }));
    await rm(path.join(dir, '.env'));

    await as('alice-laptop', ALICE);
    expect(await readPersonal()).toBe(null);
    expect(await pull(args({ force: true }))).toBe(0);

    const learned = await readPersonal();
    expect(learned.keyid).toBe((await loadConfig(dir)).config.recipients[0].keyid);

    // And from then on this machine sets up projects without asking.
    await as('alice-laptop');
    expect(await setup(args({ project: 'other', name: 'alice', unattended: true, path: path.join(dir, '.wilsoon-store') }, [], second))).toBe(0);
    expect((await loadConfig(second)).config.recipients[0].keyid).toBe(learned.keyid);
  });
});

describe('choosing an identity', () => {
  it('needs no flag when there is only one', async () => {
    const session = await openSession({ cwd: dir });
    expect((await findIdentity(session)).name).toBe('alice');
  });

  it("prefers this machine's own identity when several are recipients", async () => {
    await bobJoins();

    const session = await openSession({ cwd: dir });
    expect((await findIdentity(session)).name).toBe('bob');
  });

  it('asks which one on a machine that knows none of them, and names them', async () => {
    await bobJoins();
    await as('carol');

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

describe('a key for one project alone', () => {
  it('mints a separate key with --new-identity, and leaves the personal one where it was', async () => {
    const before = (await loadConfig(dir)).config.recipients[0].keyid;

    await setup(args({ force: true, yes: true, name: 'alice', 'new-identity': true }));

    const after = (await loadConfig(dir)).config.recipients[0].keyid;
    expect(after).not.toBe(before);

    // Other projects still use the personal identity, so its blob must survive.
    expect((await readPersonal()).keyid).toBe(before);
    expect((await identities()).map((e) => e.name).sort()).toEqual([before, after].sort());
  });
});

describe('a clash in the store', () => {
  let second;

  beforeEach(async () => {
    second = await mkdtemp(path.join(tmpdir(), 'wenv-clash-'));
    await writeFile(path.join(second, '.env'), 'B=2\n');
  });

  afterEach(async () => await rm(second, { recursive: true, force: true }));

  // Somebody else's key filed under your key id: vanishingly rare, and silently overwriting it would destroy their access.
  it('refuses to reuse your identity, and names the way out', async () => {
    const { keyid } = await readPersonal();
    const { privateRaw } = generateIdentity();
    await store().put(personalRef(keyid), await sealIdentity(privateRaw, ALICE));

    const other = { project: 'other', name: 'alice', unattended: true, path: path.join(dir, '.wilsoon-store') };

    expect(await setup(args(other, [], second))).toBe(1);
    expect(logs.join('\n')).toMatch(/different identity is already filed under your key id/);
    expect(logs.join('\n')).toMatch(/--new-identity/);

    expect(await setup(args({ ...other, force: true, 'new-identity': true }, [], second))).toBe(0);
  });
});
