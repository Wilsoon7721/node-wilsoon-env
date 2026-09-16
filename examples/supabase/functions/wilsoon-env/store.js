/*
  Rows over PostgREST, called with the service role from inside the function, so
  the key never leaves Supabase. The version rules mirror the package's own
  supabase provider: Postgres does the comparison, not this code.
*/

export function createStore({ url, serviceKey, table = 'wilsoon_env', schema = null, fetch: request = globalThis.fetch }) {
  if (!url || !serviceKey) throw new Error('The store needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');

  const base = `${String(url).replace(/\/+$/, '')}/rest/v1/${encodeURIComponent(table)}`;

  const headers = (write, extra = {}) => ({
    apikey: serviceKey,
    authorization: `Bearer ${serviceKey}`,
    'content-type': 'application/json',
    ...(schema ? { [write ? 'content-profile' : 'accept-profile']: schema } : {}),
    ...extra
  });

  const match = (ref) => `project=eq.${encodeURIComponent(ref.project)}&kind=eq.${encodeURIComponent(ref.kind)}&name=eq.${encodeURIComponent(ref.name)}`;

  async function send(target, init, what) {
    const response = await request(target, init);

    if (!response.ok && response.status !== 409) throw new Error(`PostgREST refused ${what}: HTTP ${response.status} ${await response.text().catch(() => '')}`);

    return response;
  }

  const store = {
    async get(ref) {
      const [row] = await (await send(`${base}?${match(ref)}&select=blob,version&limit=1`, { headers: headers(false) }, 'a read')).json();

      return row ? { blob: row.blob, version: BigInt(row.version ?? 0) } : null;
    },

    async put(ref, { blob, version }, { ifVersion } = {}) {
      if (ifVersion !== undefined && ifVersion > 0n) {
        const response = await send(
          `${base}?${match(ref)}&version=eq.${ifVersion}`,
          { method: 'PATCH', headers: headers(true, { prefer: 'return=representation' }), body: JSON.stringify({ blob, version: Number(version), updated_at: new Date().toISOString() }) },
          'a write'
        );

        if ((await response.json()).length) return { conflict: false };

        return { conflict: true, actual: (await store.get(ref))?.version ?? 0n };
      }

      const response = await send(
        base,
        {
          method: 'POST',
          headers: headers(true, { prefer: ifVersion === 0n ? 'return=minimal' : 'resolution=merge-duplicates,return=minimal' }),
          body: JSON.stringify({ project: ref.project, kind: ref.kind, name: ref.name, version: Number(version), blob })
        },
        'a write'
      );

      if (response.status === 409) return { conflict: true, actual: (await store.get(ref))?.version ?? 0n };

      return { conflict: false };
    },

    async list(project) {
      const rows = await (await send(`${base}?project=eq.${encodeURIComponent(project)}&select=kind,name,version`, { headers: headers(false) }, 'a listing')).json();

      return rows.map((row) => ({ kind: row.kind, name: row.name, version: BigInt(row.version ?? 0) }));
    },

    async remove(ref) {
      const response = await send(`${base}?${match(ref)}`, { method: 'DELETE', headers: headers(true, { prefer: 'return=representation' }) }, 'a delete');

      return (await response.json()).length > 0;
    }
  };

  return store;
}
