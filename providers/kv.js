import { PAYLOAD_HEADER_LEN } from '../core/crypto/header.js';
import { assertRef, ConflictError, KIND_ENV } from '../core/provider.js';

/**
 * Cloudflare Workers KV over the REST API.
 *
 * EVENTUAL CONSISTENCY:
 * A write is visible immediately in the region that made it and takes up to about a minute elsewhere.
 * This means a `push` on Person A's laptop followed by `pull` on a CI runner may return stale secrets, with nothing to indicate anything is wrong.
 *
 * For this workload, R2 or D1 is a better choice.
 */

const API = 'https://api.cloudflare.com/client/v4';

function versionOf(blob, kind) {
  if (kind !== KIND_ENV) return 0n;

  if (blob.length < PAYLOAD_HEADER_LEN) throw new Error('Stored blob is truncated.');

  return blob.readBigUInt64LE(8);
}

function failure(body, what) {
  const message = body?.errors?.map((e) => `${e.code} ${e.message}`).join('; ');
  return new Error(`Cloudflare refused ${what}${message ? `: ${message}` : '.'}`);
}

export function create(options = {}, { dir } = {}) {
  const accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const namespaceId = options.namespaceId ?? process.env.CLOUDFLARE_KV_NAMESPACE_ID;
  const token = options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId) throw new Error('The kv provider needs "accountId" in its options, or CLOUDFLARE_ACCOUNT_ID.');
  if (!namespaceId) throw new Error('The kv provider needs "namespaceId" in its options, or CLOUDFLARE_KV_NAMESPACE_ID.');
  if (!token) throw new Error('The kv provider needs an API token.\n\n  Set CLOUDFLARE_API_TOKEN, or "apiToken" in options.\n  Create one with Workers KV Storage read and write on this namespace.\n');

  const prefix = options.prefix ? String(options.prefix).replace(/^\/+|\/+$/g, '') + '/' : '';
  const base = `${API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`;

  const keyFor = (ref) => {
    assertRef(ref);
    return `${prefix}${ref.project}/${ref.kind}/${ref.name}`;
  };

  const headers = { authorization: `Bearer ${token}` };

  return {
    name: 'kv',
    atomicCas: false,
    describe: () => `cloudflare kv ${namespaceId.slice(0, 8)}…`,

    async get(ref) {
      const response = await fetch(`${base}/values/${encodeURIComponent(keyFor(ref))}`, { headers });

      if (response.status === 404) return null;
      if (!response.ok) throw failure(await response.json().catch(() => null), `reading ${ref.name}`);

      const blob = Buffer.from(await response.arrayBuffer());
      return { blob, version: versionOf(blob, ref.kind) };
    },

    async put(ref, blob, { ifVersion } = {}) {
      const version = versionOf(blob, ref.kind);

      // No conditional write method
      if (ifVersion !== undefined) {
        const current = await this.get(ref);
        const actual = current?.version ?? 0n;
        if (actual !== BigInt(ifVersion)) throw new ConflictError(BigInt(ifVersion), actual);
      }

      const form = new FormData();
      form.set('value', new Blob([blob]));
      form.set('metadata', JSON.stringify({ version: String(version) }));

      const response = await fetch(`${base}/values/${encodeURIComponent(keyFor(ref))}`, { method: 'PUT', headers, body: form });

      if (!response.ok) throw failure(await response.json().catch(() => null), `writing ${ref.name}`);

      return { version };
    },

    async list(project) {
      const out = [];
      let cursor;

      do {
        const url = new URL(`${base}/keys`);
        url.searchParams.set('prefix', `${prefix}${project}/`);
        url.searchParams.set('limit', '1000');
        if (cursor) url.searchParams.set('cursor', cursor);

        const response = await fetch(url, { headers });
        if (!response.ok) throw failure(await response.json().catch(() => null), `listing ${project}`);

        const body = await response.json();

        for (const entry of body.result ?? []) {
          const rest = entry.name.slice(`${prefix}${project}/`.length);
          const slash = rest.indexOf('/');
          if (slash === -1) continue;

          const name = rest.slice(slash + 1);
          if (!name || name.includes('/')) continue;

          out.push({ kind: rest.slice(0, slash), name, version: BigInt(entry.metadata?.version ?? 0) });
        }

        cursor = body.result_info?.cursor || undefined;
      } while (cursor);

      return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    },

    async remove(ref) {
      const response = await fetch(`${base}/values/${encodeURIComponent(keyFor(ref))}`, { method: 'DELETE', headers });

      if (response.status === 404) return false;
      if (!response.ok) throw failure(await response.json().catch(() => null), `deleting ${ref.name}`);

      return true;
    }
  };
}
