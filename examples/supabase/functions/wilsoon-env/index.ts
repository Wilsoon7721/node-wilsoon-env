/*
  Supabase Edge Function entry point. The protocol and who is allowed in live in
  handler.js, the rows in store.js; this file only wires them to Deno, the
  issuer's keys and the function's secrets.

  Deploy with Supabase's own JWT check off, because this checks yours instead:
    supabase functions deploy wilsoon-env --no-verify-jwt
*/

import { createRemoteJWKSet, jwtVerify } from 'npm:jose@6';

import { checkClaims, createHandler, HttpError } from './handler.js';
import { createStore } from './store.js';

function secret(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret ${name}. Set it with: supabase secrets set ${name}=...`);

  return value;
}

const issuer = secret('WENV_ISSUER').replace(/\/+$/, '');
const audience = secret('WENV_AUDIENCE');
const clientId = Deno.env.get('WENV_CLIENT_ID') || undefined;
const allowedSubjects = new Set(
  secret('WENV_ALLOWED_SUBJECTS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

// Discovery rather than a guessed path, so an issuer that moves its keys keeps working.
const discovery = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
const keys = createRemoteJWKSet(new URL(discovery.jwks_uri));

async function verify(token: string) {
  let payload: Record<string, unknown>;

  try {
    ({ payload } = await jwtVerify(token, keys, { issuer, audience }));
  } catch {
    throw new HttpError(401, 'invalid_token', 'That token is not valid here: it has expired, or was not issued for this endpoint.');
  }

  return checkClaims(payload, { allowedSubjects, clientId });
}

const store = createStore({
  url: secret('SUPABASE_URL'),
  serviceKey: secret('SUPABASE_SERVICE_ROLE_KEY'),
  table: Deno.env.get('WENV_TABLE') ?? 'wilsoon_env',
  schema: Deno.env.get('WENV_SCHEMA') ?? null
});

Deno.serve(createHandler({ verify, store, name: 'wilsoon-env' }));
