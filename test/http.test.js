import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeCredential } from '../auth/tokens.js';
import { seal } from '../core/crypto/envelope.js';
import { generateIdentity } from '../core/crypto/identity.js';
import { ConflictError } from '../core/provider.js';
import { checkClaims, createHandler, HttpError } from '../examples/supabase/functions/wilsoon-env/handler.js';
import { createStore } from '../examples/supabase/functions/wilsoon-env/store.js';
import { create } from '../providers/http.js';

const ENDPOINT = 'https://ref.supabase.co/functions/v1/wilsoon-env';
const auth = { type: 'oidc', issuer: 'https://id.example', clientId: 'cli' };
const ref = { project: 'demo', kind: 'env', name: '.env' };

// The same version rules store.js gets from Postgres, kept in memory.
function memoryStore() {
  const rows = new Map();
  const key = (r) => `${r.project}\0${r.kind}\0${r.name}`;

  return {
    async get(r) {
      return rows.get(key(r)) ?? null;
    },
    async put(r, { blob, version }, { ifVersion } = {}) {
      const current = rows.get(key(r));

      if (ifVersion !== undefined) {
        const actual = current?.version ?? 0n;
        if (ifVersion === 0n ? current : actual !== ifVersion) return { conflict: true, actual };
      }

      rows.set(key(r), { blob, version });
      return { conflict: false };
    },
    async list(project) {
      return [...rows]
        .filter(([k]) => k.startsWith(`${project}\0`))
        .map(([k, v]) => {
          const [, kind, name] = k.split('\0');
          return { kind, name, version: v.version };
        });
    },
    async remove(r) {
      return rows.delete(key(r));
    }
  };
}

// Stand-ins for what jose has already verified in the real function.
const TOKENS = {
  'me-token': { sub: 'me', client_id: 'cli' },
  'bob-token': { sub: 'bob', client_id: 'cli' },
  'machine-token': { sub: 'cli', client_id: 'cli', token_use: 'client' },
  'other-app-token': { sub: 'me', client_id: 'someone-else' }
};

async function verify(token) {
  const payload = TOKENS[token];
  if (!payload) throw new HttpError(401, 'invalid_token', 'bad token');

  return checkClaims(payload, { allowedSubjects: new Set(['me']), clientId: 'cli' });
}

let handle;

