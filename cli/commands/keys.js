import { writeFile } from 'node:fs/promises';

import { openSession } from '../../core/session.js';
import { schemaRef } from '../../core/config.js';
import { KIND_IDENTITY } from '../../core/provider.js';
import { DEFAULT_KDF } from '../../core/crypto/kdf.js';
import { unpackIdentityHeader } from '../../core/crypto/header.js';
import { decodePublic, encodePrivate, encodePublic, generateIdentity, keyIdOf } from '../../core/crypto/identity.js';
import { bold, cyan, dim, green, plural, red, yellow } from '../lib/format.js';
import { command, field, heading, note, ok, outcome, warn } from '../lib/ui.js';

async function writeConfig(session, recipients) {
  if (session.source === 'package.json') {
    warn('Your configuration lives in package.json, which this command does not rewrite.');
    note('Add the recipient there by hand:');
    console.log('');
    console.log(dim(JSON.stringify({ recipients }, null, 2)));
    return false;
  }

  const { config } = session;
  const out = {
    $schema: await schemaRef(session.dir),
    project: config.project,
    provider: config.provider,
    options: config.options,
    ...(config.auth ? { auth: config.auth } : {}),
    ...(config.kdf ? { kdf: config.kdf } : {}),
    include: config.include,
    exclude: config.exclude,
    recipients
  };

  await writeFile(session.file, JSON.stringify(out, null, 2) + '\n');
  return true;
}

function list(session) {
  const { recipients } = session.config;

  heading(`${plural(recipients.length, 'recipient')} for ${cyan(session.project)}`);

  for (const r of recipients) {
    field(r.name ?? 'unnamed', `${dim(r.keyid ?? keyIdOf(decodePublic(r.pubkey)).toString('hex'))}  ${r.files?.length ? yellow(r.files.join(', ')) : dim('all files')}`, 14);
  }

  console.log('');
  note(`Recipients live in your committed config, so granting access is a reviewable change.`);
  console.log('');

  return 0;
}

async function add(session, args) {
  const pubkey = args.flags.pubkey ?? args.positional[1];
  const name = args.flags.name;

  if (!pubkey) {
    warn('Give the public key to add.');
    note(`${command('keys add --name bob --pubkey wenv1...')}`);
    return 1;
  }

  const publicRaw = decodePublic(pubkey);
  const keyid = keyIdOf(publicRaw).toString('hex');

  if (session.config.recipients.some((r) => r.keyid === keyid || r.pubkey === pubkey)) {
    warn('That key is already a recipient.');
    return 1;
  }

  const files = args.flags.files
    ? String(args.flags.files)
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
    : undefined;

  const recipients = [...session.config.recipients, { name: name ?? 'unnamed', keyid, pubkey: encodePublic(publicRaw), ...(files ? { files } : {}) }];

  if (!(await writeConfig(session, recipients))) return 1;

  outcome({
    ok: `Added ${green(name ?? keyid)}${files ? ` for ${files.join(', ')}` : ''}`,
    next: ['They cannot read anything yet - the stored files were sealed without them', `Run ${command('push')} to re-seal and grant access`, 'Commit the config change so the grant is reviewable']
  });

  return 0;
}

async function issue(session, args) {
  const name = args.flags.name;

  if (!name) {
    warn('Give the new key a name.');
    note(`${command('keys new --name ci --files .env.production')}`);
    return 1;
  }

  const files = args.flags.files
    ? String(args.flags.files)
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
    : undefined;

  if (!files) {
    warn('This key will be able to open every file in the project.');
    note(`Scope it with --files, for example ${cyan('--files .env.production')}`);
    console.log('');
  }

  const { publicRaw, privateRaw } = generateIdentity();
  const keyid = keyIdOf(publicRaw).toString('hex');

  const recipients = [...session.config.recipients, { name, keyid, pubkey: encodePublic(publicRaw), ...(files ? { files } : {}) }];

  if (!(await writeConfig(session, recipients))) return 1;

  heading(`Private key for ${bold(name)}`);
  console.log(`  ${red(encodePrivate(privateRaw))}`);
  console.log('');
  note('This is shown once and is not saved anywhere. Copy it now.');
  console.log('');

  outcome({
    ok: `Added ${green(name)} as a recipient${files ? ` for ${files.join(', ')}` : ''}`,
    next: [
      `Set it in CI as WILSOON_ENV_KEY, then run ${command('pull')} or ${command('run -- ...')} there`,
      `Run ${command('push')} to seal the existing files to it`,
      files ? `It can only open ${files.join(', ')}` : 'It can open every file - consider --files to narrow that'
    ]
  });

  return 0;
}

async function remove(session, args) {
  const name = args.flags.name ?? args.positional[1];

  if (!name) {
    warn('Give the name or key id to remove.');
    return 1;
  }

  const recipients = session.config.recipients.filter((r) => r.name !== name && r.keyid !== name);

  if (recipients.length === session.config.recipients.length) {
    warn(`No recipient called ${cyan(name)}.`);
    return 1;
  }

  if (!recipients.length) {
    warn('That is the only recipient. Removing it would make the project unreadable by anyone.');
    return 1;
  }

  if (!(await writeConfig(session, recipients))) return 1;

  outcome({
    ok: `Removed ${name}`,
    next: ['They keep whatever they already pulled - removal is not retroactive', `Run ${command('push')} so future versions exclude them`, 'Rotate the secrets themselves if they should lose access to the current values']
  });

  return 0;
}

/**
 * Report the KDF cost each stored identity was sealed at.
 */
async function audit(session) {
  const policy = { ...DEFAULT_KDF, ...(session.config.kdf ?? {}) };

  const identities = (await session.provider.list(session.project)).filter((e) => e.kind === KIND_IDENTITY);

  heading(`Identity keys for ${cyan(session.project)}`);

  if (!identities.length) {
    warn('No identity key is stored for this project.');
    return 1;
  }

  let weak = 0;

  for (const entry of identities) {
    const fetched = await session.provider.get({ project: session.project, kind: KIND_IDENTITY, name: entry.name });
    const params = unpackIdentityHeader(fetched.blob);

    const memory = 2 ** params.log2m / 1024;
    const below = params.log2m < policy.log2m || params.t < policy.t;

    if (below) weak++;

    const who = session.config.recipients.find((r) => r.keyid === entry.name)?.name ?? entry.name;
    console.log(`  ${below ? red('!') : green('ok')} ${who.padEnd(14)} ${dim(`argon2id  ${memory} MiB  t=${params.t}  p=${params.p}`)}`);

    if (below) note(`     below policy (${2 ** policy.log2m / 1024} MiB, t=${policy.t}) - re-run setup to secure at the current cost`);
  }

  const elsewhere = session.config.recipients.length - identities.length;

  if (elsewhere > 0) {
    console.log('');
    note(`${plural(elsewhere, 'recipient')} with keys held elsewhere - their cost is not visible from here.`);
  }

  console.log('');
  note('Passphrase strength itself is never recorded, and cannot be audited by anyone.');
  console.log('');

  return weak ? 1 : 0;
}

export async function keys(args) {
  const session = await openSession({ cwd: args.flags.cwd ?? process.cwd() });
  const sub = args.positional[0] ?? 'list';

  if (sub === 'list') return list(session);
  if (sub === 'add') return await add(session, args);
  if (sub === 'new') return await issue(session, args);
  if (sub === 'audit') return await audit(session);
  if (sub === 'remove' || sub === 'rm') return await remove(session, args);

  warn(`Unknown keys command "${sub}".`);
  note('Try: list, add, new, audit, remove');
  return 1;
}
