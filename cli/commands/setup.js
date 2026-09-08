import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CONFIG_FILENAMES, findConfig, loadConfig, schemaRef } from '../../core/config.js';
import { KIND_IDENTITY, resolveProvider } from '../../core/provider.js';
import { encodePublic, generateIdentity, keyIdOf, sealIdentity } from '../../core/crypto/identity.js';
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from '../../core/dotenv.js';
import { S, cyan, dim, green } from '../lib/format.js';
import { command, field, heading, note, outcome, warn } from '../lib/ui.js';
import { confirm, isInteractive, newPassphrase, requireInteractive } from '../lib/prompt.js';
import { authFromFlags, withIssuer } from '../lib/authflags.js';
import { listStores, readStore } from '../lib/stores.js';
import { offerToSave, runWizard } from './wizard.js';
import { signIn } from './login.js';
import { readCredential } from '../../auth/tokens.js';

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

async function storeSettings(args, cwd, prior) {
  if (typeof args.flags.store === 'string') {
    const store = await readStore(args.flags.store);

    if (!store) {
      const names = (await listStores()).map((s) => s.name);
      throw new Error(`No saved store called "${args.flags.store}".\n\n  ${names.length ? `Saved stores: ${names.join(', ')}` : 'You have not saved any yet - run setup with no flags to make one.'}\n`);
    }

    return { ...store, asked: false };
  }

  if (typeof args.flags.provider === 'string' || prior || !isInteractive()) return null;

  return { ...(await runWizard({ cwd })), asked: true };
}

/*
  A store behind a login cannot be reached until this machine has signed in, and
  the sign-in needs nothing from the config we are about to write. So offer it
  here rather than failing with advice to run a command that would itself ask
  for the config that does not exist yet.
*/
async function ensureSignedIn(auth, options, args) {
  if (!auth || !isInteractive()) return;
  if (await readCredential(auth.issuer)) return;

  console.log('');
  note(`This store works out who you are through ${cyan(auth.issuer)}, and this machine has not signed in yet.`);

  if (!(await confirm('  Sign in now?'))) {
    note(`Do it later with ${command(`login --issuer ${auth.issuer}`)}, then run setup again.`);
    return;
  }

  await signIn(auth, args, { url: options.url, anonKey: options.anonKey });
}

/** Prove the store answers */
async function reachable(provider, project) {
  console.log('');

  try {
    await provider.list(project);
    note(`${green(S.ok)} Reached ${cyan(provider.describe?.() ?? provider.name)}`);

    return true;
  } catch (err) {
    console.log('');
    warn(`Could not reach the store: ${err.message}`);
    note('Nothing was written, and no key was generated. Fix the above and run setup again.');

    return false;
  }
}

export async function setup(args) {
  const cwd = args.flags.cwd ?? process.cwd();
  const existing = await findConfig(cwd);

  if (existing && !args.flags.force) {
    warn(`This project already has a configuration at ${cyan(path.relative(cwd, existing.file) || existing.file)}.`);
    note(`Replace it by adding '--force', or run ${command('status')} to see what it points at.`);
    return 1;
  }

  // Existing config?
  const prior = existing ? (await loadConfig(cwd))?.config : null;
  const chosen = await storeSettings(args, cwd, prior);
  const wizard = chosen?.asked ? chosen : null;

  const project = args.flags.project ?? chosen?.project ?? prior?.project ?? path.basename(cwd);
  const providerName = args.flags.provider ?? chosen?.provider ?? prior?.provider ?? 'local';

  const options = { ...(prior?.options ?? {}), ...(chosen?.options ?? {}) };
  for (const [flag, key] of [
    ['path', 'path'],
    ['bucket', 'bucket'],
    ['endpoint', 'endpoint'],
    ['region', 'region'],
    ['prefix', 'prefix'],
    ['profile', 'profile'],
    ['url', 'url'],
    ['anon-key', 'anonKey'],
    ['table', 'table'],
    ['schema', 'schema']
  ]) {
    if (typeof args.flags[flag] === 'string') options[key] = args.flags[flag];
  }

  const auth = withIssuer(authFromFlags(args.flags, chosen?.auth ?? prior?.auth ?? null), options.url ?? process.env.SUPABASE_URL);

  heading(`Setting up ${cyan(project)}`);
  field('Provider', providerName);
  field('Directory', cwd);
  console.log('');

  const config = {
    $schema: await schemaRef(cwd),
    project,
    provider: providerName,
    options,
    ...(auth ? { auth } : {}),
    ...(prior?.kdf ? { kdf: prior.kdf } : {}),
    include: prior?.include ?? DEFAULT_INCLUDE,
    exclude: prior?.exclude ?? DEFAULT_EXCLUDE,
    recipients: []
  };

  const provider = await resolveProvider(config, cwd);
  if (chosen) {
    await ensureSignedIn(auth, options, args);
    if (!(await reachable(provider, project))) return 1;
  }

  if (wizard && !wizard.saved) await offerToSave({ provider: providerName, options, auth });

  const me = args.flags.name ?? 'me';
  const previous = prior?.recipients?.find((r) => r.name === me);
  const storedIdentity = previous?.keyid ? await provider.get({ project, kind: KIND_IDENTITY, name: previous.keyid }).catch(() => null) : null;

  if (storedIdentity && !args.flags.yes) {
    console.log('');
    warn(`An identity key is already stored for ${cyan(me)} in ${cyan(project)}.`);
    note('Replacing it makes everything already sealed to that key unreadable by you,');
    note('until someone who can still read it pushes again.');
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
  const keyid = keyIdOf(publicRaw).toString('hex');
  config.recipients = [...(prior?.recipients ?? []).filter((r) => r.name !== me), { name: me, keyid, pubkey }];

  const blob = await sealIdentity(privateRaw, passphrase);

  await provider.put({ project, kind: KIND_IDENTITY, name: keyid }, blob);
  if (previous?.keyid && previous.keyid !== keyid) await provider.remove({ project, kind: KIND_IDENTITY, name: previous.keyid }).catch(() => {});

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
