import path from 'node:path';

import { discover, isSyncable } from '../../core/dotenv.js';
import { KIND_ENV, KIND_IDENTITY } from '../../core/provider.js';
import { openSession } from '../../core/session.js';
import { lastSeen } from '../../core/state.js';
import { cyan, dim, green, plural, yellow } from '../lib/format.js';
import { command, field, heading, note } from '../lib/ui.js';

// Compares which files exist where, and at what version - does not decrypt anything
export async function status(args = { flags: {} }) {
  const session = await openSession({ cwd: args.flags.cwd ?? process.cwd() });

  heading(`${cyan(session.project)}`);
  field('Config', path.relative(process.cwd(), session.file) || session.file);
  field('Provider', `${session.config.provider} ${dim(session.provider.describe?.() ?? '')}`);
  field('Recipients', session.config.recipients.map((r) => r.name ?? r.keyid ?? 'unnamed').join(', ') || dim('none'));

  const listed = await session.provider.list(session.project);
  const hasIdentity = listed.some((e) => e.kind === KIND_IDENTITY);

  field('Identity', hasIdentity ? green('stored') : yellow('missing'));

  const remote = new Map(listed.filter((e) => e.kind === KIND_ENV && isSyncable(e.name, session.config)).map((e) => [e.name, e.version]));
  const local = await discover(session.dir, session.config);

  const names = [...new Set([...local, ...remote.keys()])].sort();

  console.log('');

  if (!names.length) {
    note('No .env files here, and nothing in the store.');
    note(`Create a .env and run ${command('push')}.`);
    return 0;
  }

  for (const name of names) {
    const onDisk = local.includes(name);
    const version = remote.get(name);
    const seen = version === undefined ? null : await lastSeen(session.project, name);

    let state;
    if (!onDisk) state = yellow('remote only');
    else if (version === undefined) state = green('local only');
    else if (seen !== null && version > seen) state = yellow('newer in store');
    else state = dim('tracked');

    console.log(`  ${state.padEnd(24)} ${name}${version === undefined ? '' : ' ' + dim(`v${version}`)}`);
  }

  console.log('');

  const remoteOnly = names.filter((n) => !local.includes(n));
  const localOnly = names.filter((n) => !remote.has(n));

  if (remoteOnly.length) note(`${plural(remoteOnly.length, 'file')} in the store, not here - ${command('pull')}`);

  if (localOnly.length) note(`${plural(localOnly.length, 'file')} here, not in the store - ${command('push')}`);

  if (!remoteOnly.length && !localOnly.length) note(`Run ${command('pull')} to check for content changes; status does not decrypt.`);

  console.log('');

  return 0;
}
