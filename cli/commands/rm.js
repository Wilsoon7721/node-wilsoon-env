import { KIND_ENV } from '../../core/provider.js';
import { openSession } from '../../core/session.js';
import { cyan, plural } from '../lib/format.js';
import { confirm } from '../lib/prompt.js';
import { command, heading, note, ok, outcome, warn } from '../lib/ui.js';

/**
 * Delete a file from the store, the copy of the file on the machine is left alone
 */
export async function rm(args) {
  const session = await openSession({ cwd: args.flags.cwd ?? process.cwd() });

  const names = args.positional;

  if (!names.length) {
    warn('Name the files to remove from the store.');
    note(`${command('rm .env.staging')}`);
    note(`Run ${command('status')} to see what is stored.`);
    return 1;
  }

  const stored = await session.provider.list(session.project);
  const present = new Set(stored.filter((e) => e.kind === KIND_ENV).map((e) => e.name));

  const found = names.filter((n) => present.has(n));
  const missing = names.filter((n) => !present.has(n));

  for (const name of missing) warn(`${name} is not in the store.`);

  if (!found.length) return 1;

  heading(`Removing ${plural(found.length, 'file')} from ${cyan(session.provider.describe?.() ?? session.config.provider)}`);

  for (const name of found) console.log(`  ${name}`);
  console.log('');

  note('This deletes the stored ciphertext. Anyone who has already pulled keeps their copy,');
  note('and your local files are not touched.');
  console.log('');

  if (!args.flags.yes && !args.flags.force && !(await confirm('  Remove them?'))) {
    note('Nothing was removed.');
    return 1;
  }

  console.log('');

  let removed = 0;
  for (const name of found) {
    if (await session.provider.remove(session.envRef(name))) {
      ok(name);
      removed++;
    }
  }

  outcome({
    ok: `${plural(removed, 'file')} removed from the store`,
    next: ['Local copies are untouched - delete them yourself if you meant to', `A later ${command('push')} will store them again if the files are still here`]
  });

  return 0;
}
