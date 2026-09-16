/*
  The @wilsoon/env endpoint protocol, with the platform left out. Signature
  checks and storage are passed in, so this file runs unchanged under Deno on
  Supabase and under Node in the package's own tests.

    GET    /{project}                  -> { entries: [{ kind, name, version }] }
    GET    /{project}/{kind}/{name}    -> { blob, version } | 404 not_found
    PUT    /{project}/{kind}/{name}    <- { blob, ifVersion? }  -> { version } | 409 conflict
    DELETE /{project}/{kind}/{name}    -> { removed }

  Blobs travel as base64 and versions as decimal strings.
*/

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const KINDS = new Set(['identity', 'env']);
const MAGIC = 'WENV';
const PAYLOAD_HEADER_LEN = 16;
const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_BODY_CHARS = Math.ceil(MAX_BLOB_BYTES / 3) * 4 + 256;

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Decide whether a verified token belongs to someone allowed in.
 *
 * Signature, issuer, audience and expiry are the caller's job. This is the part
 * that is policy rather than cryptography.
 */
export function checkClaims(payload, { allowedSubjects, clientId } = {}) {
  if (payload.token_use === 'client') throw new HttpError(403, 'not_a_person', 'Client credentials cannot use this endpoint. Sign in as a person.');
  if (clientId && payload.client_id !== clientId) throw new HttpError(403, 'wrong_client', 'That token was issued to a different client.');
  if (!payload.sub || !allowedSubjects?.has(payload.sub)) throw new HttpError(403, 'not_allowed', 'This account is not allowed to use this endpoint.', { subject: payload.sub ?? null });

  return { subject: payload.sub };
}

function decodeSegment(part) {
  let value;

  try {
    value = decodeURIComponent(part);
  } catch {
    throw new HttpError(400, 'bad_path', 'That path is not valid.');
  }

  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) throw new HttpError(400, 'bad_path', `Refusing "${value}": it would escape the store.`);

  return value;
}

function sealedBytes(base64, kind) {
  if (typeof base64 !== 'string' || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new HttpError(400, 'bad_blob', 'The blob must be base64.');

  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

  if (bytes.length > MAX_BLOB_BYTES) throw new HttpError(413, 'too_large', 'That blob is larger than this endpoint accepts.');
  if (bytes.length < 4 || String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC) throw new HttpError(400, 'bad_blob', 'That is not an @wilsoon/env blob.');
  if (kind === 'env' && bytes.length < PAYLOAD_HEADER_LEN) throw new HttpError(400, 'bad_blob', 'That payload is truncated.');

  return bytes;
}

// The version lives in the sealed header, so it is read here rather than taken on trust from the writer.
function versionOf(bytes, kind) {
  if (kind !== 'env') return 0n;

  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(8, true);
}

function parseVersion(value) {
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);

  throw new HttpError(400, 'bad_version', 'ifVersion must be a non-negative integer.');
}

async function readBody(request) {
  const text = await request.text();

  if (text.length > MAX_BODY_CHARS) throw new HttpError(413, 'too_large', 'That request is larger than this endpoint accepts.');

  let body;

  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'The body must be JSON.');
  }

  if (!body || typeof body !== 'object') throw new HttpError(400, 'bad_json', 'The body must be a JSON object.');

  return body;
}

/**
 * @param {object} deps
 * @param {(token: string) => Promise<{subject: string}>} deps.verify throws HttpError when the token is not good enough
 * @param {object} deps.store get / put / list / remove, as in store.js
 * @param {string} [deps.name] the function name that prefixes every path it is served under
 */
export function createHandler({ verify, store, name = 'wilsoon-env' }) {
  return async function handle(request) {
    try {
      // Authenticate before routing, so a caller without a token cannot tell a good path from a bad one.
      const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
      if (!token) throw new HttpError(401, 'no_token', 'Sign in first: this endpoint needs a bearer token.');

      const caller = await verify(token);

      const parts = new URL(request.url).pathname.split('/').filter(Boolean);
      const at = parts.indexOf(name);
      const route = at === -1 ? parts : parts.slice(at + 1);

      if (route.length === 1) {
        if (request.method !== 'GET') throw new HttpError(405, 'method', 'Only GET lists a project.');

        const entries = await store.list(decodeSegment(route[0]));
        return reply(200, { entries: entries.map((e) => ({ kind: e.kind, name: e.name, version: String(e.version) })) });
      }

      if (route.length !== 3) throw new HttpError(404, 'no_route', 'There is nothing at that path.');

      const [project, kind, blobName] = route.map(decodeSegment);
      if (!KINDS.has(kind)) throw new HttpError(400, 'bad_kind', `Unknown blob kind "${kind}".`);

      const ref = { project, kind, name: blobName };

      if (request.method === 'GET') {
        const found = await store.get(ref);
        return found ? reply(200, { blob: found.blob, version: String(found.version) }) : reply(404, { code: 'not_found', error: 'No such blob.' });
      }

      if (request.method === 'PUT') {
        const body = await readBody(request);
        const version = versionOf(sealedBytes(body.blob, kind), kind);
        const ifVersion = body.ifVersion === undefined || body.ifVersion === null ? undefined : parseVersion(body.ifVersion);
        const result = await store.put(ref, { blob: body.blob, version }, { ifVersion, subject: caller.subject });

        if (result.conflict) return reply(409, { code: 'conflict', error: 'That file changed since it was read.', expected: String(ifVersion ?? 0n), actual: String(result.actual) });

        return reply(200, { version: String(version) });
      }

      if (request.method === 'DELETE') return reply(200, { removed: await store.remove(ref) });

      throw new HttpError(405, 'method', `${request.method} is not supported.`);
    } catch (err) {
      if (err instanceof HttpError) return reply(err.status, { code: err.code, error: err.message, ...err.extra });

      console.error(err);
      return reply(500, { code: 'internal', error: 'The endpoint failed. Its logs have the detail.' });
    }
  };
}
