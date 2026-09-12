#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.js';
import { bold, cyan, dim, red, S } from './lib/format.js';
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
    --as <name>      Which identity to unlock, when a store holds several
    --store <name>   Set up with a store you saved earlier
    --no-cache       Do not read or write the keychain
    --force          Skip confirmations and overwrite
    --yes            Answer yes to prompts
    --help           Show this
    --version        Print the version

  ${dim('Run setup with no flags and it will ask you what it needs.')}
  ${dim(`Scripting it instead? ${command('setup --unattended --help')}`)}

  ${dim('Run a command with specific files:')}  ${command('pull .env.production')}
`;

/*
  Kept out of the main help on purpose. Someone meeting this package does not
  need twenty provider settings; they need to know that setup will ask. These
  exist for CI and for people who already know what they want, and naming
  --unattended is how you say which of those you are.
*/
const UNATTENDED_HELP = `
  ${bold('setup --unattended')} ${dim('- supply the configuration instead of being asked')}

  ${dim('Nothing below is accepted without --unattended. Without it, setup asks.')}

  ${dim('Which store')}
    --provider <name>        local, supabase, s3, kv, aws, mongodb

  ${dim('local')}
    --path <dir>             Where the store lives            ${dim('[.wilsoon-store]')}

  ${dim('s3, and anything S3-compatible')}
    --bucket <name>          Required
    --endpoint <url>         Leave unset for AWS S3
    --region <name>          ${dim('[auto with an endpoint, else us-east-1]')}
    --prefix <path>          Key prefix inside the bucket
    --profile <name>         Which ~/.aws/credentials profile
    ${dim('Credentials: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY')}

  ${dim('supabase')}
    --url <url>              Project URL
    --anon-key <key>         Publishable key. Safe to commit
    --table <name>           ${dim('[wilsoon_env]')}
    --schema <name>          ${dim('[public]')} ${dim('- must be listed under Exposed Schemas')}
    ${dim('Or a machine credential: SUPABASE_SERVICE_ROLE_KEY (bypasses RLS project-wide)')}

  ${dim('kv')}
    --account-id <id>
    --namespace-id <id>
    ${dim('Credentials: CLOUDFLARE_API_TOKEN')}

  ${dim('aws')}
    --region <name>          ${dim('[us-east-1]')}
    --prefix <name>          Secret name prefix               ${dim('[wenv/]')}
    ${dim('Credentials: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY')}

  ${dim('mongodb')}
    --db <name>              ${dim('[wilsoon_env]')}
    --collection <name>      ${dim('[blobs]')}
    ${dim('Credentials: MONGODB_URI')}

  ${dim('Who the store thinks you are')} ${dim('(supabase only - nothing else has users)')}
    --auth <oidc|supabase>
    --issuer <url>           For --auth oidc
    --client-id <id>         What you registered this CLI as. No secret
    --scope <scope>          ${dim('[openid email offline_access]')}

  ${dim('Also useful when scripting')}
    --project <name>         Namespace in the store           ${dim('[directory name]')}
    --name <name>            What to call your own key        ${dim('[me]')}
    ${dim('WILSOON_ENV_PASSPHRASE so nothing has to be typed')}

  ${dim('Example')}
    ${command('setup --unattended --provider s3 --bucket my-secrets --endpoint https://xyz.r2.cloudflarestorage.com')}
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

  if (args.flags.help && args.flags.unattended) {
    console.log(UNATTENDED_HELP);
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
    console.error(`  ${red(S.bad)} ${err.message}`);
    if (process.env.WILSOON_ENV_DEBUG) console.error(err.stack);

    console.error('');
    process.exitCode = 1;
  });
