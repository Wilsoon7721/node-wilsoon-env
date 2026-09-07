import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { authorize, challengeFor, createVerifier, describeToken, endpoints, listen } from '../auth/oidc.js';
import { accessTokenFor, clearCredential, readCredential, writeCredential } from '../auth/tokens.js';
import { login, whoami } from '../cli/commands/login.js';

/*
  A real HTTP issuer, not a stubbed fetch. The browser leg is the one thing
  injected: `open` is handed a function that fetches the authorize URL, which is
  exactly what a browser would do, and the redirect lands on the loopback
  listener the CLI actually bound.
*/
const base64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (claims) => `${base64url({ alg: 'RS256' })}.${base64url(claims)}.signature`;

let issuer;
let server;
let seen;

beforeAll(async () => {
  seen = [];

  server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1`);
    const json = (body, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

    if (url.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: `${issuer}/api/authorize`, token_endpoint: `${issuer}/api/token` });

    if (url.pathname === '/api/authorize') {
      seen.push({ kind: 'authorize', params: Object.fromEntries(url.searchParams) });

      // Stand in for the user approving: redirect straight back to loopback.
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'the-code');
      back.searchParams.set('state', url.searchParams.get('state'));

      return res.writeHead(302, { location: back.toString() }).end();
    }

    if (url.pathname === '/api/token') {
      let body = '';
      req.on('data', (c) => (body += c));

      return void req.on('end', () => {
        const params = Object.fromEntries(new URLSearchParams(body));
        seen.push({ kind: 'token', params });

        if (params.grant_type === 'refresh_token') {
          if (params.refresh_token !== 'the-refresh') return json({ error: 'invalid_grant' }, 400);

          return json({ access_token: jwt({ sub: 'user-1', email: 'wilson@example.test', exp: Math.floor(Date.now() / 1000) + 3600 }), expires_in: 3600 });
        }

        // PKCE: the verifier must hash to the challenge the authorize leg carried.
        const authorizeCall = seen.find((s) => s.kind === 'authorize');
        if (challengeFor(params.code_verifier) !== authorizeCall.params.code_challenge) return json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }, 400);

        if (params.code !== 'the-code') return json({ error: 'invalid_grant' }, 400);

        return json({
          access_token: jwt({ sub: 'user-1', email: 'wilson@example.test', exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: 'the-refresh',
          expires_in: 3600
        });
      });
    }

    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server.close());

const auth = () => ({ type: 'oidc', issuer });

// A browser: follow the URL, let the 302 land on the loopback listener.
const browser = (url) => {
  fetch(url, { redirect: 'follow' }).catch(() => {});
  return true;
};

let dir;
let logs;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wenv-oidc-'));
  process.env.WILSOON_ENV_CREDENTIALS_DIR = dir;
  seen = [];

  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.WILSOON_ENV_CREDENTIALS_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('pkce', () => {
  it('produces a challenge the issuer can verify', () => {
    const verifier = createVerifier();

    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challengeFor(verifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challengeFor(verifier)).not.toBe(verifier);
  });

  it('gives a different verifier every time', () => expect(createVerifier()).not.toBe(createVerifier()));
});

describe('discovery', () => {
  it('finds the endpoints from the well-known document', async () => {
    const found = await endpoints(auth());

    expect(found.authorization).toBe(`${issuer}/api/authorize`);
    expect(found.token).toBe(`${issuer}/api/token`);
  });

  it('prefers explicit endpoints without asking the network', async () => {
    const found = await endpoints({ issuer: 'https://nowhere.test', authorizationEndpoint: 'https://a.test/auth', tokenEndpoint: 'https://a.test/token' });

    expect(found.token).toBe('https://a.test/token');
  });

  it('explains what to configure when there is no discovery document', async () => await expect(endpoints({ issuer: `${issuer}/nothing-here` })).rejects.toThrow(/authorizationEndpoint/));
});

describe('the loopback listener', () => {
  it('rejects a callback carrying the wrong state', async () => {
    const listener = await listen({ state: 'expected' });

    try {
      const waiting = listener.waitForCode();
      await fetch(`${listener.redirectUri}?code=x&state=forged`);

      await expect(waiting).rejects.toThrow(/wrong state/);
    } finally {
      listener.close();
    }
  });

  it('surfaces an error the issuer sends back', async () => {
    const listener = await listen({ state: 's' });

    try {
      const waiting = listener.waitForCode();
      await fetch(`${listener.redirectUri}?error=access_denied&error_description=nope&state=s`);

      await expect(waiting).rejects.toThrow(/access_denied.*nope/s);
    } finally {
      listener.close();
    }
  });

  it('binds a port before anything is opened', async () => {
    const listener = await listen({ state: 's' });

    try {
      expect(listener.port).toBeGreaterThan(0);
      expect(listener.redirectUri).toBe(`http://127.0.0.1:${listener.port}/callback`);
    } finally {
      listener.close();
    }
  });
});