beforeEach(async () => {
  vi.stubEnv('WILSOON_ENV_CREDENTIALS_DIR', await mkdtemp(path.join(tmpdir(), 'wenv-http-')));
  handle = createHandler({ verify, store: memoryStore() });
  vi.stubGlobal('fetch', (url, init) => handle(new Request(url, init)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const signIn = (token = 'me-token') => writeCredential(auth.issuer, { access_token: token, expiresAt: Date.now() + 3_600_000 });
const provider = () => create({ url: ENDPOINT, auth });

function sealed(version) {
  const { publicRaw } = generateIdentity();
  return seal({ plaintext: 'A=1\n', recipients: [publicRaw], project: 'demo', name: '.env', version });
}

describe('the http provider against the reference endpoint', () => {
  it('round-trips a sealed file, with the version read from the blob itself', async () => {
    await signIn();
    const p = provider();
    const blob = sealed(5n);

    expect(await p.put(ref, blob)).toEqual({ version: 5n });

    const got = await p.get(ref);
    expect(got.version).toBe(5n);
    expect(got.blob.equals(blob)).toBe(true);

    expect(await p.list('demo')).toEqual([{ kind: 'env', name: '.env', version: 5n }]);
    expect(await p.remove(ref)).toBe(true);
    expect(await p.get(ref)).toBe(null);
  });

  it('refuses to create over a file that is already there', async () => {
    await signIn();
    const p = provider();

    await p.put(ref, sealed(1n), { ifVersion: 0n });
    await expect(p.put(ref, sealed(1n), { ifVersion: 0n })).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a stale push and reports what it found', async () => {
    await signIn();
    const p = provider();

    await p.put(ref, sealed(1n), { ifVersion: 0n });
    await p.put(ref, sealed(2n), { ifVersion: 1n });

    const stale = await p.put(ref, sealed(3n), { ifVersion: 1n }).catch((err) => err);
    expect(stale).toBeInstanceOf(ConflictError);
    expect(stale.actual).toBe(2n);
  });

  it('says to sign in when this machine holds no token', async () => await expect(provider().list('demo')).rejects.toThrow(/Not signed in to https:\/\/id\.example/));

  it('tells a signed-in stranger their subject, so they can be allowed in', async () => {
    await signIn('bob-token');
    await expect(provider().list('demo')).rejects.toThrow(/Your subject is bob/);
  });

  it('explains a wrong URL rather than reporting an empty store', async () => {
    await signIn();
    vi.stubGlobal('fetch', async () => new Response('Not Found', { status: 404 }));

    await expect(provider().get(ref)).rejects.toThrow(/Nothing answered at/);
  });

  it('needs an issuer to know whose sign-in to send', () => expect(() => create({ url: ENDPOINT })).toThrow(/needs an "auth" block/));
});

describe('the reference endpoint', () => {
  const call = (route, token, init = {}) => handle(new Request(`${ENDPOINT}${route}`, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } }));
  const put = (route, token, body) => call(route, token, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

  it('checks the token before the path, so a stranger learns nothing about the store', async () => {
    expect((await call('/demo/nonsense/x')).status).toBe(401);
    expect((await call('/demo/nonsense/x', 'me-token')).status).toBe(400);
  });

  it('refuses tokens with no person behind them', async () => expect((await call('/demo', 'machine-token')).status).toBe(403));

  it('refuses tokens issued to a different client', async () => expect((await call('/demo', 'other-app-token')).status).toBe(403));

  it('refuses a blob that is not sealed', async () => {
    const response = await put('/demo/env/.env', 'me-token', { blob: Buffer.from('hello world!').toString('base64') });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('bad_blob');
  });

  it('refuses a name that would escape the store', async () => expect((await call('/demo/env/a%2Fb', 'me-token')).status).toBe(400));

  it('refuses a blob larger than it accepts', async () => expect((await put('/demo/env/.env', 'me-token', { blob: 'A'.repeat(2 * 1024 * 1024) })).status).toBe(413));

  it('does not leak what went wrong inside', async () => {
    handle = createHandler({
      verify,
      store: {
        list: async () => {
          throw new Error('connection string with a password in it');
        }
      }
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await call('/demo', 'me-token');

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('password');
  });
});

describe('the reference store over PostgREST', () => {
  const blobsRef = { project: 'demo', kind: 'env', name: '.env' };

  it('reports a conflict when the conditional update matches no row', async () => {
    const seen = [];
    const store = createStore({
      url: 'https://ref.supabase.co',
      serviceKey: 'service',
      fetch: async (url, init = {}) => {
        seen.push({ url, method: init.method ?? 'GET' });
        return new Response(init.method === 'PATCH' ? '[]' : JSON.stringify([{ blob: 'x', version: 7 }]), { status: 200 });
      }
    });

    await expect(store.put(blobsRef, { blob: 'x', version: 8n }, { ifVersion: 6n })).resolves.toEqual({ conflict: true, actual: 7n });
    expect(seen[0]).toMatchObject({ method: 'PATCH' });
    expect(seen[0].url).toContain('version=eq.6');
  });

  it('treats a duplicate insert as a conflict', async () => {
    const store = createStore({
      url: 'https://ref.supabase.co',
      serviceKey: 'service',
      fetch: async (url, init = {}) => (init.method === 'POST' ? new Response('', { status: 409 }) : new Response(JSON.stringify([{ blob: 'x', version: 3 }]), { status: 200 }))
    });

    await expect(store.put(blobsRef, { blob: 'x', version: 1n }, { ifVersion: 0n })).resolves.toEqual({ conflict: true, actual: 3n });
  });

  it('names the schema on reads and writes, as PostgREST requires outside public', async () => {
    const headers = [];
    const store = createStore({
      url: 'https://ref.supabase.co',
      serviceKey: 'service',
      schema: '@wilsoon/env',
      fetch: async (url, init = {}) => {
        headers.push(init.headers);
        return new Response('[]', { status: 200 });
      }
    });

    await store.list('demo');
    await store.remove(blobsRef);

    expect(headers[0]['accept-profile']).toBe('@wilsoon/env');
    expect(headers[1]['content-profile']).toBe('@wilsoon/env');
  });
});
