import { existsSync } from 'node:fs';
import path from 'node:path';

import { open } from '../../core/crypto/envelope.js';
import { isSyncable, parse } from '../../core/dotenv.js';
import { KIND_ENV } from '../../core/provider.js';
import { openSession, unlockIdentity } from '../../core/session.js';
import { cyan, dim, plural, S } from '../lib/format.js';
import { choose, chooseMany, confirm, isInteractive, password } from '../lib/prompt.js';
import { ensureSignedIn } from '../lib/signin.js';
import { findTool, runTool } from '../lib/tool.js';
import { command, fail, heading, note, ok, outcome, warn } from '../lib/ui.js';

// Wrangler takes at most this many secrets in one bulk upload
const WRANGLER_BATCH = 100;

// Write secrets directly to a production environment using Vercel/Wrangler

const TARGETS = {
  vercel: {
    label: 'Vercel',
    bin: 'vercel',
    install: 'npm i -g vercel',
    linked: (dir) => existsSync(path.join(dir, '.vercel', 'project.json')) || Boolean(process.env.VERCEL_PROJECT_ID),
    unlinked: () => `This directory is not linked to a Vercel project. Run ${cyan('vercel link')} first.`,
    where: ({ environment, branch }) => (branch ? `${environment}, branch ${branch}` : environment),
    send: sendToVercel
  },
  wrangler: {
    label: 'Cloudflare Workers',
    bin: 'wrangler',
    install: 'npm i -D wrangler',
    linked: (dir, rest) => ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((f) => existsSync(path.join(dir, f))) || rest.some((arg) => arg === '--name' || arg.startsWith('--name=')),
    unlinked: () => `No wrangler.jsonc, wrangler.json or wrangler.toml here. Run this beside one, or name the Worker: ${command('export wrangler -- --name my-worker')}`,
    where: ({ environment }) => (environment ? `environment ${environment}` : 'the top-level Worker'),
    send: sendToWrangler
  }
};

async function sendToVercel({ bin, dir, entries, environment, branch, rest, spawn }) {
  const sent = [];

  for (const [key, value] of entries) {
    const argv = ['env', 'add', key, environment, ...(branch ? [branch] : []), '--sensitive', '--force', ...rest];
    const { code, output } = await runTool(bin, argv, { cwd: dir, stdin: value, spawn });

    if (code !== 0) {
      fail(key);
      for (const line of output.trim().split(/\r?\n/).filter(Boolean)) note(`   ${dim(line)}`);

      return { sent, failed: key };
    }

    ok(key);
    sent.push(key);
  }

  return { sent, failed: null };
}

async function sendToWrangler({ bin, dir, entries, environment, rest, spawn }) {
  const sent = [];

  for (let i = 0; i < entries.length; i += WRANGLER_BATCH) {
    const batch = entries.slice(i, i + WRANGLER_BATCH);
    const argv = ['secret', 'bulk', ...(environment ? ['--env', environment] : []), ...rest];

    // Wrangler prints key names as it goes, never values, so its own output is the progress report
    console.log('');
    const { code } = await runTool(bin, argv, { cwd: dir, stdin: JSON.stringify(Object.fromEntries(batch)), inherit: true, spawn });

    if (code !== 0) return { sent, failed: batch[0][0] };

    sent.push(...batch.map(([key]) => key));
  }

  return { sent, failed: null };
}

const splitList = (value) =>
  String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

async function whichTarget(args) {
  const named = args.positional[0];

  if (named && TARGETS[named]) return named;

  if (named) throw new Error(`Cannot export to "${named}".\n\n  Export to one of: ${Object.keys(TARGETS).join(', ')}\n`);

  if (!isInteractive())
    throw new Error(
      `Say where to export to: ${
        Object.keys(TARGETS)
          .map((t) => `export ${t}`)
          .join(' or ')
      }\n`
    );

  return await choose(
    'Export to',
    Object.entries(TARGETS).map(([value, t]) => ({ value, label: t.label, hint: t.bin }))
  );
}

async function whichFiles(args, stored) {
  if (args.flags.file) return splitList(args.flags.file);

  if (stored.length === 1) return [stored[0].name];

  if (!isInteractive()) throw new Error('Several files are stored. Choose which with --file .env.production\n');

  const names = stored.map((e) => e.name);
  const initial = Math.max(0, names.indexOf('.env.production'));

  return [await choose('Which file?', names, { initial })];
}

async function whichVercelEnvironment(args) {
  const environment = typeof args.flags.env === 'string' ? args.flags.env : null;

  // Vercel keeps development values readable, which is the whole reason they cannot be marked sensitive
  if (environment === 'development')
    throw new Error(
      `Vercel cannot mark development variables as sensitive and this exports nothing else.\n\n  For local development, ${command('pull')} or ${
        command('run -- vercel dev')
      } gives you the same values without storing them as environment variables on Vercel.\n`
    );

  if (environment) return environment;

  if (!isInteractive()) throw new Error('Say which Vercel environment with --env production (or preview, or a custom one).\n');

  return await choose('Which Vercel environment?', [
    { value: 'production', label: 'Production' },
    { value: 'preview', label: 'Preview', hint: 'every branch, unless you add --branch' }
  ]);
}

