import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seal } from '../core/crypto/envelope.js';
import { generateIdentity } from '../core/crypto/identity.js';
import { ConflictError } from '../core/provider.js';
import { amzDate, encodePath, sign, uriEncode } from '../providers/lib/sigv4.js';
import { create as createS3 } from '../providers/s3.js';

const CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
const VECTOR_DATE = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));

describe('sigv4', () => {
  const vector = (url) => sign({ method: 'GET', url: new URL(url), body: '', region: 'us-east-1', service: 'service', credentials: CREDS, date: VECTOR_DATE, contentSha256Header: false }).authorization;

  it('matches get-vanilla', () =>
    expect(vector('https://example.amazonaws.com/')).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'));

  it('matches get-vanilla-query', () => expect(vector('https://example.amazonaws.com/?Param1=value1')).toContain('Signature=a67d582fa61cc504c4bae71f336f98b97f1ea3c7a6bfe1b6e45aec72011b9aeb'));

  it('sorts query parameters canonically rather than by insertion', () => {
    const a = vector('https://example.amazonaws.com/?Param1=value1&Param2=value2');
    const b = vector('https://example.amazonaws.com/?Param2=value2&Param1=value1');

    expect(a).toBe(b);
  });

  it('includes x-amz-content-sha256 for S3 and signs it', () => {
    const headers = sign({ method: 'GET', url: new URL('https://b.s3.amazonaws.com/k'), body: '', region: 'us-east-1', credentials: CREDS, date: VECTOR_DATE });

    expect(headers['x-amz-content-sha256']).toBe(createHash('sha256').update('').digest('hex'));
    expect(headers.authorization).toContain('x-amz-content-sha256');
  });

  it('signs a session token when one is present', () => {
    const headers = sign({ method: 'GET', url: new URL('https://b.s3.amazonaws.com/k'), body: '', region: 'us-east-1', credentials: { ...CREDS, sessionToken: 'tok' }, date: VECTOR_DATE });

    expect(headers['x-amz-security-token']).toBe('tok');
    expect(headers.authorization).toContain('x-amz-security-token');
  });

  it('encodes paths per RFC 3986, preserving separators', () => {
    expect(uriEncode("a b!'()*")).toBe('a%20b%21%27%28%29%2A');
    expect(encodePath('/bucket/.env.production')).toBe('/bucket/.env.production');
    expect(encodePath('/bucket/my project/.env')).toBe('/bucket/my%20project/.env');
  });

  it('formats timestamps as AWS expects', () => expect(amzDate(VECTOR_DATE)).toBe('20150830T123600Z'));
});

describe('s3 provider', () => {
  const me = generateIdentity();
  const ref = { project: 'demo', kind: 'env', name: '.env.production' };
  const blobAt = (version) => seal({ plaintext: 'A=1\n', recipients: [me.publicRaw], project: ref.project, name: ref.name, version });

  let store; // key -> { body, etag, meta }
  let requests; // every request the adapter made
  let etagSeq;

  const options = { bucket: 'secrets', endpoint: 'https://acct.r2.cloudflarestorage.com', accessKeyId: 'A', secretAccessKey: 'B' };

  beforeEach(() => {
    store = new Map();
    requests = [];
    etagSeq = 0;

    vi.stubGlobal('fetch', async (url, init) => {
      const u = new URL(url);
      const method = init.method;
      requests.push({ method, path: u.pathname, search: u.search, headers: init.headers });

      const key = u.pathname.replace('/secrets/', '');
      const existing = store.get(key);

      if (method === 'GET' && u.searchParams.get('list-type') === '2') {
        const wanted = u.searchParams.get('prefix');
        const keys = [...store.keys()].filter((k) => k.startsWith(wanted));
        const xml = `<?xml version="1.0"?><ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`;
        return new Response(xml, { status: 200 });
      }

      if (method === 'GET') {
        if (!existing) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });

        return new Response(existing.body, { status: 200, headers: { etag: existing.etag } });
      }

      if (method === 'HEAD') {
        if (!existing) return new Response(null, { status: 404 });

        return new Response(null, { status: 200, headers: { 'x-amz-meta-wenv-version': existing.meta } });
      }

      if (method === 'PUT') {
        const ifMatch = init.headers['if-match'];
        const ifNone = init.headers['if-none-match'];

        if (ifNone === '*' && existing) return new Response('', { status: 412 });
        if (ifMatch && (!existing || existing.etag !== ifMatch)) return new Response('', { status: 412 });

        const etag = `"etag-${++etagSeq}"`;
        store.set(key, { body: Buffer.from(init.body), etag, meta: init.headers['x-amz-meta-wenv-version'] });
        return new Response(null, { status: 200, headers: { etag } });
      }

      if (method === 'DELETE') {
        const had = store.delete(key);
        return new Response(null, { status: had ? 204 : 404 });
      }

      return new Response('', { status: 400 });
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('signs every request it makes', async () => {
    await createS3(options).get(ref);

    expect(requests[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=A\//);
    expect(requests[0].headers['x-amz-content-sha256']).toBeTruthy();
    expect(requests[0].headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it('uses path style for a custom endpoint', async () => {
    await createS3(options).get(ref);

    expect(requests[0].path).toBe('/secrets/demo/env/.env.production');
  });

  it('uses virtual host style for AWS', async () => {
    const s3 = createS3({ bucket: 'secrets', region: 'eu-west-1', accessKeyId: 'A', secretAccessKey: 'B' });
    await s3.get(ref);

    expect(requests[0].headers.host).toBe('secrets.s3.eu-west-1.amazonaws.com');
    expect(requests[0].path).toBe('/demo/env/.env.production');
  });

  it('applies a configured prefix', async () => {
    const s3 = createS3({ ...options, prefix: 'vaults/' });
    await s3.get(ref);

    expect(requests[0].path).toBe('/secrets/vaults/demo/env/.env.production');
  });

  it('returns null for a missing object rather than throwing', async () => expect(await createS3(options).get(ref)).toBe(null));

  it('round-trips a blob and reads the version from the blob itself', async () => {
    const s3 = createS3(options);
    const blob = blobAt(3);

    expect((await s3.put(ref, blob)).version).toBe(3n);

    const got = await s3.get(ref);
    expect(got.blob.equals(blob)).toBe(true);
    expect(got.version).toBe(3n);
  });

  it('makes a first write conditional on nothing being there', async () => {
    const s3 = createS3(options);
    await s3.put(ref, blobAt(1), { ifVersion: 0 });

    expect(requests.at(-1).headers['if-none-match']).toBe('*');
  });

  it('pins a later write to the exact copy it read', async () => {
    const s3 = createS3(options);
    await s3.put(ref, blobAt(1));
    await s3.get(ref);
    await s3.put(ref, blobAt(2), { ifVersion: 1 });

    expect(requests.at(-1).headers['if-match']).toBe('"etag-1"');
  });

  it('raises a conflict when the store rejects the condition', async () => {
    const s3 = createS3(options);
    await s3.put(ref, blobAt(1));
    await s3.get(ref);

    // Somebody else writes, invalidating the etag we hold.
    const other = createS3(options);
    await other.put(ref, blobAt(2));

    await expect(s3.put(ref, blobAt(2), { ifVersion: 1 })).rejects.toThrow(ConflictError);
  });

  it('lists what it holds, with versions from metadata', async () => {
    const s3 = createS3(options);
    await s3.put(ref, blobAt(4));
    await s3.put({ ...ref, name: '.env.local' }, blobAt(2));

    const listed = await s3.list('demo');

    expect(listed).toEqual([
      { kind: 'env', name: '.env.local', version: 2n },
      { kind: 'env', name: '.env.production', version: 4n }
    ]);
  });

  it('removes, reporting whether anything was there', async () => {
    const s3 = createS3(options);
    await s3.put(ref, blobAt(1));

    expect(await s3.remove(ref)).toBe(true);
    expect(await s3.remove(ref)).toBe(false);
  });

  it('explains an access denial in terms of the token', async () => {
    vi.stubGlobal('fetch', async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }));

    await expect(createS3(options).get(ref)).rejects.toThrow(/Access denied.*permission/s);
  });

  it('needs a bucket', () => expect(() => createS3({ endpoint: 'https://x' })).toThrow(/needs a "bucket"/));

  it('refuses a ref that would escape the prefix', async () => await expect(createS3(options).get({ project: 'demo', kind: 'env', name: '../../etc/passwd' })).rejects.toThrow(/escape the store/));
});
