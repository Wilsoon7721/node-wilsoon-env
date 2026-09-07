import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';

import { DEVICE_GRANT, deviceAuthorize, endpoints, supportsDevice } from '../auth/oidc.js';

/*
  An RFC 8628 issuer over real HTTP.

  The interesting cases are the ones that are not failures: authorization_pending
  is the normal state, and slow_down is an instruction rather than an error. Both
  arrive as non-2xx responses, which is why polling reads the body instead of
  throwing on status.
*/
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;

let url;
let server;
let script;
let polls;
let issued;
let started;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    let body = '';
    req.on('data', (c) => (body += c));

    req.on('end', () => {
      const json = (value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

      if (path === '/.well-known/openid-configuration')
        return json({
          issuer: url,
          authorization_endpoint: `${url}/authorize`,
          token_endpoint: `${url}/api/token`,
          ...(script.noDevice ? {} : { device_authorization_endpoint: `${url}/api/device/code` })
        });

      if (path === '/api/device/code') {
        started = Object.fromEntries(new URLSearchParams(body));

        if (script.startFails) return json({ error: 'unauthorized_client', error_description: 'not registered for the device grant' }, 400);

        return json({
          device_code: 'dev-code',
          user_code: 'WDJB-MJHT',
          verification_uri: `${url}/device`,
          verification_uri_complete: `${url}/device?user_code=WDJB-MJHT`,
          expires_in: script.expiresIn ?? 600,
          interval: script.interval ?? 1
        });
      }

      if (path === '/api/token') {
        const params = Object.fromEntries(new URLSearchParams(body));
        polls.push(params);

        const next = script.responses.shift() ?? { status: 200, body: { access_token: jwt({ sub: 'u1', email: 'a@b.test', exp: Math.floor(Date.now() / 1000) + 3600 }), expires_in: 3600 } };

        if (next.body?.access_token) issued++;

        return json(next.body, next.status ?? 200);
      }

      json({ error: 'not_found' }, 404);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server.close());

beforeEach(() => {
  script = { responses: [] };
  polls = [];
  issued = 0;
  started = null;
});

const auth = () => ({ type: 'oidc', issuer: url });

// Nothing here should actually wait; the delays are asserted, not slept through.
const slept = [];
const sleep = async (ms) => void slept.push(ms);

beforeEach(() => (slept.length = 0));

describe('device grant', () => {
  it('is discovered from the issuer', async () => {
    expect(await supportsDevice(auth())).toBe(true);
    expect((await endpoints(auth())).device).toBe(`${url}/api/device/code`);
  });

  it('reports absence rather than guessing an endpoint', async () => {
    script.noDevice = true;

    expect(await supportsDevice(auth())).toBe(false);
    await expect(deviceAuthorize(auth(), { open: () => false, sleep })).rejects.toThrow(/does not offer the device grant/);
  });

  it('shows the user code and the page to enter it on', async () => {
    let prompted = null;

    await deviceAuthorize(auth(), { open: () => true, sleep, onPrompt: (p) => (prompted = p) });

    expect(prompted.userCode).toBe('WDJB-MJHT');
    expect(prompted.verificationUri).toBe(`${url}/device`);
    expect(prompted.verificationUriComplete).toContain('user_code=WDJB-MJHT');
  });

  it('polls with the device grant type and returns the token', async () => {
    const result = await deviceAuthorize(auth(), { open: () => false, sleep });

    expect(polls[0].grant_type).toBe(DEVICE_GRANT);
    expect(polls[0].device_code).toBe('dev-code');
    expect(polls[0].client_id).toBe('wilsoon-env');
    expect(result.email).toBe('a@b.test');
  });

  /*
    Identity lives in the id_token. An access token is addressed to a resource
    server and carries no email by design - reading it for a name silently
    produced "Signed in" with nobody's name against a real issuer.
  */
  it('takes the identity from the id_token, not the access token', async () => {
    script.responses = [
      {
        status: 200,
        body: {
          access_token: jwt({ sub: 'user-1', scope: 'openid email', client_id: 'c' }),
          id_token: jwt({ sub: 'user-1', email: 'named@b.test' }),
          expires_in: 3600
        }
      }
    ];

    const result = await deviceAuthorize(auth(), { open: () => false, sleep });

    expect(result.email).toBe('named@b.test');
    expect(result.sub).toBe('user-1');
  });

  it('asks for offline_access, so a token can be renewed without signing in again', async () => {
    await deviceAuthorize(auth(), { open: () => false, sleep });

    expect(started.scope).toContain('offline_access');
  });

  it('sends no client secret, because a published package cannot hold one', async () => {
    await deviceAuthorize(auth(), { open: () => false, sleep });

    expect(polls[0].client_secret).toBeUndefined();
  });

  it('keeps waiting while the server says authorization_pending', async () => {
    script.responses = [
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'authorization_pending' } }
    ];

    await deviceAuthorize(auth(), { open: () => false, sleep });

    expect(polls).toHaveLength(3);
  });

  it('adopts the interval the server returns on slow_down', async () => {
    script.interval = 2;
    script.responses = [{ status: 400, body: { error: 'slow_down', interval: 30 } }];

    await deviceAuthorize(auth(), { open: () => false, sleep });

    // First wait is the advertised interval; the next honours the server.
    expect(slept[0]).toBe(2000);
    expect(slept[1]).toBe(30000);
  });

  it('backs off by at least five seconds when slow_down names no interval', async () => {
    script.interval = 5;
    script.responses = [{ status: 400, body: { error: 'slow_down' } }];

    await deviceAuthorize(auth(), { open: () => false, sleep });

    expect(slept[1]).toBe(10000);
  });

  it('stops when the server says the request expired', async () => {
    script.responses = [{ status: 400, body: { error: 'expired_token' } }];

    await expect(deviceAuthorize(auth(), { open: () => false, sleep })).rejects.toThrow(/expired before it was approved/);
  });

  it('stops when the user refuses', async () => {
    script.responses = [{ status: 400, body: { error: 'access_denied' } }];

    await expect(deviceAuthorize(auth(), { open: () => false, sleep })).rejects.toThrow(/refused/);
  });

  it('reports an unregistered client from the device request', async () => {
    script.startFails = true;

    await expect(deviceAuthorize(auth(), { open: () => false, sleep })).rejects.toThrow(/unauthorized_client/);
  });

  it('surfaces an unexpected error rather than polling forever', async () => {
    script.responses = [{ status: 400, body: { error: 'invalid_grant', error_description: 'device code already used' } }];

    await expect(deviceAuthorize(auth(), { open: () => false, sleep })).rejects.toThrow(/invalid_grant.*already used/);
  });

  it('lets the server, not a local clock, decide that time has run out', async () => {
    /*
      The contract is explicit that a client-side timer is never authoritative.
      Here the advertised expiry has long passed and the server still says
      pending - so the client must keep asking, and must succeed if the server
      eventually approves.
    */
    script.expiresIn = 1;
    script.responses = [
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'authorization_pending' } }
    ];

    const result = await deviceAuthorize(auth(), { open: () => false, sleep });

    expect(result.access_token).toBeTruthy();
    expect(issued).toBe(1);
  });

  it('gives up eventually, and says the server never answered', async () => {
    script.expiresIn = 1;
    script.interval = 1;

    // Always pending: the server never reaches a verdict.
    script.responses = Array.from({ length: 500 }, () => ({ status: 400, body: { error: 'authorization_pending' } }));

    let now = Date.now();
    const jump = async (ms) => {
      now += ms;
      slept.push(ms);
    };

    const realNow = Date.now;
    Date.now = () => now;

    try {
      await expect(deviceAuthorize(auth(), { open: () => false, sleep: jump })).rejects.toThrow(/never reported the request as approved, refused or expired/);
    } finally {
      Date.now = realNow;
    }
  });
});
