/*
  An `auth` block describes how to reach the store *as a person*, which only
  matters for a store that has a notion of people - today that is Supabase,
  where row level security evaluates auth.uid() per request. Every other
  provider takes a machine credential and has nothing to sign in to.

  Both setup and login build one from flags: setup to write it, login so it can
  run before any config exists. Without that, the two commands each needed the
  other to have gone first on a store behind a login.
*/

const FIELDS = [
  ['issuer', 'issuer'],
  ['client-id', 'clientId'],
  ['scope', 'scope']
];

export const AUTH_TYPES = ['oidc', 'supabase'];

/**
 * Tidy an issuer into something that can actually be fetched.
 *
 * A bare host is what people type, and taking it literally only shows up much
 * later as a failed discovery against a relative URL. Plain http is refused
 * outside loopback: the token this fetches is a bearer credential.
 */
export function normaliseIssuer(value) {
  const text = String(value ?? '').trim();

  if (!text) throw new Error('An issuer is needed.');

  let url;

  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error(`"${text}" is not a URL.\n\n  Issuers look like https://id.example.com\n`);
  }

  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';

  if (url.protocol !== 'https:' && !loopback) throw new Error(`Refusing a plain http issuer (${url.origin}).\n\n  The token it hands back is a bearer credential, so the connection has to be https.\n`);

  return url.origin + url.pathname.replace(/\/+$/, '');
}

/**
 * @param {object} flags parsed CLI flags
 * @param {object|null} prior an existing auth block to build on
 * @returns {object|null} the auth block, or null when nothing asked for one
 */
export function authFromFlags(flags, prior = null) {
  if (flags.auth === true) throw new Error(`--auth needs a value: ${AUTH_TYPES.join(' or ')}.`);

  const named = FIELDS.some(([flag]) => typeof flags[flag] === 'string');
  const type = typeof flags.auth === 'string' ? flags.auth : named ? (prior?.type ?? 'oidc') : prior?.type;

  if (!type) return prior;

  if (!AUTH_TYPES.includes(type)) throw new Error(`Unknown auth type "${type}".\n\n  Use ${AUTH_TYPES.map((t) => `--auth ${t}`).join(' or ')}.\n`);

  const auth = { ...(prior ?? {}), type };

  for (const [flag, key] of FIELDS) if (typeof flags[flag] === 'string') auth[key] = flags[flag];

  if (auth.issuer) auth.issuer = normaliseIssuer(auth.issuer);

  if (type === 'oidc' && !auth.issuer) throw new Error('An oidc auth block needs an issuer.\n\n  Add --issuer https://issuer.example\n');

  return auth;
}

/**
 * Credentials are filed by issuer, and issuerKey(undefined) is the empty string
 * - so an auth block with no issuer would have every Supabase project on the
 * machine sharing one slot. Supabase's issuer is its project URL.
 */
export function withIssuer(auth, url) {
  if (!auth || auth.issuer) return auth;

  if (auth.type === 'supabase' && url) return { ...auth, issuer: String(url).replace(/\/+$/, '') };

  return auth;
}
