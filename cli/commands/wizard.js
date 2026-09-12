import path from 'node:path';

import { normaliseIssuer } from '../lib/authflags.js';
import { cyan, dim } from '../lib/format.js';
import { ask, choose, confirm } from '../lib/prompt.js';
import { listStores, saveStore } from '../lib/stores.js';
import { heading, note, warn } from '../lib/ui.js';

const PROVIDERS = [
  { value: 'local', label: 'This machine only', hint: 'no account, good for trying it out' },
  { value: 'supabase', label: 'Supabase', hint: 'Postgres, row level security' },
  { value: 's3', label: 'S3-compatible', hint: 'AWS, Cloudflare R2, MinIO, Backblaze' },
  { value: 'kv', label: 'Cloudflare KV', hint: 'Eventual consistency: see README.md#providers' },
  { value: 'aws', label: 'AWS Secrets Manager', hint: 'what production already reads' },
  { value: 'mongodb', label: 'MongoDB', hint: 'needs the mongodb driver installed' }
];

const pick = (io, question, choices, opts = {}) => choose(question, choices, { ...opts, ...io });

async function askFor(io, question, fallback = '', hint = '') {
  if (hint) note(hint);

  const answer = await ask(`  ${question}${fallback ? ` ${dim(`[${fallback}]`)}` : ''}: `, io);
  return answer || fallback;
}

async function askUrl(io, question, what, hint = '') {
  for (;;) {
    try {
      return normaliseIssuer(await askRequired(io, question, what, hint), what);
    } catch (err) {
      note(err.message.split('\n')[0]);
    }
  }
}

async function askRequired(io, question, what, hint = '') {
  for (;;) {
    const answer = await askFor(io, question, '', hint);
    if (answer) return answer;

    note(`${what} is needed to reach the store.`);
  }
}

const keep = (options) => Object.fromEntries(Object.entries(options).filter(([, v]) => v !== '' && v !== undefined && v !== null));

async function optionsFor(io, provider) {
  if (provider === 'local') return { options: { path: await askFor(io, 'Where should the store live?', '.wilsoon-store') }, secrets: [] };

  if (provider === 'supabase') {
    const url = await askUrl(io, 'Supabase project URL', 'project URL', 'Dashboard > Project Settings > Data API > Project URL');

    const anonKey = await askFor(io, 'Publishable (anon) key', '', 'Same page, under Project API keys. Safe to commit - row level security is what protects the rows.');
    const table = await askFor(io, 'Table', 'wilsoon_env', 'If it does not exist yet, setup will show you the SQL to create it.');
    const schema = await askFor(io, 'Schema', 'public', 'Anything other than public must be listed under Settings > Data API > Exposed Schemas.');

    return { options: keep({ url, anonKey, table, schema: schema === 'public' ? '' : schema }), secrets: [] };
  }

  if (provider === 's3') {
    const bucket = await askRequired(io, 'Bucket', 'A bucket', 'A bucket that already exists. Nothing here creates one.');
    const endpoint = await askFor(io, 'Endpoint (blank for AWS S3)', '', 'For R2: https://<account id>.r2.cloudflarestorage.com');

    return {
      options: keep({ bucket, endpoint, region: await askFor(io, 'Region', endpoint ? 'auto' : 'us-east-1'), prefix: await askFor(io, 'Prefix inside the bucket') }),
      secrets: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']
    };
  }

  if (provider === 'kv')
    return {
      options: keep({
        accountId: await askRequired(io, 'Cloudflare account id', 'An account id', 'Cloudflare dashboard, in the URL after /accounts/'),
        namespaceId: await askRequired(io, 'KV namespace id', 'A namespace id', 'Workers & Pages > KV, next to the namespace')
      }),
      secrets: ['CLOUDFLARE_API_TOKEN']
    };

  if (provider === 'aws') return { options: keep({ region: await askFor(io, 'Region', 'us-east-1'), prefix: await askFor(io, 'Secret name prefix', 'wenv/') }), secrets: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] };

  return { options: keep({ db: await askFor(io, 'Database', 'wilsoon_env'), collection: await askFor(io, 'Collection', 'blobs') }), secrets: ['MONGODB_URI'] };
}

async function authFor(io, provider) {
  if (provider !== 'supabase') return null;

  heading(dim('How this machine proves it may fetch them'));

  const kind = await pick(io, 'How should this store know who you are?', [
    { value: 'oidc', label: 'An OIDC issuer', hint: 'sign in once per machine' },
    { value: 'supabase', label: "Supabase's own auth", hint: 'email and password, or a code' },
    { value: 'service', label: 'A service key from the environment', hint: 'no sign-in; bypasses row level security' }
  ]);

  console.log('');

  if (kind === 'service') {
    warn('A service key bypasses row level security for the whole project, not just these rows.');
    note('Prefer a project that holds nothing else.');
    return null;
  }

  if (kind === 'supabase') return { type: 'supabase' };

  const issuer = await askUrl(io, 'Issuer URL', 'issuer', 'The base URL of your provider, e.g. https://id.example.com');

  return keep({ type: 'oidc', issuer, clientId: await askRequired(io, 'Client id', 'A client id', 'What you registered this CLI as with that issuer. There is no secret.') });
}

/**
 * Ask what is needed to write a config, or return null if the answer is not now
 * @returns {Promise<{project: string, provider: string, options: object, auth: object|null} | null>}
 */
export async function runWizard({ cwd, io = {} }) {
  const saved = await listStores();

  heading('Setting up @wilsoon/env');
  note('Encrypted secrets need somewhere to live. Nothing here is secret - this all gets committed.');
  console.log('');

  let picked = null;

  if (saved.length) {
    picked = await pick(io, 'Use a store you have already set up?', [...saved.map((store) => ({ value: store, label: store.name, hint: `${store.provider}${store.auth ? ' · signed in' : ''}` })), { value: null, label: 'Set up a different store' }], {
      initial: 0
    });

    console.log('');
  }

  let provider, options, auth, secrets;

  if (picked) {
    ({ provider, options, auth } = picked);
    secrets = [];
  } else {
    heading(dim('Where the encrypted files live'));
    provider = await pick(io, 'Where should encrypted secrets be stored?', PROVIDERS, { initial: 1 });
    console.log('');
    ({ options, secrets } = await optionsFor(io, provider));
    auth = await authFor(io, provider);
  }

  console.log('');
  const project = await askFor(io, 'Project name, which is its namespace in the store', path.basename(cwd));

  if (secrets.length) {
    console.log('');
    note(`This store reads its credentials from ${secrets.map((s) => cyan(s)).join(' and ')}.`);
    note('They stay out of the config on purpose, because the config is committed.');
  }

  return { project, provider, options, auth, saved: Boolean(picked) };
}

/** Offer to keep the store once it works */
export async function offerToSave({ provider, options, auth }, io = {}, { question = '  Save this store, so the next project is one question?' } = {}) {
  console.log('');

  if (!(await confirm(question, io))) return null;

  const name = (await askFor(io, 'Call it', 'default')) || 'default';
  const file = await saveStore(name, { provider, options, auth });

  note(`Saved as ${cyan(name)} in ${dim(file)}`);

  return name;
}