describe('the full flow', () => {
  it('exchanges a code for a token, proving possession of the verifier', async () => {
    const result = await authorize(auth(), { open: browser });

    expect(result.access_token).toBeTruthy();
    expect(result.email).toBe('wilson@example.test');

    const authorizeCall = seen.find((s) => s.kind === 'authorize');
    expect(authorizeCall.params.code_challenge_method).toBe('S256');
    expect(authorizeCall.params.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // No client secret is sent, because a published package cannot hold one.
    const tokenCall = seen.find((s) => s.kind === 'token');
    expect(tokenCall.params.client_secret).toBeUndefined();
    expect(tokenCall.params.code_verifier).toBeTruthy();
  });

  it('is refused when the verifier does not match the challenge', async () => {
    /*
      Send the issuer a challenge belonging to a different verifier, so the one
      the CLI later proves possession of cannot match. This is the attack PKCE
      exists to stop: an intercepted code is worthless without the verifier that
      never left the CLI.
    */
    const spoiled = authorize(auth(), {
      open: (url) => {
        const tampered = new URL(url);
        tampered.searchParams.set('code_challenge', challengeFor(createVerifier()));
        return browser(tampered.toString());
      }
    });

    await expect(spoiled).rejects.toThrow(/PKCE mismatch/);
  });
});

describe('stored credentials', () => {
  it('round-trips, and is scoped by issuer', async () => {
    await writeCredential(issuer, { access_token: 'a', email: 'x@y.test' });
    await writeCredential('https://other.test', { access_token: 'b' });

    expect((await readCredential(issuer)).email).toBe('x@y.test');
    expect((await readCredential('https://other.test')).access_token).toBe('b');

    expect(await clearCredential(issuer)).toBe(true);
    expect(await readCredential(issuer)).toBe(null);
    expect(await readCredential('https://other.test')).toBeTruthy();
  });

  it('returns a token that is still valid without contacting the issuer', async () => {
    await writeCredential(issuer, { access_token: 'still-good', expiresAt: Date.now() + 600_000 });

    seen = [];
    expect(await accessTokenFor(auth())).toBe('still-good');
    expect(seen).toHaveLength(0);
  });

  it('refreshes an expired token and keeps the refresh token', async () => {
    await writeCredential(issuer, { access_token: 'stale', refresh_token: 'the-refresh', expiresAt: Date.now() - 1000 });

    const token = await accessTokenFor(auth());

    expect(token).not.toBe('stale');
    expect(describeToken(token).email).toBe('wilson@example.test');

    // A non-rotating issuer sends no new refresh token; the old one must survive.
    expect((await readCredential(issuer)).refresh_token).toBe('the-refresh');
  });

  it('returns null rather than throwing when the refresh is rejected', async () => {
    await writeCredential(issuer, { access_token: 'stale', refresh_token: 'wrong', expiresAt: Date.now() - 1000 });

    expect(await accessTokenFor(auth())).toBe(null);
  });

  it('returns null when nothing is stored at all', async () => expect(await accessTokenFor(auth())).toBe(null));
});

describe('login and whoami', () => {
  async function project(extra = {}) {
    await writeFile(path.join(dir, 'env.config.json'), JSON.stringify({ project: 'demo', provider: 'local', auth: auth(), ...extra }));
    return { flags: { cwd: dir }, positional: [], rest: [] };
  }

  it('says there is nothing to sign in to when the project has no issuer', async () => {
    await writeFile(path.join(dir, 'env.config.json'), JSON.stringify({ project: 'demo', provider: 'local' }));

    expect(await login({ flags: { cwd: dir }, positional: [], rest: [] })).toBe(1);
    expect(logs.join('\n')).toMatch(/does not use an identity provider/);
  });

  it('reports not being signed in', async () => {
    expect(await whoami(await project())).toBe(1);
    expect(logs.join('\n')).toMatch(/Not signed in/);
  });

  it('shows the account once a credential is stored', async () => {
    await writeCredential(issuer, { access_token: 'x', email: 'wilson@example.test', expiresAt: Date.now() + 600_000 });

    expect(await whoami(await project())).toBe(0);
    expect(logs.join('\n')).toMatch(/wilson@example\.test/);
    expect(logs.join('\n')).toMatch(/valid/);
  });

  it('reports an unusable credential rather than pretending', async () => {
    await writeCredential(issuer, { access_token: 'x', refresh_token: 'wrong', expiresAt: Date.now() - 1000 });

    expect(await whoami(await project())).toBe(1);
    expect(logs.join('\n')).toMatch(/expired/);
  });
});
