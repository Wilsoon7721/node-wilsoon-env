import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { create as createKv } from '../providers/kv.js';
import { create as createSm } from '../providers/aws-sm.js';
import { ConflictError, resolveProvider } from '../core/provider.js';
import { generateIdentity } from '../core/crypto/identity.js';
import { seal } from '../core/crypto/envelope.js';

const me = generateIdentity();
const ref = { project: 'demo', kind: 'env', name: '.env.production' };
const blobAt = (version) => seal({ plaintext: 'A=1\n', recipients: [me.publicRaw], project: ref.project, name: ref.name, version });

let requests;

afterEach(() => vi.unstubAllGlobals());

describe('cloudflare kv', () => {
  const options = { accountId: 'acct', namespaceId: 'ns0123456789', apiToken: 'tok' };

  let store;

  beforeEach(() => {
    store = new Map();
    requests = [];

    vi.stubGlobal('fetch', async (url, init = {}) => {
      const u = new URL(url);
      requests.push({ method: init.method ?? 'GET', url: u, headers: init.headers, body: init.body });

      const values = u.pathname.match(/\/values\/(.+)$/);

      if (values) {
        const key = decodeURIComponent(values[1]);

        if ((init.method ?? 'GET') === 'GET') {
          const entry = store.get(key);
          return entry ? new Response(entry.blob, { status: 200 }) : new Response('{"success":false}', { status: 404 });
        }

        if (init.method === 'PUT') {
          const value = Buffer.from(await init.body.get('value').arrayBuffer());
          store.set(key, { blob: value, metadata: JSON.parse(init.body.get('metadata')) });
          return new Response('{"success":true}', { status: 200 });
        }

        if (init.method === 'DELETE') {
          return new Response('{"success":true}', { status: store.delete(key) ? 200 : 404 });
        }
      }

      if (u.pathname.endsWith('/keys')) {
        const prefix = u.searchParams.get('prefix');
        const result = [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata }));
        return new Response(JSON.stringify({ success: true, result, result_info: {} }), { status: 200 });
      }

      return new Response('{"success":false}', { status: 400 });
    });
  });

  it('needs an account, a namespace and a token', () => {
    expect(() => createKv({ namespaceId: 'n', apiToken: 't' })).toThrow(/accountId/);
    expect(() => createKv({ accountId: 'a', apiToken: 't' })).toThrow(/namespaceId/);
    expect(() => createKv({ accountId: 'a', namespaceId: 'n' })).toThrow(/API token/);
  });

  it('authenticates with a bearer token', async () => {
    await createKv(options).get(ref);

    expect(requests[0].headers.authorization).toBe('Bearer tok');
  });

  it('returns null for a key that is not there', async () => {
    expect(await createKv(options).get(ref)).toBe(null);
  });

  it('round-trips a blob', async () => {
    const kv = createKv(options);
    const blob = blobAt(4);

    expect((await kv.put(ref, blob)).version).toBe(4n);

    const got = await kv.get(ref);
    expect(got.blob.equals(blob)).toBe(true);
    expect(got.version).toBe(4n);
  });

  it('reads versions from listing metadata, without a request per key', async () => {
    const kv = createKv(options);
    await kv.put(ref, blobAt(2));
    await kv.put({ ...ref, name: '.env.local' }, blobAt(5));

    requests = [];
    const listed = await kv.list('demo');

    expect(listed).toEqual([
      { kind: 'env', name: '.env.local', version: 5n },
      { kind: 'env', name: '.env.production', version: 2n }
    ]);

    // One listing call, no per-key fetches.
    expect(requests).toHaveLength(1);
  });

  it('detects a stale write, without claiming to do so atomically', async () => {
    const kv = createKv(options);
    await kv.put(ref, blobAt(1));

    await expect(kv.put(ref, blobAt(2), { ifVersion: 0 })).rejects.toThrow(ConflictError);
    await expect(kv.put(ref, blobAt(2), { ifVersion: 1 })).resolves.toMatchObject({ version: 2n });

    expect(kv.atomicCas).toBe(false);
  });

  it('removes, reporting whether anything was there', async () => {
    const kv = createKv(options);
    await kv.put(ref, blobAt(1));

    expect(await kv.remove(ref)).toBe(true);
    expect(await kv.remove(ref)).toBe(false);
  });
});

