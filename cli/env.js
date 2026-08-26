#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.js';
import { bold, cyan, dim, red } from './lib/format.js';
import { command } from './lib/ui.js';

const COMMANDS = {
  setup: () => import('./commands/setup.js').then((m) => m.setup),
  push: () => import('./commands/push.js').then((m) => m.push),
  pull: () => import('./commands/pull.js').then((m) => m.pull),
  status: () => import('./commands/status.js').then((m) => m.status)
};

const HELP = `
  ${bold('@wilsoon/env')} ${dim('- end-to-end encrypted environment variables')}

  ${cyan('setup')}     Create a project, generate an identity key, write the config
  ${cyan('push')}      Encrypt every .env* file here and store it
  ${cyan('pull')}      Fetch and decrypt them onto this machine
  ${cyan('status')}    Compare what is here against what is stored

  ${dim('Options')}
    --force        Skip confirmations and overwrite
    --yes          Answer yes to prompts
    --help         Show this
    --version      Print the version

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

  return (await load())(args);
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
