/**
 * Sign in with Supabase's own auth (GoTrue), so the store needs no privileged key.
 */

const json = { 'content-type': 'application/json', accept: 'application/json' };

function endpointsFor(auth) {
  const url = String(auth.url ?? auth.issuer ?? '').replace(/\/+$/, '');

  if (!url) throw new Error('The supabase auth strategy needs the project URL.');
  if (!auth.anonKey) throw new Error('The supabase auth strategy needs the project\'s anon key.\n\n  It is public by design - set it in options.anonKey or SUPABASE_ANON_KEY.\n');

  return { url, base: `${url}/auth/v1`, anonKey: auth.anonKey };
}

async function call(auth, path, body) {
  const { base, anonKey } = endpointsFor(auth);

  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...json, apikey: anonKey, authorization: `Bearer ${anonKey}` },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  let parsed = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Supabase auth returned something that is not JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const detail = parsed?.error_description ?? parsed?.msg ?? parsed?.message ?? parsed?.error ?? `HTTP ${response.status}`;
    throw new Error(`Supabase refused the sign-in: ${detail}`);
  }

  return parsed;
}

const shape = (tokens, url) => ({
  ...tokens,
  issuer: url,
  sub: tokens.user?.id,
  email: tokens.user?.email,
  expiresAt: tokens.expires_at ? tokens.expires_at * 1000 : tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined
});

export async function signInWithPassword(auth, { email, password }) {
  const { url } = endpointsFor(auth);
  return shape(await call(auth, '/token?grant_type=password', { email, password }), url);
}

/** Ask Supabase to email a code. Nothing is returned but the fact it was sent. */
export async function requestOtp(auth, { email }) {
  await call(auth, '/otp', { email, create_user: false });
  return true;
}

export async function verifyOtp(auth, { email, token }) {
  const { url } = endpointsFor(auth);
  return shape(await call(auth, '/verify', { email, token, type: 'email' }), url);
}

export async function refresh(auth, refreshToken) {
  const { url } = endpointsFor(auth);
  return shape(await call(auth, '/token?grant_type=refresh_token', { refresh_token: refreshToken }), url);
}
