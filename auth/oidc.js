import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

/**
 * 2 CLI login methods, talks to the issuer directly with no client secret needed
 *  - deviceAuthorize() uses RFC 8628
 *  - authorize() uses RFC 8252
 */

const CALLBACK = '/callback';

const base64url = (buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function createVerifier() {
  return base64url(randomBytes(32));
}

export function challengeFor(verifier) {
  return base64url(createHash('sha256').update(verifier).digest());
}

function sameState(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));

  return left.length === right.length && timingSafeEqual(left, right);
}

const PAGE = (title, detail) =>
  `<!doctype html><meta charset="utf-8"><title>wilsoon-env</title>`
  + `<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#0b0b0c;color:#e8e8ea}`
  + `div{max-width:26rem;padding:2rem;text-align:center}p{opacity:.7;font-size:.95em}</style>`
  + `<div><h1>${title}</h1><p>${detail}</p></div>`;

/** Bind the loopback listener before the browser is opened so the port in the redirect URI is known */
export async function listen({ timeoutMs = 5 * 60 * 1000, state } = {}) {
  let settle;
  const received = new Promise((resolve, reject) => (settle = { resolve, reject }));
  received.catch(() => {});

  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return void res.writeHead(400).end();
    }

    if (url.pathname !== CALLBACK) return void res.writeHead(404).end();

    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in refused', error));
      return void settle.reject(new Error(`The identity provider refused the request: ${error}${url.searchParams.get('error_description') ? ` - ${url.searchParams.get('error_description')}` : ''}`));
    }

    if (!sameState(url.searchParams.get('state'), state)) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in refused', 'That response did not match this request.'));
      return void settle.reject(new Error('The callback carried the wrong state. Start again.'));
    }

    const code = url.searchParams.get('code');

    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Something went wrong', 'No authorization code came back.'));
      return void settle.reject(new Error('The browser came back without an authorization code.'));
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Signed in', 'You can close this tab and go back to your terminal.'));
    settle.resolve(code);
  });

  server.keepAliveTimeout = 0;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const timer = setTimeout(() => settle.reject(new Error('Timed out waiting for the browser.')), timeoutMs);
  timer.unref?.();

  return {
    port: server.address().port,
    redirectUri: `http://127.0.0.1:${server.address().port}${CALLBACK}`,
    waitForCode: () => received,
    close: () => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
    }
  };
}

