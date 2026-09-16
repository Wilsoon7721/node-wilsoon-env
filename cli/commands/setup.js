import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CONFIG_FILENAMES, findConfig, loadConfig, schemaRef } from '../../core/config.js';
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from '../../core/dotenv.js';
import { IdentityClash } from '../../core/personal.js';
import { resolveProvider } from '../../core/provider.js';
import { authFromFlags, withIssuer } from '../lib/authflags.js';
import { projectRef, runSql, supabaseDdl } from '../lib/ddl.js';
import { cyan, dim, green, S } from '../lib/format.js';
import { identityFor } from '../lib/identity.js';
import { confirm, isInteractive } from '../lib/prompt.js';
import { ensureSignedIn } from '../lib/signin.js';
import { listStores, readStore } from '../lib/stores.js';
import { command, field, heading, note, outcome, warn } from '../lib/ui.js';
import { offerToSave, runWizard } from './wizard.js';

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

const UNATTENDED_ONLY = ['provider', 'path', 'bucket', 'endpoint', 'region', 'prefix', 'profile', 'url', 'anon-key', 'table', 'schema', 'account-id', 'namespace-id', 'db', 'collection', 'auth', 'issuer', 'client-id', 'scope'];

function assertUnattended(flags) {
  if (flags.unattended) return;

  const used = UNATTENDED_ONLY.filter((flag) => flags[flag] !== undefined).map((flag) => `--${flag}`);

  if (!used.length) return;

  throw new Error(
    `${used.join(', ')} ${
      used.length === 1 ? 'is' : 'are'
    } only accepted with --unattended.\n\n  Run setup with no flags and it will ask you what it needs.\n  Or add --unattended to what you just ran, to supply it yourself.\n\n  For everything --unattended accepts: npx @wilsoon/env setup --unattended --help\n`
  );
}

async function storeSettings(args, cwd, prior) {
  assertUnattended(args.flags);

  if (typeof args.flags.store === 'string') {
    const store = await readStore(args.flags.store);

    if (!store) {
      const names = (await listStores()).map((s) => s.name);
      throw new Error(`No saved store called "${args.flags.store}".\n\n  ${names.length ? `Saved stores: ${names.join(', ')}` : 'You have not saved any yet - run setup with no flags to make one.'}\n`);
    }

    return { ...store, asked: false };
  }

  if (args.flags.unattended || prior || !isInteractive()) return null;

  return { ...(await runWizard({ cwd })), asked: true };
}

async function offerTheTable(providerName, options) {
  if (providerName !== 'supabase') return;

  const sql = supabaseDdl({ table: options.table, schema: options.schema });
  const ref = projectRef(options.url ?? process.env.SUPABASE_URL);
  const token = process.env.SUPABASE_ACCESS_TOKEN;

  console.log('');
  note('A data API cannot create tables, so this part is SQL. Run it in the dashboard:');
  note(`Dashboard > SQL Editor${ref ? dim(`  (project ${ref})`) : ''}`);
  console.log('');
  for (const line of sql.split('\n')) console.log(`    ${dim(line)}`);
  console.log('');

  if (!ref || !token || !isInteractive()) return;

  note(`${cyan('SUPABASE_ACCESS_TOKEN')} is set, which can run it for you.`);

  if (!(await confirm('  Run it now?'))) return;

  await runSql(ref, token, sql);
  note(`${green(S.ok)} Table created. Run setup again.`);
}

/** Prove the store answers */
async function connect({ config, cwd, project, auth, options, args }) {
  const provider = await resolveProvider(config, cwd);

  await ensureSignedIn(config, args);

  console.log('');
  await provider.list(project);
  note(`${green(S.ok)} Reached ${cyan(provider.describe?.() ?? provider.name)}`);

  return provider;
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
  for (
    const [flag, key] of [
      ['path', 'path'],
      ['bucket', 'bucket'],
      ['endpoint', 'endpoint'],
      ['region', 'region'],
      ['prefix', 'prefix'],
      ['profile', 'profile'],
      ['url', 'url'],
      ['anon-key', 'anonKey'],
      ['table', 'table'],
      ['schema', 'schema'],
      ['account-id', 'accountId'],
      ['namespace-id', 'namespaceId'],
      ['db', 'db'],
      ['collection', 'collection']
    ]
  ) {
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

  let provider;

  try {
    provider = chosen ? await connect({ config, cwd, project, auth, options, args }) : await resolveProvider(config, cwd);
  } catch (err) {
    if (!chosen) throw err;

    console.log('');
    warn(`Could not reach the store: ${err.message}`);
    note('Nothing was written, and no key was generated.');

    if (err.missingTable) await offerTheTable(providerName, options);

    if (wizard && !wizard.saved) await offerToSave({ provider: providerName, options, auth }, {}, { question: '  Keep these answers, so the next run does not ask again?' });

    return 1;
  }

  if (wizard && !wizard.saved) await offerToSave({ provider: providerName, options, auth });

  const me = args.flags.name ?? 'me';

  let identity;

  try {
    identity = await identityFor(provider, { fresh: Boolean(args.flags['new-identity']), purpose: 'Setting up a project' });
  } catch (err) {
    if (!(err instanceof IdentityClash)) throw err;

    console.log('');
    warn(err.message);
    note('Two different keys sharing an id is vanishingly rare, but this store cannot hold yours under that name.');
    note(`Use a key for this project alone: ${command('setup --force --new-identity')}`);
    return 1;
  }

  // Your identity is shared with your other projects now, so nothing here is removed from the store
  const { keyid, pubkey } = identity;
  config.recipients = [...(prior?.recipients ?? []).filter((r) => r.name !== me && r.keyid !== keyid), { name: me, keyid, pubkey }];

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
