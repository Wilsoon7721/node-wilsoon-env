#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.js';
import { bold, cyan, dim, red } from './lib/format.js';
import { command } from './lib/ui.js';

const COMMANDS = {
  setup: () => import('./commands/setup.js').then((m) => m.setup),
  join: () => import('./commands/join.js').then((m) => m.join),
  push: () => import('./commands/push.js').then((m) => m.push),
  pull: () => import('./commands/pull.js').then((m) => m.pull),
  status: () => import('./commands/status.js').then((m) => m.status),
  run: () => import('./commands/run.js').then((m) => m.run),
  keys: () => import('./commands/keys.js').then((m) => m.keys),
  rm: () => import('./commands/rm.js').then((m) => m.rm),
  remove: () => import('./commands/rm.js').then((m) => m.rm),
  logout: () => import('./commands/logout.js').then((m) => m.logout),
  login: () => import('./commands/login.js').then((m) => m.login),
  whoami: () => import('./commands/login.js').then((m) => m.whoami)
};

const HELP = `
  ${bold('@wilsoon/env')} ${dim('- end-to-end encrypted environment variables')}

  ${cyan('setup')}     Create a project, generate an identity key, write the config
  ${cyan('join')}      Add your key to a project someone else set up
  ${cyan('push')}      Encrypt every .env* file here and store it
  ${cyan('pull')}      Fetch and decrypt them onto this machine
  ${cyan('status')}    Compare what is here against what is stored
  ${cyan('run')}       Decrypt into a command's environment, never onto disk
  ${cyan('keys')}      List, add, issue, audit or remove recipients
  ${cyan('rm')}        Delete a file from the store
  ${cyan('login')}     Sign in to the identity provider this project uses
  ${cyan('whoami')}    Show who you are signed in as
  ${cyan('logout')}    Forget cached keys and tokens on this machine

  ${dim('Options')}
    --as <name>    Which identity to unlock, when a store holds several
    --no-cache     Do not read or write the keychain
    --force        Skip confirmations and overwrite
    --yes          Answer yes to prompts
    --help         Show this
    --version      Print the version

  ${dim('Where the store is')} ${dim('(setup)')}
    --path, --bucket, --endpoint, --region, --prefix, --profile
    --url, --anon-key, --table, --schema

  ${dim('Who you are to it')} ${dim('(setup, and login before a config exists)')}
    --auth <oidc|supabase>   How the store decides who you are
    --issuer <url>           Issuer base URL, for --auth oidc
    --client-id <id>         Public client id. No secret

  ${dim('Run a command with specific files:')}  ${command('pull .env.production')}
`;

async function version() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(await readFile(path.join(here, '..', 'package.json'), 'utf8'));
  return pkg.version;
}

async function main(argv) {
  const args = parseArgs(argv);
  const name = args.positional.shift();

  if (args.flags.version) {
    console.log(await version());
    return 0;
  }

  if (!name || args.flags.help || name === 'help') {
    console.log(HELP);
    return name && name !== 'help' ? 1 : 0;
  }

  const load = COMMANDS[name];

  if (!load) {
    console.error(`  ${red('Unknown command')} "${name}"`);
    console.error(dim(`  Try one of: ${Object.keys(COMMANDS).join(', ')}`));
    return 1;
  }

  try {
    return await (
      await load()
    )(args);
  } finally {
    // Providers that hold a socket have to be told to let go
    const { closeSessions } = await import('../core/session.js');
    await closeSessions();
  }
}

main(process.argv.slice(2))
  .then((code) => (process.exitCode = code ?? 0))
  .catch((err) => {
    console.error('');
    console.error(`  ${red('✗')} ${err.message}`);
    if (process.env.WILSOON_ENV_DEBUG) console.error(err.stack);

    console.error('');
    process.exitCode = 1;
  });
