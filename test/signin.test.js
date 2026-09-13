import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeCredential } from '../auth/tokens.js';
import * as prompt from '../cli/lib/prompt.js';
import { ensureSignedIn } from '../cli/lib/signin.js';

const oidc = { provider: 'supabase', options: { url: 'https://abc.supabase.co', anonKey: 'k' }, auth: { type: 'oidc', issuer: 'https://id.example', clientId: 'c' } };

let asked;

beforeEach(async () => {
  vi.stubEnv('WILSOON_ENV_CREDENTIALS_DIR', await mkdtemp(path.join(tmpdir(), 'wenv-signin-')));
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  asked = vi.spyOn(prompt, 'confirm').mockResolvedValue(false);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ensureSignedIn', () => {
  // CI must fail fast with instructions, never block on a prompt nobody will see.
  it('never asks without a terminal', async () => {
    vi.spyOn(prompt, 'isInteractive').mockReturnValue(false);

    await ensureSignedIn(oidc, { flags: {} });
    expect(asked).not.toHaveBeenCalled();
  });

  it('has nothing to ask about for a store without users', async () => {
    vi.spyOn(prompt, 'isInteractive').mockReturnValue(true);

    await ensureSignedIn({ provider: 's3', options: { bucket: 'b' } }, { flags: {} });
    expect(asked).not.toHaveBeenCalled();
  });

  it('stays quiet when a service key will be used instead', async () => {
    vi.spyOn(prompt, 'isInteractive').mockReturnValue(true);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service');

    await ensureSignedIn(oidc, { flags: {} });
    expect(asked).not.toHaveBeenCalled();
  });

  it('stays quiet when this machine already holds a working token', async () => {
    vi.spyOn(prompt, 'isInteractive').mockReturnValue(true);
    await writeCredential('https://id.example', { access_token: 't', expiresAt: Date.now() + 3_600_000 });

    await ensureSignedIn(oidc, { flags: {} });
    expect(asked).not.toHaveBeenCalled();
  });

  it('offers to sign in on a machine that never has', async () => {
    vi.spyOn(prompt, 'isInteractive').mockReturnValue(true);

    await ensureSignedIn(oidc, { flags: {} });
    expect(asked).toHaveBeenCalledOnce();
  });

  // Day thirty-one: the token is stale and there is nothing left to refresh it with.
  it('offers again once a stored sign-in has lapsed for good', async () => {
    vi.spyOn(prompt, 'isInteractive').mockReturnValue(true);
    await writeCredential('https://id.example', { access_token: 't', expiresAt: Date.now() - 1000 });

    const said = [];
    console.log.mockImplementation((line = '') => said.push(String(line)));

    await ensureSignedIn(oidc, { flags: {} });

    expect(asked).toHaveBeenCalledOnce();
    expect(said.join('\n')).toMatch(/has expired/);
  });
});
