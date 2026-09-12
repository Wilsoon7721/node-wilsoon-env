import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadConfig, schemaRef } from '../../core/config.js';
import { encodePublic, generateIdentity, keyIdOf, sealIdentity } from '../../core/crypto/identity.js';
import { KIND_IDENTITY } from '../../core/provider.js';
import { openSession } from '../../core/session.js';
import { cyan, dim } from '../lib/format.js';
import { newPassphrase, requireInteractive } from '../lib/prompt.js';
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

  if (config.recipients.some((r) => r.name === me)) {
    warn(`This project already lists a recipient called ${cyan(me)}.`);
    note(`Pick a different name with --name, or run ${command('setup --force')} to replace that identity.`);
    return 1;
  }

  const session = await openSession({ cwd });

  heading(`Joining ${cyan(config.project)}`);
  field('Provider', `${config.provider} ${dim(session.provider.describe?.() ?? '')}`);
  field('Joining as', me);
  field('Existing', config.recipients.map((r) => r.name ?? r.keyid).join(', ') || dim('nobody'));
  console.log('');

  note('Your passphrase protects your own identity key. It is never sent anywhere,');
  note('and nobody else in this project can recover it for you.');
  console.log('');

  const passphrase = process.env.WILSOON_ENV_PASSPHRASE ?? (requireInteractive('Joining a project'), await newPassphrase());

  const { publicRaw, privateRaw } = generateIdentity();
  const pubkey = encodePublic(publicRaw);
  const keyid = keyIdOf(publicRaw).toString('hex');

  await session.provider.put({ project: config.project, kind: KIND_IDENTITY, name: keyid }, await sealIdentity(privateRaw, passphrase));

  const out = {
    $schema: await schemaRef(loaded.dir),
    project: config.project,
    provider: config.provider,
    options: config.options,
    ...(config.auth ? { auth: config.auth } : {}),
    ...(config.kdf ? { kdf: config.kdf } : {}),
    include: config.include,
    exclude: config.exclude,
    recipients: [
      ...config.recipients,
      {
        name: me,
        keyid,
        pubkey,
        ...(args.flags.files
          ? {
            files: String(args.flags.files)
              .split(',')
              .map((f) => f.trim())
              .filter(Boolean)
          }
          : {})
      }
    ]
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
      `After that, ${command('pull --as ' + me)} will work on this machine`
    ]
  });

  return 0;
}
