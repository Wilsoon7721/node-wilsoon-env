import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { refresh, requestOtp, signInWithPassword, verifyOtp } from '../auth/supabase.js';
import { accessTokenFor, readCredential, writeCredential } from '../auth/tokens.js';
import { create as createSupabase } from '../providers/supabase.js';
import { loadConfig } from '../core/config.js';
import { writeFile } from 'node:fs/promises';

/*
  A GoTrue-shaped server over real HTTP.

  The point of this strategy is that it removes the privileged key, so the tests
  worth having are the ones that prove the user's own token reaches PostgREST and
  that nothing falls back to a service key when it should not.
*/
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;

let url;
let server;
let seen;
let script;

beforeAll(async () => {
  server = createServer((req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    let body = '';
    req.on('data', (c) => (body += c));

    req.on('end', () => {
      const json = (value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      const payload = body ? JSON.parse(body) : {};

      seen.push({ path: parsed.pathname, grant: parsed.searchParams.get('grant_type'), headers: req.headers, payload });

      if (script.fail) return json(script.fail.body, script.fail.status);

      if (parsed.pathname === '/auth/v1/token' || parsed.pathname === '/auth/v1/verify')
        return json({
          access_token: jwt({ sub: 'user-1', email: 'a@b.test', role: 'authenticated' }),
          refresh_token: 'refresh-2',
          expires_in: 3600,
          user: { id: 'user-1', email: 'a@b.test' }
        });

      if (parsed.pathname === '/auth/v1/otp') return json({});

      json({ msg: 'not found' }, 404);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  seen = [];
  script = {};
});

const auth = () => ({ type: 'supabase', url, issuer: url, anonKey: 'anon-key' });

describe('supabase auth', () => {
  it('needs the project url and anon key', async () => {
    await expect(signInWithPassword({ type: 'supabase' }, { email: 'a', password: 'b' })).rejects.toThrow(/project URL/);
    await expect(signInWithPassword({ type: 'supabase', url }, { email: 'a', password: 'b' })).rejects.toThrow(/anon key/);
  });

  it('exchanges a password for a token', async () => {
    const result = await signInWithPassword(auth(), { email: 'a@b.test', password: 'hunter2' });

    expect(seen[0].grant).toBe('password');
    expect(seen[0].headers.apikey).toBe('anon-key');
    expect(result.email).toBe('a@b.test');
    expect(result.sub).toBe('user-1');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('requests a code and verifies it', async () => {
    expect(await requestOtp(auth(), { email: 'a@b.test' })).toBe(true);
    expect(seen[0].path).toBe('/auth/v1/otp');

    const result = await verifyOtp(auth(), { email: 'a@b.test', token: '123456' });

    expect(seen[1].path).toBe('/auth/v1/verify');
    expect(seen[1].payload).toMatchObject({ type: 'email', token: '123456' });
    expect(result.access_token).toBeTruthy();
  });

  it('renews with the refresh grant', async () => {
    await refresh(auth(), 'refresh-1');

    expect(seen[0].grant).toBe('refresh_token');
    expect(seen[0].payload.refresh_token).toBe('refresh-1');
  });

  it('reads whichever error shape GoTrue used', async () => {
    for (const body of [{ error_description: 'bad grant' }, { msg: 'bad grant' }, { message: 'bad grant' }]) {
      script.fail = { status: 400, body };
      await expect(signInWithPassword(auth(), { email: 'a', password: 'b' })).rejects.toThrow(/bad grant/);
    }
  });
});

describe('token store', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wenv-sba-'));
    process.env.WILSOON_ENV_CREDENTIALS_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.WILSOON_ENV_CREDENTIALS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('refreshes an expired supabase token rather than giving up', async () => {
    await writeCredential(url, { access_token: 'old', refresh_token: 'refresh-1', expiresAt: Date.now() - 1000 });

    const token = await accessTokenFor(auth());

    expect(seen[0].grant).toBe('refresh_token');
    expect(token).not.toBe('old');
    expect((await readCredential(url)).refresh_token).toBe('refresh-2');
  });

  it('returns null for a strategy it cannot renew', async () => {
    await writeCredential(url, { access_token: 'old', refresh_token: 'r', expiresAt: Date.now() - 1000 });

    expect(await accessTokenFor({ type: 'nonsense', issuer: url })).toBe(null);
  });
});

describe('provider with a user token', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'wenv-sbp-'));
    process.env.WILSOON_ENV_CREDENTIALS_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.WILSOON_ENV_CREDENTIALS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('sends the user token as the bearer and the anon key as apikey', async () => {
    // Comfortably beyond the refresh skew, so this exercises the send path
    // rather than the renew path.
    await writeCredential(url, { access_token: 'user-token', expiresAt: Date.now() + 600_000 });

    let captured = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u, init) => {
      captured = init.headers;
      return new Response('[]', { status: 200 });
    };

    try {
      await createSupabase({ url, anonKey: 'anon-key', auth: { type: 'supabase', issuer: url } }).get({ project: 'p', kind: 'env', name: '.env' });
    } finally {
      globalThis.fetch = realFetch;
    }

    // RLS only works if Postgres sees the user, not the project.
    expect(captured.apikey).toBe('anon-key');
    expect(captured.authorization).toBe('Bearer user-token');
  });

  it('says to log in rather than silently falling back to the anon key', async () =>
    await expect(createSupabase({ url, anonKey: 'anon-key', auth: { type: 'supabase', issuer: url } }).get({ project: 'p', kind: 'env', name: '.env' })).rejects.toThrow(/env login/));
});

describe('config', () => {
  let dir;

  beforeEach(async () => (dir = await mkdtemp(path.join(tmpdir(), 'wenv-sbc-'))));
  afterEach(async () => await rm(dir, { recursive: true, force: true }));

  it('takes the project url as the issuer, so it is not named twice', async () => {
    await writeFile(path.join(dir, 'env.config.json'), JSON.stringify({ project: 'p', provider: 'supabase', auth: { type: 'supabase' }, options: { url: 'https://x.supabase.co', anonKey: 'k' } }));

    expect((await loadConfig(dir)).config.auth.issuer).toBe('https://x.supabase.co');
  });

  it('refuses when there is no project url to infer one from', async () => {
    const before = process.env.SUPABASE_URL;
    delete process.env.SUPABASE_URL;

    await writeFile(path.join(dir, 'env.config.json'), JSON.stringify({ project: 'p', provider: 'supabase', auth: { type: 'supabase' } }));

    try {
      await expect(loadConfig(dir)).rejects.toThrow(/no project URL/);
    } finally {
      if (before !== undefined) process.env.SUPABASE_URL = before;
    }
  });

  it('still rejects an unknown strategy', async () => {
    await writeFile(path.join(dir, 'env.config.json'), JSON.stringify({ project: 'p', provider: 'local', auth: { type: 'saml', issuer: 'https://x.test' } }));

    await expect(loadConfig(dir)).rejects.toThrow(/"oidc" or "supabase"/);
  });
});