export function openBrowser(url) {
  const [file, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];

  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Find endpoints */
export async function endpoints(auth) {
  const issuer = String(auth.issuer ?? '').replace(/\/+$/, '');

  if (!issuer) throw new Error('The oidc auth strategy needs an "issuer".');

  if (auth.authorizationEndpoint && auth.tokenEndpoint) return { issuer, authorization: auth.authorizationEndpoint, token: auth.tokenEndpoint, userinfo: auth.userinfoEndpoint, device: auth.deviceEndpoint };

  let document = null;

  try {
    const response = await fetch(`${issuer}/.well-known/openid-configuration`);
    if (response.ok) document = await response.json();
  } catch {}

  if (!document?.authorization_endpoint || !document?.token_endpoint)
    throw new Error(
      [
        `Could not discover OIDC endpoints for ${issuer}.`,
        '',
        '  Either publish /.well-known/openid-configuration, or name them in your config:',
        '',
        '    "auth": {',
        '      "type": "oidc",',
        `      "issuer": "${issuer}",`,
        `      "authorizationEndpoint": "${issuer}/authorize",`,
        `      "tokenEndpoint": "${issuer}/api/token"`,
        '    }',
        ''
      ].join('\n')
    );

  return {
    issuer,
    authorization: document.authorization_endpoint,
    token: document.token_endpoint,
    userinfo: document.userinfo_endpoint,
    device: auth.deviceEndpoint ?? document.device_authorization_endpoint
  };
}

/** POST a form and returns whatever came out */
async function postFormRaw(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString()
  });

  const text = await response.text();
  let parsed = null;

  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${url} returned something that is not JSON (HTTP ${response.status}).`);
  }

  return { ok: response.ok, status: response.status, body: parsed };
}

function refusal(result, what) {
  return new Error(`The identity provider refused ${what}: ${result.body?.error ?? `HTTP ${result.status}`}${result.body?.error_description ? ` - ${result.body.error_description}` : ''}`);
}

async function postForm(url, body) {
  const result = await postFormRaw(url, body);

  if (!result.ok || !result.body?.access_token) throw refusal(result, 'the exchange');

  return result.body;
}

/** Decode JWT payload for display only, never for deciding anything. */
export function describeToken(accessToken) {
  try {
    const [, payload] = String(accessToken).split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return { sub: decoded.sub, email: decoded.email, expiresAt: decoded.exp ? decoded.exp * 1000 : undefined };
  } catch {
    return {};
  }
}

/** Run the whole flow, `open` is injectable so browser can be used in tests */
export async function authorize(auth, { open = openBrowser, onUrl } = {}) {
  const found = await endpoints(auth);

  const verifier = createVerifier();
  const state = base64url(randomBytes(16));

  const listener = await listen({ state });

  try {
    const url = new URL(found.authorization);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', auth.clientId ?? 'wilsoon-env');
    url.searchParams.set('redirect_uri', listener.redirectUri);
    url.searchParams.set('code_challenge', challengeFor(verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('scope', auth.scope ?? DEFAULT_SCOPE);

    onUrl?.(url.toString());
    const opened = open(url.toString());

    const code = await listener.waitForCode();

    const tokens = await postForm(found.token, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: listener.redirectUri,
      client_id: auth.clientId ?? 'wilsoon-env',
      code_verifier: verifier
    });

    return { ...tokens, opened, issuer: found.issuer, ...describeToken(tokens.id_token ?? tokens.access_token) };
  } finally {
    listener.close();
  }
}

export const DEFAULT_SCOPE = 'openid email offline_access';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the issuer offers the device grant at all. */
export async function supportsDevice(auth) {
  try {
    return Boolean((await endpoints(auth)).device);
  } catch {
    return false;
  }
}

/** RFC 8628 device grant */
export async function deviceAuthorize(auth, { open = openBrowser, onPrompt, sleep = wait } = {}) {
  const found = await endpoints(auth);

  if (!found.device) throw new Error(`${found.issuer} does not offer the device grant.\n\n  Sign in with a browser on this machine instead, or set "deviceEndpoint" in your auth config.\n`);

  const clientId = auth.clientId ?? 'wilsoon-env';

  const started = await postFormRaw(found.device, { client_id: clientId, scope: auth.scope ?? DEFAULT_SCOPE });

  if (!started.ok || !started.body?.device_code) throw refusal(started, 'the device request');

  const { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval } = started.body;

  onPrompt?.({ userCode: user_code, verificationUri: verification_uri, verificationUriComplete: verification_uri_complete, expiresIn: expires_in });
  const opened = verification_uri_complete ? open(verification_uri_complete) : false;

  let every = Math.max(1, Number(interval) || 5);
  const ceiling = Date.now() + ((Number(expires_in) || 600) + 120) * 1000;

  for (;;) {
    await sleep(every * 1000);

    const polled = await postFormRaw(found.token, { grant_type: DEVICE_GRANT, device_code, client_id: clientId });

    if (polled.ok && polled.body?.access_token) return { ...polled.body, opened, issuer: found.issuer, ...describeToken(polled.body.id_token ?? polled.body.access_token) };

    const error = polled.body?.error;

    if (error === 'authorization_pending') {
      // Nothing yet
    } else if (error === 'slow_down') every = Math.max(every + 5, Number(polled.body?.interval) || 0);
    else if (error === 'expired_token') throw new Error('That sign-in request expired before it was approved.\n\n  Run login again to get a fresh code.\n');
    else if (error === 'access_denied') throw new Error('The sign-in was refused.');
    else
      throw refusal(polled, 'the device exchange');

    if (Date.now() > ceiling) throw new Error('Gave up waiting for the identity provider.\n\n  It never reported the request as approved, refused or expired. Run login again.\n');
  }
}

export async function refresh(auth, refreshToken) {
  const found = await endpoints(auth);

  const tokens = await postForm(found.token, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: auth.clientId ?? 'wilsoon-env'
  });

  return { ...tokens, issuer: found.issuer, ...describeToken(tokens.id_token ?? tokens.access_token) };
}
