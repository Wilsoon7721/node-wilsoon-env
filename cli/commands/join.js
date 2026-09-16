import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig, schemaRef } from '../../core/config.js';
import { IdentityClash, readPersonal } from '../../core/personal.js';
import { openSession } from '../../core/session.js';
import { cyan, dim } from '../lib/format.js';
import { identityFor } from '../lib/identity.js';
import { ensureSignedIn } from '../lib/signin.js';
import { command, field, heading, note, outcome, warn } from '../lib/ui.js';

/** Add your own key to a project someone else set up. */
export async function join(args) {
  const cwd = args.flags.cwd ?? process.cwd();
  const loaded = await loadConfig(cwd);

  if (!loaded) {
    warn('There is no project here to join.');
    note(`Run ${command('setup')} to create one, or move to a directory that has a configuration.`);
    return 1;
  }

  const { config } = loaded;
  const me = args.flags.name ?? 'me';
  const fresh = Boolean(args.flags['new-identity']);
  const personal = fresh ? null : await readPersonal();

  const sameId = personal && config.recipients.find((r) => r.keyid === personal.keyid);

  if (sameId && sameId.pubkey === personal.pubkey) {
    outcome({
      ok: `You are already a recipient of ${config.project}, as ${cyan(sameId.name ?? sameId.keyid)}`,
      next: [`Run ${command('pull')} once someone with access has pushed`, `If that recipient is somebody else holding an identical key, join with ${command('join --new-identity')}`]
    });

    return 0;
  }

  if (sameId) {
    warn(`${config.project} already lists a different key under your key id (${personal.keyid}).`);
    note('Two different keys sharing an id is vanishingly rare, but they cannot both be recipients.');
    note(`Join with a key for this project alone: ${command('join --new-identity')}`);
    return 1;
  }

  if (config.recipients.some((r) => r.name === me)) {
    warn(`This project already lists a recipient called ${cyan(me)}.`);
    note(`Pick a different name with --name, or run ${command('setup --force')} if that recipient is you.`);
    return 1;
  }

  const session = await openSession({ cwd });
  await ensureSignedIn(session.config, args);

  heading(`Joining ${cyan(config.project)}`);
  field('Provider', `${config.provider} ${dim(session.provider.describe?.() ?? '')}`);
  field('Joining as', me);
  field('Existing', config.recipients.map((r) => r.name ?? r.keyid).join(', ') || dim('nobody'));
  console.log('');

  let identity;

  try {
    identity = await identityFor(session.provider, { fresh, purpose: 'Joining a project' });
  } catch (err) {
    if (!(err instanceof IdentityClash)) throw err;

    warn(err.message);
    note('Two different keys sharing an id is vanishingly rare, but this store cannot hold yours under that name.');
    note(`Join with a key for this project alone: ${command('join --new-identity')}`);
    return 1;
  }

  const { keyid, pubkey } = identity;

  const files = args.flags.files
    ? String(args.flags.files)
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean)
    : undefined;

  const out = {
    $schema: await schemaRef(loaded.dir),
    project: config.project,
    provider: config.provider,
    options: config.options,
    ...(config.auth ? { auth: config.auth } : {}),
    ...(config.kdf ? { kdf: config.kdf } : {}),
    include: config.include,
    exclude: config.exclude,
    recipients: [...config.recipients, { name: me, keyid, pubkey, ...(files ? { files } : {}) }]
  };

  if (loaded.source === 'package.json') {
    warn('Your configuration lives in package.json, which this command does not rewrite.');
    note('Add yourself to "recipients" there by hand:');
    console.log('');
    console.log(dim(JSON.stringify({ name: me, keyid, pubkey }, null, 2)));
    console.log('');
    return 1;
  }

  await writeFile(loaded.file, JSON.stringify(out, null, 2) + '\n');

  outcome({
    ok: `Added ${cyan(me)} to ${config.project}. Your public key is ${dim(pubkey)}`,
    next: [
      'You cannot read anything yet - what is already stored was secured without you',
      `Commit ${path.basename(loaded.file)}, then ask someone with access to pull and run ${command('push')}`,
      `After that, ${command('pull')} will work on this machine`
    ]
  });

  return 0;
}
