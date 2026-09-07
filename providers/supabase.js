import { ConflictError, KIND_ENV, assertRef } from '../core/provider.js';
import { PAYLOAD_HEADER_LEN } from '../core/crypto/header.js';
import { accessTokenFor } from '../auth/tokens.js';

/**
 * Supabase over PostgREST.
 *
 * Expected table (see README for grants and schema setting):
 *   create table blobs (
 *     project text   not null,
 *     kind    text   not null,
 *     name    text   not null,
 *     version bigint not null default 0,
 *     blob    text   not null,
 *     owner   uuid            default auth.uid(),
 *     updated_at timestamptz not null default now(),
 *     primary key (project, kind, name)
 *   );
 */

function versionOf(blob, kind) {
  if (kind !== KIND_ENV) return 0n;

  if (blob.length < PAYLOAD_HEADER_LEN) throw new Error('Stored blob is truncated.');

  return blob.readBigUInt64LE(8);
}

function failure(status, body, what) {
  const message = body?.message ?? body?.hint ?? '';

  if (body?.code === 'PGRST106') {
    return new Error(`Supabase does not expose that schema, so ${what} cannot work.\n\n  Add it in the dashboard under Settings > Data API > Exposed schemas.\n${body.hint ? `\n  ${body.hint}\n` : ''}`);
  }

  if (status === 401 || status === 403) {
    return new Error(`Supabase refused ${what} (HTTP ${status}).\n\n  Either you are not signed in, or row level security is hiding these rows.\n  Run "npx @wilsoon/env login" if this project uses oidc auth.\n${message ? `\n  ${message}\n` : ''}`);
  }

  if (status === 404) return new Error(`Supabase returned 404 for ${what}. Check the table name and that PostgREST exposes it.${message ? ` ${message}` : ''}`);

  return new Error(`Supabase refused ${what}: HTTP ${status}${message ? ` - ${message}` : ''}`);
}

export function create(options = {}, { dir } = {}) {
  const url = options.url ?? process.env.SUPABASE_URL;
  const anonKey = options.anonKey ?? process.env.SUPABASE_ANON_KEY;
  const serviceKey = options.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const table = options.table ?? 'wilsoon_env';
  const schema = options.schema ?? null;

  if (!url) throw new Error('The supabase provider needs a "url" in its options, or SUPABASE_URL.');
  if (!anonKey && !serviceKey) throw new Error('The supabase provider needs "anonKey" (with login) or "serviceKey".\n\n  Set SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY for a machine with no user.\n');

  const auth = options.auth ?? null;
  const base = `${String(url).replace(/\/+$/, '')}/rest/v1/${encodeURIComponent(table)}`;

  async function headers(extra = {}, { write = false } = {}) {
    const apikey = serviceKey ?? anonKey;
    let bearer = serviceKey;

    if (!serviceKey && auth) {
      bearer = await accessTokenFor(auth.type === 'supabase' ? { ...auth, url, anonKey } : auth);

      if (!bearer) {
        throw new Error(`Not signed in to ${auth.issuer}.\n\n  Run "npx @wilsoon/env login" first.\n`);
      }
    }

    const profile = schema ? (write ? { 'content-profile': schema } : { 'accept-profile': schema }) : {};

    return { apikey, authorization: `Bearer ${bearer ?? anonKey}`, 'content-type': 'application/json', ...profile, ...extra };
  }

  const match = (ref) => {
    assertRef(ref);
    return `project=eq.${encodeURIComponent(ref.project)}&kind=eq.${encodeURIComponent(ref.kind)}&name=eq.${encodeURIComponent(ref.name)}`;
  };

  return {
    name: 'supabase',
    atomicCas: true,
    describe: () => `${new URL(url).host}/${table}`,

    async get(ref) {
      const response = await fetch(`${base}?${match(ref)}&select=blob,version&limit=1`, { headers: await headers() });

      if (!response.ok) throw failure(response.status, await response.json().catch(() => null), `reading ${ref.name}`);

      const [row] = await response.json();
      if (!row) return null;

      const blob = Buffer.from(row.blob, 'base64');
      return { blob, version: versionOf(blob, ref.kind) };
    },

    async put(ref, blob, { ifVersion } = {}) {
      const version = versionOf(blob, ref.kind);
      const payload = { project: ref.project, kind: ref.kind, name: ref.name, version: Number(version), blob: blob.toString('base64') };

      const expected = ifVersion === undefined ? undefined : BigInt(ifVersion);

      if (expected !== undefined && expected > 0n) {
        const response = await fetch(`${base}?${match(ref)}&version=eq.${expected}`, {
          method: 'PATCH',
          headers: await headers({ prefer: 'return=representation' }, { write: true }),
          body: JSON.stringify({ version: Number(version), blob: payload.blob })
        });

        if (!response.ok) throw failure(response.status, await response.json().catch(() => null), `writing ${ref.name}`);

        const rows = await response.json();

        if (!rows.length) {
          const current = await this.get(ref);
          throw new ConflictError(expected, current?.version ?? 0n);
        }

        return { version };
      }

      const response = await fetch(base, {
        method: 'POST',
        headers: await headers({ prefer: expected === 0n ? 'return=minimal' : 'resolution=merge-duplicates,return=minimal' }, { write: true }),
        body: JSON.stringify(payload)
      });

      if (response.status === 409) {
        const current = await this.get(ref);
        throw new ConflictError(expected ?? 0n, current?.version ?? 0n);
      }

      if (!response.ok) throw failure(response.status, await response.json().catch(() => null), `writing ${ref.name}`);

      return { version };
    },

    async list(project) {
      const response = await fetch(`${base}?project=eq.${encodeURIComponent(project)}&select=kind,name,version`, { headers: await headers() });

      if (!response.ok) throw failure(response.status, await response.json().catch(() => null), `listing ${project}`);

      const rows = await response.json();

      return rows
        .map((row) => ({ kind: row.kind, name: row.name, version: BigInt(row.version ?? 0) }))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    },

    async remove(ref) {
      const response = await fetch(`${base}?${match(ref)}`, { method: 'DELETE', headers: await headers({ prefer: 'return=representation' }, { write: true }) });

      if (!response.ok) throw failure(response.status, await response.json().catch(() => null), `deleting ${ref.name}`);

      return (await response.json()).length > 0;
    }
  };
}
