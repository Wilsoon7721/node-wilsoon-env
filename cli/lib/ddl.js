const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * The table this package needs as SQL - creates both table and RLS policies
 */
export function supabaseDdl({ table = 'wilsoon_env', schema = null } = {}) {
  const where = schema ? `${quote(schema)}.${quote(table)}` : `public.${quote(table)}`;
  const policy = `${table} members`;

  const lines = [
    '-- @wilsoon/env stores opaque blobs. Nothing here is readable without a recipient key.',
    ...(schema ? [`create schema if not exists ${quote(schema)};`, ''] : []),
    `create table if not exists ${where} (`,
    '  project    text   not null,',
    '  kind       text   not null,',
    '  name       text   not null,',
    '  version    bigint not null default 0,',
    '  blob       text   not null,',
    '  owner      uuid            default auth.uid(),',
    '  updated_at timestamptz not null default now(),',
    '  primary key (project, kind, name)',
    ');',
    '',
    `alter table ${where} enable row level security;`,
    '',
    '-- Anyone signed in may read and write. Narrow this to "owner = auth.uid()"',
    "-- if the people with accounts should not all see each other's projects.",
    'do $$ begin',
    `  create policy ${quote(policy)} on ${where}`,
    '    for all to authenticated using (true) with check (true);',
    'exception when duplicate_object then null;',
    'end $$;',
    ''
  ];

  if (schema) lines.push(`grant usage on schema ${quote(schema)} to authenticated;`);

  lines.push(`grant select, insert, update, delete on ${where} to authenticated;`);

  return lines.join('\n');
}

/** The project ref Supabase addresses a project by, taken from its URL */
export function projectRef(url) {
  try {
    const host = new URL(String(url)).hostname;
    const [ref] = host.split('.');

    return host.endsWith('.supabase.co') && ref ? ref : null;
  } catch {
    return null;
  }
}

/**
 * Run SQL through the Management API - uses PAT
 */
export async function runSql(ref, token, sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/database/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql })
  });

  if (response.ok) return;

  const detail = await response.text().catch(() => '');

  throw new Error(`The Management API refused the statement (HTTP ${response.status}).${detail ? `\n\n  ${detail.slice(0, 400)}\n` : ''}`);
}
