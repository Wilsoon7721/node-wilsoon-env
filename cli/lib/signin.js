import { accessTokenFor, readCredential } from '../../auth/tokens.js';
import { signIn } from '../commands/login.js';
import { withIssuer } from './authflags.js';
import { cyan } from './format.js';
import { confirm, isInteractive } from './prompt.js';
import { command, note } from './ui.js';

export async function ensureSignedIn(config, args) {
  const url = config.options?.url ?? process.env.SUPABASE_URL;
  const anonKey = config.options?.anonKey ?? process.env.SUPABASE_ANON_KEY;
  const auth = withIssuer(config.auth ?? null, url);

  if (!auth || !isInteractive()) return;
  if (config.provider === 'supabase' && (config.options?.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY)) return;

  const strategy = auth.type === 'supabase' ? { ...auth, url, anonKey } : auth;

  if (await accessTokenFor(strategy)) return;

  const stored = await readCredential(auth.issuer);

  console.log('');
  note(stored ? `Your sign-in to ${cyan(auth.issuer)} has expired.` : `This store works out who you are through ${cyan(auth.issuer)}, and this machine has not signed in yet.`);

  if (!(await confirm('  Sign in now?'))) {
    note(`Do it later with ${command(`login --issuer ${auth.issuer}`)}.`);
    return;
  }

  await signIn(auth, args, { url, anonKey });
}
