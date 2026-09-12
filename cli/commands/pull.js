import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { open } from '../../core/crypto/envelope.js';
import { diff, isSyncable } from '../../core/dotenv.js';
import { KIND_ENV } from '../../core/provider.js';
import { openSession, unlockIdentity } from '../../core/session.js';
import { lastSeen, remember } from '../../core/state.js';
import { cyan, dim, green, plural, red, yellow } from '../lib/format.js';
import { confirm, password } from '../lib/prompt.js';
import { command, heading, note, ok, outcome, warn } from '../lib/ui.js';

async function localFile(dir, name) {
  try {
    return await readFile(path.join(dir, name), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;

    throw err;
  }
}

function describeChange(before, after) {
  if (before === null) return { label: green('new'), detail: 'not on this machine yet' };

  if (before === after) return { label: dim('same'), detail: null };

  const d = diff(before, after);
  const parts = [];
  if (d.added.length) parts.push(green(`+${d.added.length}`));

  if (d.removed.length) parts.push(red(`-${d.removed.length}`));

  if (d.changed.length) parts.push(yellow(`~${d.changed.length}`));

  return { label: parts.join(' ') || yellow('changed'), detail: [...d.added.map((k) => `+ ${k}`), ...d.removed.map((k) => `- ${k}`), ...d.changed.map((k) => `~ ${k}`)].join('   ') };
}

export async function pull(args) {
  const session = await openSession({ cwd: args.flags.cwd ?? process.cwd() });

  const stored = (await session.provider.list(session.project)).filter((e) => e.kind === KIND_ENV && isSyncable(e.name, session.config));

  const only = args.positional.length ? args.positional : null;
  const wanted = stored.filter((e) => !only || only.includes(e.name));

  if (!wanted.length) {
    warn(only ? 'None of those files are in the store.' : `Nothing stored for ${cyan(session.project)} yet.`);
    note(`Run ${command('push')} first.`);
    return 1;
  }

  heading(`Pulling ${plural(wanted.length, 'file')} from ${cyan(session.provider.describe?.() ?? session.config.provider)}`);

  const fromEnv = process.env.WILSOON_ENV_PASSPHRASE;
  const { privateRaw } = await unlockIdentity(session, fromEnv ? async () => fromEnv : () => password('  Passphrase: '), { as: args.flags.as, cache: !args.flags['no-cache'] });

  console.log('');

  const plan = [];

  for (const entry of wanted) {
    const fetched = await session.provider.get(session.envRef(entry.name));
    if (!fetched) continue;

    const { plaintext, version } = open({ blob: fetched.blob, privateRaw, project: session.project, name: entry.name });

    const seen = await lastSeen(session.project, entry.name);
    // Only a memory of what came before the older blob can notice the rollback
    const rolledBack = seen !== null && version < seen;

    const before = await localFile(session.dir, entry.name);
    const after = plaintext.toString('utf8');

    plan.push({ name: entry.name, before, after, version, rolledBack, ...describeChange(before, after) });
  }

  const changes = plan.filter((p) => p.before !== p.after);
  const rolled = plan.filter((p) => p.rolledBack);

  for (const item of plan) {
    console.log(`  ${item.label.padEnd(18)} ${item.name} ${dim(`v${item.version}`)}`);
    if (item.detail && item.before !== null) note(`     ${item.detail}`);
  }

  if (rolled.length) {
    console.log('');
    for (const item of rolled) warn(`${item.name} is older than a version you have already seen. The store may be serving a stale copy.`);
  }

  if (!changes.length) {
    outcome({ ok: 'Everything here is already up to date', next: [] });
    return 0;
  }

  const overwrites = changes.filter((c) => c.before !== null);

  if (overwrites.length && !args.flags.force && !args.flags.yes) {
    console.log('');
    warn(`${plural(overwrites.length, 'local file')} will be overwritten.`);

    if (!(await confirm('  Continue?'))) {
      console.log('');
      note('Nothing was written.');
      return 1;
    }
  }

  if (rolled.length && !args.flags.force) {
    console.log('');
    if (!(await confirm('  Write the older versions anyway?'))) {
      note('Nothing was written.');
      return 1;
    }
  }

  console.log('');

  for (const item of changes) {
    await writeFile(path.join(session.dir, item.name), item.after, { mode: 0o600 });
    await remember(session.project, item.name, item.version);
    ok(`${item.name}`);
  }

  outcome({
    ok: `${plural(changes.length, 'file')} written`,
    next: [`Run ${command('status')} to compare against the store at any time`]
  });

  return 0;
}