describe('aws secrets manager', () => {
  const options = { region: 'eu-west-1', accessKeyId: 'A', secretAccessKey: 'B' };

  let secrets;

  const respond = (payload, status = 200, errorType) =>
    new Response(JSON.stringify(payload), { status, headers: errorType ? { 'x-amzn-errortype': `${errorType}:` } : {} });

  beforeEach(() => {
    secrets = new Map();
    requests = [];

    vi.stubGlobal('fetch', async (url, init) => {
      const action = init.headers['x-amz-target'].split('.').pop();
      const payload = JSON.parse(init.body);
      requests.push({ action, payload, headers: init.headers });

      if (action === 'GetSecretValue') {
        const found = secrets.get(payload.SecretId);
        return found ? respond({ SecretBinary: found }) : respond({ message: 'not found' }, 400, 'ResourceNotFoundException');
      }

      if (action === 'PutSecretValue') {
        if (!secrets.has(payload.SecretId)) return respond({ message: 'not found' }, 400, 'ResourceNotFoundException');
        secrets.set(payload.SecretId, payload.SecretBinary);
        return respond({});
      }

      if (action === 'CreateSecret') {
        secrets.set(payload.Name, payload.SecretBinary);
        return respond({});
      }

      if (action === 'ListSecrets') {
        return respond({ SecretList: [...secrets.keys()].map((Name) => ({ Name })) });
      }

      if (action === 'DeleteSecret') {
        return secrets.delete(payload.SecretId) ? respond({}) : respond({ message: 'not found' }, 400, 'ResourceNotFoundException');
      }

      return respond({ message: 'bad' }, 400, 'ValidationException');
    });
  });

  it('signs with SigV4 for the secretsmanager service', async () => {
    await createSm(options).get(ref);

    expect(requests[0].headers.authorization).toMatch(/AWS4-HMAC-SHA256 Credential=A\/\d{8}\/eu-west-1\/secretsmanager\/aws4_request/);
    expect(requests[0].headers['x-amz-target']).toBe('secretsmanager.GetSecretValue');
  });

  it('returns null for a secret that does not exist', async () => {
    expect(await createSm(options).get(ref)).toBe(null);
  });

  it('creates on first write and updates after', async () => {
    const sm = createSm(options);

    await sm.put(ref, blobAt(1));
    expect(requests.map((r) => r.action)).toContain('CreateSecret');

    requests = [];
    await sm.put(ref, blobAt(2));
    expect(requests.map((r) => r.action)).toContain('PutSecretValue');
    expect(requests.map((r) => r.action)).not.toContain('CreateSecret');
  });

  it('round-trips a blob through base64', async () => {
    const sm = createSm(options);
    const blob = blobAt(7);

    await sm.put(ref, blob);

    const got = await sm.get(ref);
    expect(got.blob.equals(blob)).toBe(true);
    expect(got.version).toBe(7n);
  });

  it('refuses a value over the 64KB limit, naming the alternative', async () => {
    const sm = createSm(options);
    const big = Buffer.alloc(70000);

    await expect(sm.put({ ...ref, kind: 'identity' }, big)).rejects.toThrow(/64|65536/);
    await expect(sm.put({ ...ref, kind: 'identity' }, big)).rejects.toThrow(/s3 provider/);
  });

  it('namespaces secrets under a prefix', async () => {
    await createSm(options).get(ref);

    expect(requests[0].payload.SecretId).toBe('wenv/demo/env/.env.production');
  });

  it('lists what it holds', async () => {
    const sm = createSm(options);
    await sm.put(ref, blobAt(3));
    await sm.put({ ...ref, name: '.env.local' }, blobAt(1));

    expect(await sm.list('demo')).toEqual([
      { kind: 'env', name: '.env.local', version: 1n },
      { kind: 'env', name: '.env.production', version: 3n }
    ]);
  });

  it('detects a stale write', async () => {
    const sm = createSm(options);
    await sm.put(ref, blobAt(1));

    await expect(sm.put(ref, blobAt(2), { ifVersion: 0 })).rejects.toThrow(ConflictError);
    expect(sm.atomicCas).toBe(false);
  });

  it('explains a permission failure in terms of the actions needed', async () => {
    vi.stubGlobal('fetch', async () => respond({ message: 'denied' }, 403, 'AccessDeniedException'));

    await expect(createSm(options).get(ref)).rejects.toThrow(/secretsmanager:GetSecretValue/);
  });

  it('removes, reporting whether anything was there', async () => {
    const sm = createSm(options);
    await sm.put(ref, blobAt(1));

    expect(await sm.remove(ref)).toBe(true);
    expect(await sm.remove(ref)).toBe(false);
  });
});

describe('registration', () => {
  it('resolves both as built in, with no driver to install', async () => {
    const kv = await resolveProvider({ provider: 'kv', options: { accountId: 'a', namespaceId: 'n', apiToken: 't' } }, '.');
    expect(kv.name).toBe('kv');

    const sm = await resolveProvider({ provider: 'aws', options: { accessKeyId: 'A', secretAccessKey: 'B' } }, '.');
    expect(sm.name).toBe('aws');
  });

  it('resolves supabase without a driver, since it speaks PostgREST directly', async () => {
    const db = await resolveProvider({ provider: 'supabase', options: { url: 'https://x.supabase.co', anonKey: 'k' } }, '.');
    expect(db.name).toBe('supabase');
  });

  it('checks mongodb config before reaching for the driver', async () => {
    await expect(resolveProvider({ provider: 'mongodb', options: {} }, '.')).rejects.toThrow(/needs a "uri"/);
  });

  /*
    This used to assert the "npm i mongodb" message by exercising the real
    missing-peer path, which worked only while the driver was absent. It is now a
    devDependency so the tests can run against a real server, which makes that
    path unreachable here - and left as it was, the test hung trying to reach
    localhost:27017 rather than failing.

    What is still worth pinning is that resolution does not connect: a provider
    is constructed lazily, so a bad URI surfaces on first use rather than at
    config load.
  */
  it('resolves mongodb without connecting', async () => {
    const db = await resolveProvider({ provider: 'mongodb', options: { uri: 'mongodb://127.0.0.1:27017' } }, '.');

    expect(db.name).toBe('mongodb');
    expect(db.atomicCas).toBe(true);
    expect(typeof db.close).toBe('function');
  });

  it('lists every provider when the name is unknown', async () => {
    await expect(resolveProvider({ provider: 'nope', options: {} }, '.')).rejects.toThrow(/local, s3, supabase, kv, aws, mongodb/);
  });
});
