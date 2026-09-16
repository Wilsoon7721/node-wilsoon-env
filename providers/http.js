import { accessTokenFor } from '../auth/tokens.js';
import { assertRef, ConflictError } from '../core/provider.js';

/*
  Any endpoint that speaks the protocol in examples/supabase, authorised by the
  token `login` keeps. This is how an identity provider that no store trusts can
  still gate one: the endpoint checks the token itself, then does the storage
  with credentials that never leave it.
*/

function refused(status, body, what, target) {
  const reason = body?.error ? `\n\n  ${body.error}\n` : '';

  if (status === 401) return new Error(`The endpoint did not accept your sign-in while ${what}.${reason}\n  Run "npx @wilsoon/env login" to sign in again.\n`);

  if (status === 403) {
    const hint = body?.subject ? `\n  Your subject is ${body.subject}. Add it to the endpoint's WENV_ALLOWED_SUBJECTS to let this account in.\n` : '';
    return new Error(`The endpoint knows who you are, but does not let you in while ${what}.${reason}${hint}`);
  }

  if (status === 404) return new Error(`Nothing answered at ${target} while ${what}.\n\n  Check the endpoint URL, and that the function is deployed.\n`);

  return new Error(`The endpoint refused ${what}: HTTP ${status}.${reason}`);
}

export function create(options = {}) {
  const url = options.url;
  const auth = options.auth ?? null;

  if (!url) throw new Error('The http provider needs a "url" in its options: the endpoint to talk to.');
  if (!auth?.issuer)
    throw new Error('The http provider needs an "auth" block with an issuer, because the endpoint decides who you are from your sign-in.\n\n  Run setup again, or pass --auth oidc --issuer <url> --client-id <id> with --unattended.\n');

  const base = String(url).replace(/\/+$/, '');

  const address = (ref) => {
    assertRef(ref);
    return `${base}/${encodeURIComponent(ref.project)}/${ref.kind}/${encodeURIComponent(ref.name)}`;
  };

  async function call(target, what, { method = 'GET', body } = {}) {
    const token = await accessTokenFor(auth);
    if (!token) throw new Error(`Not signed in to ${auth.issuer}.\n\n  Run "npx @wilsoon/env login" first.\n`);

    const response = await fetch(target, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });

    const parsed = await response.json().catch(() => null);

    return { response, body: parsed, fail: () => refused(response.status, parsed, what, target) };
  }

  return {
    name: 'http',
    atomicCas: true,
    describe: () => {
      const { host, pathname } = new URL(base);
      return `${host}${pathname}`;
    },

    async get(ref) {
      const { response, body, fail } = await call(address(ref), `reading ${ref.name}`);

      if (response.status === 404 && body?.code === 'not_found') return null;
      if (!response.ok) throw fail();

      return { blob: Buffer.from(body.blob, 'base64'), version: BigInt(body.version) };
    },

    async put(ref, blob, { ifVersion } = {}) {
      const { response, body, fail } = await call(address(ref), `writing ${ref.name}`, {
        method: 'PUT',
        body: { blob: blob.toString('base64'), ...(ifVersion === undefined ? {} : { ifVersion: String(ifVersion) }) }
      });

      if (response.status === 409) throw new ConflictError(BigInt(body?.expected ?? ifVersion ?? 0), BigInt(body?.actual ?? 0));
      if (!response.ok) throw fail();

      return { version: BigInt(body.version) };
    },

    async list(project) {
      const { response, body, fail } = await call(`${base}/${encodeURIComponent(project)}`, `listing ${project}`);

      if (!response.ok) throw fail();

      return body.entries.map((e) => ({ kind: e.kind, name: e.name, version: BigInt(e.version) })).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    },

    async remove(ref) {
      const { response, body, fail } = await call(address(ref), `deleting ${ref.name}`, { method: 'DELETE' });

      if (!response.ok) throw fail();

      return body.removed === true;
    }
  };
}
