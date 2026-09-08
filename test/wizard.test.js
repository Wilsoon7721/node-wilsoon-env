import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { offerToSave, runWizard } from '../cli/commands/wizard.js';
import { listStores, readStore, removeStore, saveStore, storesPath } from '../cli/lib/stores.js';

/*
  Each prompt resumes the input stream when it starts waiting, so that is the cue
  to hand over the next scripted answer. Menus are driven by digit rather than
  arrow key: a digit selects outright, so one step is one write, with no
  dependence on how many redraws happened first.
*/
function scripted(steps) {
  const input = new PassThrough();

  input.isTTY = true;
  input.setRawMode = () => input;

  const written = [];
  const output = new PassThrough();

  output.isTTY = true;
  output.columns = 90;
  output.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };

  let sent = 0;
  const resume = input.resume.bind(input);

  input.resume = () => {
    const result = resume();

    if (sent < steps.length) {
      const step = steps[sent++];
      setImmediate(() => input.write(step));
    }

    return result;
  };

  return { io: { input, output }, transcript: () => written.join('') };
}

let home;
let said;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'wenv-wizard-'));
  said = [];

  vi.stubEnv('CI', '');
  vi.stubEnv('WILSOON_ENV_CREDENTIALS_DIR', home);
  vi.spyOn(console, 'log').mockImplementation((line = '') => said.push(String(line)));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the setup wizard', () => {
  it('asks only what the chosen provider needs', async () => {
    const t = scripted(['1', '.secrets\n', 'demo\n']);
    const answers = await runWizard({ cwd: path.join(home, 'my-app'), io: t.io });

    expect(answers).toMatchObject({ provider: 'local', options: { path: '.secrets' }, project: 'demo', auth: null });
  });

  it('defaults the project to the directory name, which is its namespace in the store', async () => {
    const t = scripted(['1', '\n', '\n']);
    const answers = await runWizard({ cwd: path.join(home, 'my-app'), io: t.io });

    expect(answers.project).toBe('my-app');
  });

  it('collects a supabase store and its issuer', async () => {
    const t = scripted(['2', 'https://xyz.supabase.co\n', 'anon-key-123\n', 'blobs\n', '@wilsoon/env\n', '1', 'https://id.example\n', 'my-client\n', 'proj\n']);
    const answers = await runWizard({ cwd: home, io: t.io });

    expect(answers.provider).toBe('supabase');
    expect(answers.options).toEqual({ url: 'https://xyz.supabase.co', anonKey: 'anon-key-123', table: 'blobs', schema: '@wilsoon/env' });
    expect(answers.auth).toEqual({ type: 'oidc', issuer: 'https://id.example', clientId: 'my-client' });
  });

  it('does not record the default schema, which would only drift from the dashboard', async () => {
    const t = scripted(['2', 'https://xyz.supabase.co\n', 'k\n', '\n', '\n', '2', 'proj\n']);
    const answers = await runWizard({ cwd: home, io: t.io });

    expect(answers.options.schema).toBeUndefined();
    expect(answers.options.table).toBe('wilsoon_env');
    expect(answers.auth).toEqual({ type: 'supabase' });
  });

  it('writes no auth block for a service key, and says why that is a risk', async () => {
    const t = scripted(['2', 'https://xyz.supabase.co\n', 'k\n', '\n', '\n', '3', 'proj\n']);
    const answers = await runWizard({ cwd: home, io: t.io });

    expect(answers.auth).toBe(null);
    expect(said.join('\n')).toMatch(/bypasses row level security/i);
  });

  // The config this writes is committed, so a secret must never be a question.
  it('names credentials as environment variables instead of collecting them', async () => {
    const t = scripted(['4', 'acct-1\n', 'ns-1\n', 'proj\n']);
    const answers = await runWizard({ cwd: home, io: t.io });

    expect(answers.options).toEqual({ accountId: 'acct-1', namespaceId: 'ns-1' });
    expect(Object.keys(answers.options)).not.toContain('apiToken');
    expect(said.join('\n')).toContain('CLOUDFLARE_API_TOKEN');
  });

  it('offers a saved store first, and reuses it without asking anything about it', async () => {
    await saveStore('personal', { provider: 'supabase', options: { url: 'https://xyz.supabase.co', table: 'blobs' }, auth: { type: 'oidc', issuer: 'https://id.example' } });

    const t = scripted(['1', 'second-project\n']);
    const answers = await runWizard({ cwd: home, io: t.io });

    expect(answers).toMatchObject({
      provider: 'supabase',
      options: { url: 'https://xyz.supabase.co', table: 'blobs' },
      auth: { type: 'oidc', issuer: 'https://id.example' },
      project: 'second-project',
      saved: true
    });
  });

  it('still lets you set up a different store when one is saved', async () => {
    await saveStore('personal', { provider: 'supabase', options: {}, auth: null });

    const t = scripted(['2', '1', '.secrets\n', 'other\n']);
    const answers = await runWizard({ cwd: home, io: t.io });

    expect(answers).toMatchObject({ provider: 'local', saved: false });
  });
});

describe('offerToSave', () => {
  it('keeps the store when asked, so the next project is one question', async () => {
    const t = scripted(['y\n', 'personal\n']);
    const name = await offerToSave({ provider: 'local', options: { path: '.secrets' }, auth: null }, t.io);

    expect(name).toBe('personal');
    await expect(readStore('personal')).resolves.toMatchObject({ provider: 'local', options: { path: '.secrets' } });
  });

  it('keeps nothing when declined', async () => {
    const t = scripted(['n\n']);

    await expect(offerToSave({ provider: 'local', options: {}, auth: null }, t.io)).resolves.toBe(null);
    await expect(listStores()).resolves.toEqual([]);
  });
});

describe('saved stores', () => {
  it('round-trips, lists in order, and removes', async () => {
    await saveStore('b-store', { provider: 'local', options: { path: 'x' }, auth: null });
    await saveStore('a-store', { provider: 's3', options: { bucket: 'things' }, auth: null });

    await expect(listStores()).resolves.toMatchObject([
      { name: 'a-store', provider: 's3' },
      { name: 'b-store', provider: 'local' }
    ]);

    await expect(removeStore('a-store')).resolves.toBe(true);
    await expect(removeStore('a-store')).resolves.toBe(false);
    await expect(readStore('a-store')).resolves.toBe(null);
  });

  it('survives a corrupt file rather than taking the CLI down with it', async () => {
    await writeFile(storesPath(), 'not json at all');
    await expect(listStores()).resolves.toEqual([]);
  });

  it('keeps them beside the credentials, out of any repository', async () => {
    await saveStore('x', { provider: 'local', options: {}, auth: null });

    expect(storesPath().startsWith(home)).toBe(true);
    expect(JSON.parse(await readFile(storesPath(), 'utf8'))).toHaveProperty('x.provider', 'local');
  });
});
