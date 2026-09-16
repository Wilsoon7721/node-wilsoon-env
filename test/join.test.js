import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { join } from '../cli/commands/join.js';
import { pull } from '../cli/commands/pull.js';
import { push } from '../cli/commands/push.js';
import { setup } from '../cli/commands/setup.js';
import { loadConfig } from '../core/config.js';
import { encodePublic, generateIdentity } from '../core/crypto/identity.js';
import { IDENTITY_PROJECT, readPersonal } from '../core/personal.js';
import { create as createLocal } from '../providers/local.js';

const ALICE = 'alice passphrase, long enough';
const BOB = 'bob passphrase, also long enough';

let dir;
let logs;
let homes;

const args = (flags = {}, positional = []) => ({ flags: { cwd: dir, ...flags }, positional, rest: [] });
const identities = async () => (await createLocal({}, { dir }).list(IDENTITY_PROJECT)).filter((e) => e.kind === 'identity');

// A separate home is a separate machine, which is what a separate person is.
async function as(person, passphrase) {
  homes[person] ??= await mkdtemp(path.join(tmpdir(), `wenv-${person}-`));
  process.env.WILSOON_ENV_CREDENTIALS_DIR = homes[person];
  process.env.WILSOON_ENV_PASSPHRASE = passphrase;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wenv-join-'));
  homes = {};
  process.env.WILSOON_ENV_STATE_DIR = dir;

  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));

  await writeFile(path.join(dir, '.env'), 'A=1\n');

  await as('alice', ALICE);
  await setup(args({ project: 'demo', name: 'alice' }));
  await push(args({ yes: true }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.WILSOON_ENV_PASSPHRASE;
  delete process.env.WILSOON_ENV_STATE_DIR;
  await rm(dir, { recursive: true, force: true });
  for (const home of Object.values(homes)) await rm(home, { recursive: true, force: true });
});

async function bobJoins(flags = {}) {
  await as('bob', BOB);
  return await join(args({ name: 'bob', ...flags }));
}

describe('join', () => {
  it('refuses where there is no project', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'wenv-empty-'));

    try {
      expect(await join({ flags: { cwd: empty }, positional: [], rest: [] })).toBe(1);
      expect(logs.join('\n')).toMatch(/no project here to join/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('adds a second identity without disturbing the first', async () => {
    expect(await bobJoins()).toBe(0);

    const { config } = await loadConfig(dir);
    expect(config.recipients.map((r) => r.name)).toEqual(['alice', 'bob']);
    expect(await identities()).toHaveLength(2);
  });

  it('leaves the provider and its options exactly as they were', async () => {
    const before = (await loadConfig(dir)).config;
    await bobJoins();
    const after = (await loadConfig(dir)).config;

    expect(after.provider).toBe(before.provider);
    expect(after.options).toEqual(before.options);
    expect(after.project).toBe(before.project);
  });

  it('says plainly that joining grants no access yet', async () => {
    await bobJoins();

    expect(logs.join('\n')).toMatch(/cannot read anything yet/);
    expect(logs.join('\n')).toMatch(/ask someone with access to pull and run/);
  });

  it('really cannot read until someone with access pushes', async () => {
    await bobJoins();
    await rm(path.join(dir, '.env'));

    // Sealed before bob existed, so there is no slot for him.
    await as('bob', BOB);
    await expect(pull(args({ force: true }))).rejects.toThrow(/no usable recipient slot/);

    // Alice pushes, which re-seals to both.
    await as('alice', ALICE);
    await pull(args({ force: true }));
    await push(args({ yes: true }));
    await rm(path.join(dir, '.env'));

    await as('bob', BOB);
    expect(await pull(args({ force: true }))).toBe(0);
    expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe('A=1\n');
  });

  it('refuses a name already taken, and points at the alternatives', async () => {
    await as('bob', BOB);

    expect(await join(args({ name: 'alice' }))).toBe(1);
    expect(logs.join('\n')).toMatch(/already lists a recipient called/);
    expect(logs.join('\n')).toMatch(/--name/);
  });

  it('can join scoped to particular files', async () => {
    await bobJoins({ files: '.env.production,.env' });

    const bob = (await loadConfig(dir)).config.recipients.find((r) => r.name === 'bob');
    expect(bob.files).toEqual(['.env.production', '.env']);
  });

  it('carries an auth block through untouched', async () => {
    const loaded = await loadConfig(dir);
    await writeFile(loaded.file, JSON.stringify({ ...loaded.config, auth: { type: 'oidc', issuer: 'https://id.example.test' } }, null, 2));

    await bobJoins();

    expect((await loadConfig(dir)).config.auth).toEqual({ type: 'oidc', issuer: 'https://id.example.test' });
  });

  it('does not rewrite a package.json config, and prints what to add', async () => {
    const nested = await mkdtemp(path.join(tmpdir(), 'wenv-pkg-'));

    try {
      const { config } = await loadConfig(dir);
      await writeFile(path.join(nested, 'package.json'), JSON.stringify({ name: 'x', 'wilsoon-env': { ...config, options: { path: path.join(dir, '.wilsoon-store') } } }));

      await as('bob', BOB);
      logs = [];

      expect(await join({ flags: { cwd: nested, name: 'bob' }, positional: [], rest: [] })).toBe(1);
      expect(logs.join('\n')).toMatch(/does not rewrite/);
      expect(logs.join('\n')).toMatch(/wenv1/);
    } finally {
      await rm(nested, { recursive: true, force: true });
    }
  });
});

describe('join, when identities meet', () => {
  it('says you are already here when this identity is a recipient, and changes nothing', async () => {
    const before = await readFile((await loadConfig(dir)).file, 'utf8');

    expect(await join(args({ name: 'alice-again' }))).toBe(0);
    expect(logs.join('\n')).toMatch(/already a recipient of demo, as alice/);
    expect(await readFile((await loadConfig(dir)).file, 'utf8')).toBe(before);
  });

  it('names the way out in case that recipient is somebody else with an identical key', async () => {
    await join(args({ name: 'alice-again' }));
    expect(logs.join('\n')).toMatch(/join --new-identity/);
  });

  // Same key id, different public key: two keys whose ids collide. They cannot both be recipients.
  it('refuses a different key under your key id, and offers a fresh identity', async () => {
    const { keyid } = await readPersonal();
    const loaded = await loadConfig(dir);
    const impostor = { name: 'someone', keyid, pubkey: encodePublic(generateIdentity().publicRaw) };
    await writeFile(loaded.file, JSON.stringify({ ...loaded.config, recipients: [impostor] }, null, 2));

    expect(await join(args({ name: 'alice' }))).toBe(1);
    expect(logs.join('\n')).toMatch(/different key under your key id/);
    expect(logs.join('\n')).toMatch(/--new-identity/);

    expect(await join(args({ name: 'alice', 'new-identity': true }))).toBe(0);
    expect((await loadConfig(dir)).config.recipients.map((r) => r.name)).toEqual(['someone', 'alice']);
  });
});
