import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { discover } from '../../core/dotenv.js';
import { openSession, recipientKeys } from '../../core/session.js';
import { recipientsOf, seal } from '../../core/crypto/envelope.js';
import { keyIdOf } from '../../core/crypto/identity.js';
import { ConflictError } from '../../core/provider.js';
import { remember } from '../../core/state.js';
import { cyan, dim, plural, yellow } from '../lib/format.js';
import { command, heading, note, ok, outcome, warn } from '../lib/ui.js';
import { confirm } from '../lib/prompt.js';

// Adding a recipient should inform user that it gives access to secrets, and the config only takes place on next push
async function confirmNewRecipients(session, recipients, files) {
  const configured = new Map(recipients.map((r) => [keyIdOf(r.publicRaw).toString('hex'), r]));

  const known = new Set();
  for (const name of files) {
    const stored = await session.provider.get(session.envRef(name));
    if (stored) for (const keyid of recipientsOf(stored.blob)) known.add(keyid.toString('hex'));
  }

  if (!known.size) return true;

  const added = [...configured.entries()].filter(([keyid]) => !known.has(keyid));
  if (!added.length) return true;

  console.log('');
  warn(`This push grants access to ${plural(added.length, 'new recipient')}:`);
  for (const [keyid, r] of added) console.log(`      ${yellow(r.name ?? 'unnamed')}  ${dim(keyid)}`);
  console.log('');
  note('They will be able to decrypt every file pushed from now on.');

  return confirm('  Continue?');
}

export async function push(args) {
  const session = await openSession({ cwd: args.flags.cwd ?? process.cwd() });
  const recipients = recipientKeys(session.config);

  const only = args.positional.length ? args.positional : null;
  const files = (await discover(session.dir, session.config)).filter((name) => !only || only.includes(name));

  if (!files.length) {
    warn(only ? 'None of those files are here, or they are excluded by your config.' : 'No .env files found to push.');
    note(`Looked in ${cyan(session.dir)} for ${session.config.include.join(', ')}`);
    return 1;
  }

  heading(`Pushing ${plural(files.length, 'file')} to ${cyan(session.provider.describe?.() ?? session.config.provider)}`);

  if (!args.flags.yes && !(await confirmNewRecipients(session, recipients, files))) {
    console.log('');
    note('Nothing was pushed.');
    return 1;
  }

  let pushed = 0;
  let skipped = 0;

  for (const name of files) {
    const plaintext = await readFile(path.join(session.dir, name));
    const current = await session.provider.get(session.envRef(name));
    const version = (current?.version ?? 0n) + 1n;

    const blob = seal({
      plaintext,
      recipients: recipients.map((r) => r.publicRaw),
      project: session.project,
      name,
      version
    });

    try {
      await session.provider.put(session.envRef(name), blob, { ifVersion: current?.version ?? 0n });
    } catch (err) {
      if (err instanceof ConflictError) {
        warn(`${name} - ${err.message}`);
        skipped++;
        continue;
      }

      throw err;
    }

    await remember(session.project, name, version);

    ok(`${name} ${dim(`v${version}`)}`);
    pushed++;
  }

  outcome({
    ok: `${plural(pushed, 'file')} pushed${skipped ? `, ${skipped} skipped` : ''}`,
    next: [`Encrypted for ${plural(recipients.length, 'recipient')}`, skipped ? `Run ${command('pull')} to resolve the conflicts, then push again` : `Run ${command('pull')} on another machine to fetch them`]
  });

  return skipped ? 1 : 0;
}
