import { spawn } from 'node:child_process';
import { constants } from 'node:os';

import { parse } from '../../core/dotenv.js';
import { openSession, unlockIdentity } from '../../core/session.js';
import { open } from '../../core/crypto/envelope.js';
import { cyan, dim, plural } from '../lib/format.js';
import { command, note, warn } from '../lib/ui.js';
import { password } from '../lib/prompt.js';

const CMD_SPECIAL = /[\s"^&|<>()%!]/;

function quoteForCmd(arg) {
  if (!CMD_SPECIAL.test(arg)) return arg;

  return (
    '"' +
    String(arg)
      .replace(/(\\*)"/g, '$1$1\\"')
      .replace(/(\\*)$/, '$1$1') +
    '"'
  );
}

/** Decrypt into a child process, never onto disk */
export async function run(args) {
  if (!args.rest.length) {
    warn('Nothing to run.');
    note(`Put the command after a double dash: ${command('run -- npm start')}`);
    return 1;
  }

  const session = await openSession({ cwd: args.flags.cwd ?? process.cwd() });
  const names = String(args.flags.file ?? '.env')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);

  const fromEnv = process.env.WILSOON_ENV_PASSPHRASE;
  const { privateRaw } = await unlockIdentity(session, fromEnv ? async () => fromEnv : () => password('  Passphrase: '), { as: args.flags.as, cache: !args.flags['no-cache'] });

  const vars = new Map();
  const loaded = [];

  for (const name of names) {
    const fetched = await session.provider.get(session.envRef(name));

    if (!fetched) {
      warn(`${name} is not in the store.`);
      return 1;
    }

    const { plaintext } = open({ blob: fetched.blob, privateRaw, project: session.project, name });
    for (const [key, value] of parse(plaintext)) vars.set(key, value);

    loaded.push(name);
  }

  if (!args.flags.quiet) note(`${plural(vars.size, 'variable')} from ${loaded.join(', ')} ${dim('(not written to disk)')}`);

  const [file, ...rest] = args.rest;
  const env = { ...process.env, ...Object.fromEntries(vars) };
  const child = process.platform === 'win32' ? spawn([file, ...rest].map(quoteForCmd).join(' '), { stdio: 'inherit', env, shell: true }) : spawn(file, rest, { stdio: 'inherit', env });

  return await new Promise((resolve) => {
    child.on('error', (err) => {
      console.error('');
      console.error(`  Could not run ${cyan(file)}: ${err.message}`);
      resolve(1);
    });

    child.on('close', (code, signal) => resolve(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 0)));
  });
}
