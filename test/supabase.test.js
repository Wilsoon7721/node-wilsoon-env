import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { create as createSupabase } from '../providers/supabase.js';
import { ConflictError } from '../core/provider.js';
import { writeCredential } from '../auth/tokens.js';
import { generateIdentity } from '../core/crypto/identity.js';
import { seal } from '../core/crypto/envelope.js';

/*
  A PostgREST-shaped server over real HTTP, backed by an array of rows. The point
  is the compare-and-swap: `PATCH ...&version=eq.N` must match nothing once the
  row has moved on, which is what makes this the only adapter so far with a
  genuine atomic CAS.
*/
const me = generateIdentity();
const ref = { project: 'demo', kind: 'env', name: '.env.production' };
const blobAt = (version) => seal({ plaintext: 'A=1\n', recipients: [me.publicRaw], project: ref.project, name: ref.name, version });

let url;
let server;
let rows;
let requests;
let deny;

const matches = (row, params) =>
  ['project', 'kind', 'name'].every((f) => !params.has(f) || params.get(f) === `eq.${row[f]}`) && (!params.has('version') || params.get('version') === `eq.${row.version}`);

beforeAll(async () => {
  server = createServer((req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const params = parsed.searchParams;

    let body = '';
    req.on('data', (c) => (body += c));

    req.on('end', () => {
      requests.push({ method: req.method, path: parsed.pathname, params: Object.fromEntries(params), headers: req.headers });

      const json = (value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

      if (deny) return json({ message: 'permission denied' }, deny);

      if (req.method === 'GET') return json(rows.filter((r) => matches(r, params)));

      if (req.method === 'POST') {
        const incoming = JSON.parse(body);
        const clash = rows.find((r) => r.project === incoming.project && r.kind === incoming.kind && r.name === incoming.name);

        if (clash) return json({ message: 'duplicate key value violates unique constraint' }, 409);

        rows.push(incoming);
        return json([incoming], 201);
      }

      if (req.method === 'PATCH') {
        const target = rows.filter((r) => matches(r, params));
        const patch = JSON.parse(body);

        for (const row of target) Object.assign(row, patch);

        return json(target);
      }

      if (req.method === 'DELETE') {
        const removed = rows.filter((r) => matches(r, params));
        rows = rows.filter((r) => !removed.includes(r));
        return json(removed);
      }

      json({ message: 'unsupported' }, 400);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  rows = [];
  requests = [];
  deny = null;
});

const anon = () => createSupabase({ url, anonKey: 'anon-key' });
const service = () => createSupabase({ url, serviceKey: 'service-key' });

describe('supabase provider', () => {
  it('needs a url and a key', () => {
    expect(() => createSupabase({ anonKey: 'a' })).toThrow(/"url"/);
    expect(() => createSupabase({ url })).toThrow(/anonKey|serviceKey/);
  });

  it('sends the apikey and a bearer token', async () => {
    await service().get(ref);

    expect(requests[0].headers.apikey).toBe('service-key');
    expect(requests[0].headers.authorization).toBe('Bearer service-key');
  });

  it('returns null for a row that is not there', async () => {
    expect(await service().get(ref)).toBe(null);
  });

  it('round-trips a blob through base64', async () => {
    const db = service();
    const blob = blobAt(1);

    expect((await db.put(ref, blob)).version).toBe(1n);

    const got = await db.get(ref);
    expect(got.blob.equals(blob)).toBe(true);
    expect(got.version).toBe(1n);
  });

  it('updates in place rather than inserting a second row', async () => {
    const db = service();

    await db.put(ref, blobAt(1));
    await db.put(ref, blobAt(2), { ifVersion: 1 });

    expect(rows).toHaveLength(1);
    expect((await db.get(ref)).version).toBe(2n);
  });

  it('lets Postgres do the compare-and-swap', async () => {
    const db = service();
    await db.put(ref, blobAt(1));

    await expect(db.put(ref, blobAt(2), { ifVersion: 5 })).rejects.toThrow(ConflictError);

    // The predicate went to the database, not into a read-then-write in the client.
    const patch = requests.filter((r) => r.method === 'PATCH').at(-1);
    expect(patch.params.version).toBe('eq.5');

    expect(db.atomicCas).toBe(true);
  });

  it('reports a conflict when a first write races another', async () => {
    const db = service();
    rows.push({ project: 'demo', kind: 'env', name: '.env.production', version: 9, blob: blobAt(9).toString('base64') });

    await expect(db.put(ref, blobAt(1), { ifVersion: 0 })).rejects.toThrow(ConflictError);
  });

  it('lists a project', async () => {
    const db = service();
    await db.put(ref, blobAt(4));
    await db.put({ ...ref, name: '.env.local' }, blobAt(2));

    expect(await db.list('demo')).toEqual([
      { kind: 'env', name: '.env.local', version: 2n },
      { kind: 'env', name: '.env.production', version: 4n }
    ]);
  });

  it('removes, reporting whether a row was there', async () => {
    const db = service();
    await db.put(ref, blobAt(1));

    expect(await db.remove(ref)).toBe(true);
    expect(await db.remove(ref)).toBe(false);
  });

  it('blames sign-in or row level security for a 401', async () => {
    deny = 401;

    await expect(service().get(ref)).rejects.toThrow(/row level security|not signed in/i);
  });
});

describe('supabase with an identity provider', () => {
  let dir;

  const auth = { type: 'oidc', issuer: 'https://id.example.test' };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wenv-sb-'));
    process.env.WILSOON_ENV_CREDENTIALS_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.WILSOON_ENV_CREDENTIALS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('sends the identity provider token as the bearer, with the anon key as apikey', async () => {
    await writeCredential(auth.issuer, { access_token: 'idp-token', expiresAt: Date.now() + 600_000 });

    await createSupabase({ url, anonKey: 'anon-key', auth }).get(ref);

    // This is what makes RLS work: Postgres sees the user, not the project.
    expect(requests[0].headers.apikey).toBe('anon-key');
    expect(requests[0].headers.authorization).toBe('Bearer idp-token');
  });

  it('says to log in when there is no token', async () => {
    await expect(createSupabase({ url, anonKey: 'anon-key', auth }).get(ref)).rejects.toThrow(/env login/);
  });

  it('prefers a service key and never consults the identity provider', async () => {
    await createSupabase({ url, anonKey: 'anon-key', serviceKey: 'service-key', auth }).get(ref);

    expect(requests[0].headers.authorization).toBe('Bearer service-key');
  });
});
