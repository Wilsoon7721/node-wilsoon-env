import { describe, expect, it } from 'vitest';
import { parseArgs } from '../cli/lib/args.js';
import { authFromFlags, normaliseIssuer, withIssuer } from '../cli/lib/authflags.js';

const flagsOf = (line) => parseArgs(line.split(' ').filter(Boolean)).flags;

describe('authFromFlags', () => {
  it('returns nothing when no flag asks for auth, so most providers stay untouched', () => expect(authFromFlags(flagsOf('--provider s3 --bucket things'))).toBe(null));

  it('keeps an existing block when the flags say nothing about auth', () => {
    const prior = { type: 'oidc', issuer: 'https://id.example' };
    expect(authFromFlags(flagsOf('--project other'), prior)).toEqual(prior);
  });

  it('infers oidc from --issuer alone, which is the common case', () => expect(authFromFlags(flagsOf('--issuer https://id.example --client-id abc'))).toEqual({ type: 'oidc', issuer: 'https://id.example', clientId: 'abc' }));

  it('edits a prior block rather than replacing it', () => {
    const prior = { type: 'oidc', issuer: 'https://old.example', clientId: 'abc', scope: 'openid email' };

    expect(authFromFlags(flagsOf('--issuer https://new.example'), prior)).toEqual({ ...prior, issuer: 'https://new.example' });
  });

  it('refuses an oidc block with no issuer, which would fail later at discovery', () => expect(() => authFromFlags(flagsOf('--auth oidc'))).toThrow(/needs an issuer/));

  it('allows supabase with no issuer, because its project url is the issuer', () => expect(authFromFlags(flagsOf('--auth supabase'))).toEqual({ type: 'supabase' }));

  it('rejects an unknown type instead of writing a config nothing can read', () => expect(() => authFromFlags(flagsOf('--auth oauth2'))).toThrow(/Unknown auth type/));

  it('rejects a bare --auth, which the parser hands over as true', () => expect(() => authFromFlags(flagsOf('--auth --issuer https://id.example'))).toThrow(/needs a value/));
});

describe('withIssuer', () => {
  // issuerKey(undefined) is '', so every supabase project on a machine would
  // otherwise share one credential slot and hand the wrong token to the wrong store.
  it('files a supabase block under its project url', () => expect(withIssuer({ type: 'supabase' }, 'https://abc.supabase.co/')).toEqual({ type: 'supabase', issuer: 'https://abc.supabase.co' }));

  it('never overwrites an issuer that was set on purpose', () => {
    const auth = { type: 'supabase', issuer: 'https://chosen.example' };
    expect(withIssuer(auth, 'https://abc.supabase.co')).toBe(auth);
  });

  it('leaves oidc alone, whose issuer is required anyway', () => {
    const auth = { type: 'oidc', issuer: 'https://id.example' };
    expect(withIssuer(auth, 'https://abc.supabase.co')).toBe(auth);
  });

  it('passes null through, so callers can chain it', () => expect(withIssuer(null, 'https://abc.supabase.co')).toBe(null));
});

describe('normaliseIssuer', () => {
  // A bare host is what people type; taking it literally only surfaces later as
  // a failed discovery against a relative URL.
  it('assumes https for a bare host', () => expect(normaliseIssuer('id.wilsoon.dev')).toBe('https://id.wilsoon.dev'));

  it('drops a trailing slash so credentials file under one key', () => expect(normaliseIssuer('https://id.example/')).toBe('https://id.example'));

  it('keeps a path, which some issuers need', () => expect(normaliseIssuer('https://example.com/auth/realms/x')).toBe('https://example.com/auth/realms/x'));

  it('allows plain http on loopback, where there is no network to listen on', () => expect(normaliseIssuer('http://localhost:3000')).toBe('http://localhost:3000'));

  it('refuses plain http anywhere else, since the token is a bearer credential', () => expect(() => normaliseIssuer('http://insecure.example')).toThrow(/https/));

  it('refuses something that is not a URL at all', () => expect(() => normaliseIssuer('not a url')).toThrow(/not a URL/));

  it('normalises whatever --issuer supplied', () => expect(authFromFlags(flagsOf('--issuer id.wilsoon.dev'))).toEqual({ type: 'oidc', issuer: 'https://id.wilsoon.dev' }));
});
