import { describe, expect, it } from 'vitest';

import { projectRef, supabaseDdl } from '../cli/lib/ddl.js';

describe('the SQL setup hands you', () => {
  it('quotes a schema that needs it, which ours does', () => {
    const sql = supabaseDdl({ table: 'blobs', schema: '@wilsoon/env' });

    expect(sql).toContain('create schema if not exists "@wilsoon/env";');
    expect(sql).toContain('create table if not exists "@wilsoon/env"."blobs"');
  });

  it('stays in public when no schema is named, and does not try to create it', () => {
    const sql = supabaseDdl({ table: 'wilsoon_env' });

    expect(sql).toContain('create table if not exists public."wilsoon_env"');
    expect(sql).not.toContain('create schema');
    expect(sql).not.toContain('grant usage on schema');
  });

  /*
    Enabling RLS with no policy locks you out of your own table; leaving it off is
    worse, because the publishable key lives in a committed config. Both have to
    be in the same script or neither is any use.
  */
  it('turns row level security on and grants a policy in the same breath', () => {
    const sql = supabaseDdl({ table: 'blobs', schema: 's' });

    expect(sql).toContain('enable row level security');
    expect(sql).toMatch(/create policy .* on "s"\."blobs"/);
    expect(sql).toContain('to authenticated');
  });

  it('can be run twice without failing', () => {
    const sql = supabaseDdl({ table: 'blobs', schema: 's' });

    expect(sql).toContain('create table if not exists');
    expect(sql).toContain('create schema if not exists');
    // `create policy` has no IF NOT EXISTS, so it needs swallowing by hand.
    expect(sql).toContain('exception when duplicate_object then null;');
  });

  it('grants the authenticated role what PostgREST will need', () => {
    const sql = supabaseDdl({ table: 'blobs', schema: 's' });

    expect(sql).toContain('grant usage on schema "s" to authenticated;');
    expect(sql).toContain('grant select, insert, update, delete on "s"."blobs" to authenticated;');
  });

  it('escapes a quote rather than letting it end the identifier', () => expect(supabaseDdl({ table: 'we"ird' })).toContain('public."we""ird"'));
});

describe('projectRef', () => {
  it('reads the ref out of a project URL', () => expect(projectRef('https://xzggjlxocwclieepmzki.supabase.co')).toBe('xzggjlxocwclieepmzki'));

  it('ignores a path and trailing slash', () => expect(projectRef('https://abc.supabase.co/rest/v1/')).toBe('abc'));

  // Only supabase.co hosts are addressable by the Management API, so anything
  // else must not be handed to it as though it were.
  it('refuses a host that is not a Supabase project', () => {
    expect(projectRef('https://example.com')).toBe(null);
    expect(projectRef('not a url')).toBe(null);
    expect(projectRef(undefined)).toBe(null);
  });
});
