import { authorize, deviceAuthorize, supportsDevice } from '../../auth/oidc.js';
import { requestOtp, signInWithPassword, verifyOtp } from '../../auth/supabase.js';
import { accessTokenFor, readCredential, writeCredential } from '../../auth/tokens.js';
import { openSession } from '../../core/session.js';
import { authFromFlags, withIssuer } from '../lib/authflags.js';
import { bold, cyan, dim, green, yellow } from '../lib/format.js';
import { ask, isInteractive, password as promptPassword, requireInteractive } from '../lib/prompt.js';
import { command, field, heading, note, outcome, warn } from '../lib/ui.js';

/** Both strategies are stored the same way */
async function storeCredential(auth, result) {
  await writeCredential(auth.issuer, {
    access_token: result.access_token,
    refresh_token: result.refresh_token,
    expiresAt: result.expiresAt ?? (result.expires_in ? Date.now() + result.expires_in * 1000 : undefined),
    sub: result.sub,
    email: result.email
  });
}

/**
 * Sign in with Supabase's own auth
 */
async function supabaseLogin(strategy, args) {
  requireInteractive('Signing in to Supabase');

  const email = args.flags.email ?? (await ask('  Email: '));

  if (args.flags.otp) {
    await requestOtp(strategy, { email });
    note(`A sign-in code is on its way to ${cyan(email)}.`);
    console.log('');

    return await verifyOtp(strategy, { email, token: (await ask('  Code:  ')).trim() });
  }

  const password = await promptPassword('  Password: ');
  return await signInWithPassword(strategy, { email, password });
}

function authConfig(session) {
  const auth = session.config.auth ?? session.config.options?.auth;

  if (!auth || (auth.type !== 'oidc' && auth.type !== 'supabase')) {
    warn('This project does not use an identity provider.');
    note('Its store is reached with credentials you already hold, so there is nothing to sign in to.');
    note(`Add an "auth" block with type "oidc" to change that.`);
    return null;
  }

  return auth;
}

/*
  Without a config there is nothing saying which issuer to sign in to - but the
  generic "run setup" advice is wrong here, because setup is very often the thing
  that just sent you over. Name the way out that does not need a config.
*/
async function openSessionOrExplain(args) {
  try {
    return await openSession({ cwd: args.flags.cwd ?? process.cwd() });
  } catch (err) {
    if (!/No wilsoon-env configuration/.test(err.message)) throw err;

    throw new Error(`There is no configuration here, so nothing says which issuer to sign in to.\n\n  Name it instead - this needs no config:\n    npx @wilsoon/env login --issuer https://issuer.example\n`);
  }
}

/**
 * The auth block, and the Supabase options a supabase strategy needs with it.
 *
 * Flags win and skip the config entirely, so signing in works before setup has
 * run - which it has to, because setup cannot write to a store behind a login.
 */
async function resolve(args) {
  const fromFlags = authFromFlags(args.flags);
  const session = fromFlags ? null : await openSessionOrExplain(args);
  const options = session?.config.options ?? {};
  const auth = fromFlags ?? authConfig(session);

  const url = args.flags.url ?? options.url ?? process.env.SUPABASE_URL;

  return { auth: withIssuer(auth, url), url, anonKey: args.flags['anon-key'] ?? options.anonKey ?? process.env.SUPABASE_ANON_KEY };
}

/**
 * Show the code and where to type it.
 */
function devicePrompt({ userCode, verificationUri, verificationUriComplete, expiresIn }) {
  console.log('');
  note('Open this page and enter the code:');
  console.log('');
  console.log(`      ${cyan(verificationUri)}`);
  console.log(`      ${bold(userCode)}`);
  console.log('');

  if (verificationUriComplete) note('A browser may have opened with the code already filled in.');
  if (expiresIn) note(`The code is good for about ${Math.round(expiresIn / 60)} minutes.`);

  note('Waiting for you to approve it...');
}

/**
 * Run whichever sign-in the auth block asks for and keep the credential.
 *
 * Separate from the command so setup can offer it in place: a store behind a
 * login cannot be set up until you are signed in, and being told to run another
 * command that then asks for a config you have not written yet is a dead end.
 *
 * @returns {Promise<object>} the credential, with `email` when the issuer said one
 */
export async function signIn(auth, args, { url, anonKey } = {}) {
  if (auth.type === 'supabase') {
    heading(`Signing in to ${cyan(auth.issuer ?? url)}`);

    const result = await supabaseLogin({ ...auth, url, anonKey }, args);
    await storeCredential(auth, result);

    return result;
  }

  const wantsDevice = args.flags.device === true || args.flags['no-browser'] === true;
  const useDevice = args.flags.browser === true ? false : wantsDevice || (await supportsDevice(auth));

  if (!useDevice && !isInteractive()) throw new Error('Signing in with a browser needs a terminal.\n\n  Use --device where the issuer supports it, or in CI set WILSOON_ENV_KEY and the credentials your store needs.\n');

  heading(`Signing in to ${cyan(auth.issuer)}`);

  const existing = await readCredential(auth.issuer);
  if (existing?.email) field('Currently', existing.email);

  const result = useDevice
    ? await deviceAuthorize(auth, { onPrompt: devicePrompt })
    : await authorize(auth, {
      onUrl: (opened) => {
        note('Approve the request in the browser window that just opened.');
        note('If it did not open, use this URL:');
        console.log(`  ${cyan(opened)}`);
        console.log('');
      }
    });

  await storeCredential(auth, result);

  return result;
}

export async function login(args) {
  const { auth, url, anonKey } = await resolve(args);

  if (!auth) return 1;

  const result = await signIn(auth, args, { url, anonKey });

  outcome({
    ok: `Signed in${result.email ? ` as ${green(result.email)}` : ''}`,
    next: [
      auth.type === 'supabase' ? 'Row level security now decides what you can see.' : 'The token only reaches your store - it never unlocks a secret',
      `Run ${command('pull')} to fetch what you can read`,
      `Run ${command('logout')} on this machine when you are done with it`
    ]
  });

  return 0;
}

export async function whoami(args) {
  const { auth, url, anonKey } = await resolve(args);

  if (!auth) return 1;

  const stored = await readCredential(auth.issuer);

  if (!stored) {
    warn(`Not signed in to ${cyan(auth.issuer)}.`);
    note(`Run ${command('login')}.`);
    return 1;
  }

  const usable = await accessTokenFor(auth.type === 'supabase' ? { ...auth, url, anonKey } : auth);

  heading(`${cyan(auth.issuer)}`);
  field('Account', stored.email ?? stored.sub ?? dim('unknown'));
  field('Token', usable ? green('valid') : yellow('expired'));
  field('Expires', stored.expiresAt ? new Date(stored.expiresAt).toLocaleString() : dim('not stated'));

  if (usable && stored.access_token !== usable) note('The stored token had expired and was refreshed just now.');

  console.log('');

  if (!usable) {
    note(`Run ${command('login')} again.`);
    return 1;
  }

  return 0;
}