async function whichKeys(args, vars, target) {
  if (args.flags.keys) {
    const wanted = splitList(args.flags.keys);
    const unknown = wanted.filter((key) => !vars.has(key));

    if (unknown.length) throw new Error(`Not in the file: ${unknown.join(', ')}\n`);

    return wanted;
  }

  if (!isInteractive()) {
    if (args.flags.yes) return [...vars.keys()];

    throw new Error('Choose what to send with --keys A,B, or send every one with --yes.\n');
  }

  // Names only. An empty value starts unticked, since it is more often a placeholder than a secret.
  return await chooseMany(
    `Which to send to ${target.label}?`,
    [...vars].map(([key, value]) => ({ value: key, label: key, hint: value === '' ? 'empty' : '', selected: value !== '' }))
  );
}

/** Decrypt, and hand chosen values to a platform's secret store over stdin - never onto disk, never onto the screen */
export async function exportEnv(args, { spawn, locate = findTool } = {}) {
  const dir = args.flags.cwd ?? process.cwd();
  const name = await whichTarget(args);
  const target = TARGETS[name];

  const bin = locate(target.bin, dir);

  if (!bin) {
    warn(`${target.bin} is not installed here.`);
    note(`Install it with ${cyan(target.install)}, then run this again.`);
    return 1;
  }

  if (!target.linked(dir, args.rest)) {
    warn(target.unlinked());
    return 1;
  }

  const session = await openSession({ cwd: dir });
  await ensureSignedIn(session.config, args);

  const stored = (await session.provider.list(session.project)).filter((e) => e.kind === KIND_ENV && isSyncable(e.name, session.config));

  if (!stored.length) {
    warn(`Nothing stored for ${cyan(session.project)} yet.`);
    note(`Run ${command('push')} first.`);
    return 1;
  }

  const files = await whichFiles(args, stored);
  const environment = name === 'vercel' ? await whichVercelEnvironment(args) : typeof args.flags.env === 'string' ? args.flags.env : null;
  const branch = typeof args.flags.branch === 'string' ? args.flags.branch : null;

  if (branch && environment !== 'preview') throw new Error('--branch only applies to --env preview.\n');

  heading(`Exporting ${cyan(session.project)} to ${target.label}`);

  const fromEnv = process.env.WILSOON_ENV_PASSPHRASE;
  const { privateRaw } = await unlockIdentity(session, fromEnv ? async () => fromEnv : () => password('  Passphrase: '), { as: args.flags.as, cache: !args.flags['no-cache'] });

  // Later files win, the same as run
  const vars = new Map();

  for (const file of files) {
    const fetched = await session.provider.get(session.envRef(file));

    if (!fetched) {
      warn(`${file} is not in the store.`);
      return 1;
    }

    const { plaintext } = open({ blob: fetched.blob, privateRaw, project: session.project, name: file });
    for (const [key, value] of parse(plaintext)) vars.set(key, value);
  }

  if (!vars.size) {
    warn(`${files.join(', ')} holds no variables.`);
    return 1;
  }

  console.log('');
  const keys = await whichKeys(args, vars, target);

  if (!keys.length) {
    note('Nothing selected, so nothing was sent.');
    return 0;
  }

  const where = target.where({ environment, branch });

  console.log('');
  note(`${plural(keys.length, 'secret')} from ${files.join(', ')} ${dim(S.arrow)} ${target.label} (${where})`);
  note(dim('Any secret already there with the same name is replaced.'));
  console.log('');

  if (!args.flags.yes && !(await confirm('  Send them?'))) {
    note('Nothing was sent.');
    return 1;
  }

  console.log('');

  const { sent, failed } = await target.send({ bin, dir, entries: keys.map((key) => [key, vars.get(key)]), environment, branch, rest: args.rest, spawn });

  if (failed) {
    console.log('');
    warn(`${target.bin} refused ${cyan(failed)}, so the rest were not sent.`);
    note(sent.length ? `${plural(sent.length, 'secret')} did go through: ${sent.join(', ')}` : 'None were sent.');
    return 1;
  }

  outcome({
    ok: `${plural(sent.length, 'secret')} sent to ${target.label}`,
    next: [`Stored as secrets in ${where} - nothing was written to disk or printed`, name === 'vercel' ? 'Redeploy for a running deployment to see them' : `Live from the next ${cyan('wrangler deploy')}, or at once for a Worker already deployed`]
  });

  return 0;
}
