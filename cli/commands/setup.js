import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CONFIG_FILENAMES, findConfig, loadConfig } from '../../core/config.js';
import { KIND_IDENTITY, resolveProvider } from '../../core/provider.js';
import { encodePublic, generateIdentity, keyIdOf, sealIdentity } from '../../core/crypto/identity.js';
import { IDENTITY_NAME } from '../../core/session.js';
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from '../../core/dotenv.js';
import { cyan, dim } from '../lib/format.js';
import { command, field, heading, note, outcome, warn } from '../lib/ui.js';
import { confirm, newPassphrase, requireInteractive } from '../lib/prompt.js';

const GITIGNORE_ENTRIES = ['.env', '.env.*', '!.env.example', '!.env.*.example', '.wilsoon-store/'];

async function ensureGitignore(dir) {
  const file = path.join(dir, '.gitignore');

  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  const missing = GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));

  if (!missing.length) return null;

  const block = ['', '# @wilsoon/env', ...missing, ''].join('\n');
  await writeFile(file, existing.endsWith('\n') || !existing ? existing + block.slice(1) : existing + block);

  return missing;
}

export async function setup(args) {
  const cwd = args.flags.cwd ?? process.cwd();
  const existing = await findConfig(cwd);

  if (existing && !args.flags.force) {
    warn(`This project already has a configuration at ${cyan(path.relative(cwd, existing.file) || existing.file)}.`);
    note(`Replace it by adding '--force', or run ${command('status')} to see what it points at.`);
    return 1;
  }

  // An existing config is a starting point, not something to discard: pointing at
  // your own bucket means writing options by hand before setup ever runs.
  const prior = existing ? (await loadConfig(cwd))?.config : null;

  const project = args.flags.project ?? prior?.project ?? path.basename(cwd);
  const providerName = args.flags.provider ?? prior?.provider ?? 'local';

  const options = { ...(prior?.options ?? {}) };
  for (const [flag, key] of [
    ['path', 'path'],
    ['bucket', 'bucket'],
    ['endpoint', 'endpoint'],
    ['region', 'region'],
    ['prefix', 'prefix'],
    ['profile', 'profile']
  ]) {
    if (typeof args.flags[flag] === 'string') options[key] = args.flags[flag];
  }

  heading(`Setting up ${cyan(project)}`);
  field('Provider', providerName);
  field('Directory', cwd);
  console.log('');

  const config = {
    $schema: 'https://wilsoon.dev/schema/env.config.v1.json',
    project,
    provider: providerName,
    options,
    include: prior?.include ?? DEFAULT_INCLUDE,
    exclude: prior?.exclude ?? DEFAULT_EXCLUDE,
    recipients: []
  };

  const provider = await resolveProvider(config, cwd);
  const storedIdentity = await provider.get({ project, kind: KIND_IDENTITY, name: IDENTITY_NAME }).catch(() => null);

  if (storedIdentity && !args.flags.yes) {
    console.log('');
    warn(`An identity key is already stored for ${cyan(project)}.`);
    note('Replacing it makes every secret already pushed permanently unreadable,');
    note('including for anyone else who pulls this project.');
    console.log('');

    if (!(await confirm('  Replace it?'))) {
      note('Nothing was changed.');
      return 1;
    }
  }

  note('Your passphrase protects the identity key that unlocks every secret in');
  note('this project. It is never sent anywhere, and it cannot be recovered.');
  console.log('');

  const passphrase = process.env.WILSOON_ENV_PASSPHRASE ?? (requireInteractive('Setting up a project'), await newPassphrase());

  const { publicRaw, privateRaw } = generateIdentity();
  const pubkey = encodePublic(publicRaw);

  config.recipients = [{ name: args.flags.name ?? 'me', keyid: keyIdOf(publicRaw).toString('hex'), pubkey }];

  const blob = await sealIdentity(privateRaw, passphrase);

  await provider.put({ project, kind: KIND_IDENTITY, name: IDENTITY_NAME }, blob);

  const configFile = path.join(cwd, CONFIG_FILENAMES[0]);
  await writeFile(configFile, JSON.stringify(config, null, 2) + '\n');

  const ignored = await ensureGitignore(cwd);

  outcome({
    ok: `Ready. Your public key is ${dim(pubkey)}`,
    next: [
      `Configuration written to ${path.basename(configFile)} - commit it, it holds no secrets`,
      ignored ? `Added ${ignored.length} entries to .gitignore` : 'Your .gitignore already covered .env files',
      `Run ${command('push')} to encrypt and store what you have now`,
      `Share the public key above to let a teammate add you as a recipient`
    ]
  });

  return 0;
}
