import { createHash } from 'node:crypto';

import { ConflictError, KIND_ENV, assertRef } from '../core/provider.js';
import { PAYLOAD_HEADER_LEN } from '../core/crypto/header.js';
import { resolveCredentials } from './lib/aws-credentials.js';
import { EMPTY_PAYLOAD_SHA256, sign } from './lib/sigv4.js';

// For any S3-compatible storage (AWS, R2, MinIO, etc.)

const VERSION_META = 'x-amz-meta-wenv-version';

function versionOf(blob, kind) {
  if (kind !== KIND_ENV) return 0n;

  if (blob.length < PAYLOAD_HEADER_LEN) throw new Error('Stored blob is truncated.');

  return blob.readBigUInt64LE(8);
}

function errorFrom(status, body, what) {
  const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const message = body.match(/<Message>([^<]+)<\/Message>/)?.[1];

  if (status === 403) return new Error(`Access denied ${what}. Check the credentials and that the token has read and write permission on this bucket.${code ? ` (${code})` : ''}`);

  if (status === 404) return new Error(`Not found ${what}. Check the bucket name and endpoint.${code ? ` (${code})` : ''}`);

  return new Error(`The store refused ${what}: HTTP ${status}${code ? ` ${code}` : ''}${message ? ` - ${message}` : ''}`);
}

export function create(options = {}, { dir } = {}) {
  const bucket = options.bucket;
  if (!bucket) throw new Error('The s3 provider needs a "bucket" in its options.');

  const region = options.region ?? (options.endpoint ? 'auto' : 'us-east-1');
  const prefix = options.prefix ? String(options.prefix).replace(/^\/+|\/+$/g, '') + '/' : '';
  const pathStyle = options.forcePathStyle ?? Boolean(options.endpoint);

  const base = options.endpoint ? new URL(options.endpoint) : new URL(`https://s3.${region}.amazonaws.com`);

  let credentials = null;
  const etags = new Map();

  const keyFor = (ref) => {
    assertRef(ref);
    return `${prefix}${ref.project}/${ref.kind}/${ref.name}`;
  };

  function urlFor(key, query) {
    const url = new URL(base);

    if (pathStyle) url.pathname = `/${bucket}${key ? `/${key}` : ''}`;
    else {
      url.host = `${bucket}.${base.host}`;
      url.pathname = `/${key ?? ''}`;
    }

    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

    return url;
  }

  async function request(method, url, { body, headers = {}, expect = [200] } = {}) {
    credentials ??= await resolveCredentials(options);

    const payloadSha256 = body === undefined ? EMPTY_PAYLOAD_SHA256 : createHash('sha256').update(body).digest('hex');

    const signedHeaders = sign({ method, url, headers, body, region, service: 's3', credentials, payloadSha256 });

    const response = await fetch(url, { method, headers: signedHeaders, body });

    if (!expect.includes(response.status)) return { response, text: await response.text().catch(() => '') };

    return { response, text: null };
  }

  return {
    name: 's3',
    describe: () => `${options.endpoint ? base.host : `s3.${region}.amazonaws.com`}/${bucket}${prefix ? `/${prefix.slice(0, -1)}` : ''}`,

    async get(ref) {
      const key = keyFor(ref);
      const { response, text } = await request('GET', urlFor(key), { expect: [200, 404] });

      if (response.status === 404) return null;
      if (response.status !== 200) throw errorFrom(response.status, text ?? '', `reading ${ref.name}`);

      const blob = Buffer.from(await response.arrayBuffer());
      const etag = response.headers.get('etag');
      if (etag) etags.set(key, etag);

      return { blob, version: versionOf(blob, ref.kind) };
    },

    async put(ref, blob, { ifVersion } = {}) {
      const key = keyFor(ref);
      const version = versionOf(blob, ref.kind);

      const headers = { 'content-type': 'application/octet-stream', [VERSION_META]: String(version) };

      if (ifVersion !== undefined) {
        const known = etags.get(key);
        if (BigInt(ifVersion) === 0n && !known) headers['if-none-match'] = '*';
        else if (known) headers['if-match'] = known;
      }

      const { response, text } = await request('PUT', urlFor(key), { body: blob, headers, expect: [200] });

      if (response.status === 412 || response.status === 409) {
        const current = await this.get(ref).catch(() => null);
        throw new ConflictError(BigInt(ifVersion ?? 0), current?.version ?? 0n);
      }

      if (response.status === 501 || (response.status === 400 && (text ?? '').includes('NotImplemented')))
        throw new Error(`This store does not support conditional writes, so a concurrent push could be lost silently.\n\n  Re-run with --force to write anyway.\n`);

      if (response.status !== 200) throw errorFrom(response.status, text ?? '', `writing ${ref.name}`);

      const etag = response.headers.get('etag');
      if (etag) etags.set(key, etag);

      return { version };
    },

    async list(project) {
      const out = [];
      let token;

      do {
        const query = { 'list-type': '2', prefix: `${prefix}${project}/` };
        if (token) query['continuation-token'] = token;

        const { response, text } = await request('GET', urlFor('', query), { expect: [200] });
        if (response.status !== 200) throw errorFrom(response.status, text ?? '', `listing ${project}`);

        const xml = await response.text();

        for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
          const rest = match[1].slice(`${prefix}${project}/`.length);
          const slash = rest.indexOf('/');
          if (slash === -1) continue;

          const kind = rest.slice(0, slash);
          const name = rest.slice(slash + 1);
          if (!name || name.includes('/')) continue;

          out.push({ kind, name });
        }

        token = xml.match(/<IsTruncated>true<\/IsTruncated>/) ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] : undefined;
      } while (token);

      await Promise.all(
        out.map(async (entry) => {
          const { response } = await request('HEAD', urlFor(keyFor({ project, ...entry })), { expect: [200, 404] });
          const meta = response.headers.get(VERSION_META);
          entry.version = meta === null ? 0n : BigInt(meta);
        })
      );

      return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    },

    async remove(ref) {
      const key = keyFor(ref);
      const { response, text } = await request('DELETE', urlFor(key), { expect: [204, 200, 404] });

      if (![204, 200, 404].includes(response.status)) throw errorFrom(response.status, text ?? '', `deleting ${ref.name}`);

      etags.delete(key);

      return response.status !== 404;
    }
  };
}
