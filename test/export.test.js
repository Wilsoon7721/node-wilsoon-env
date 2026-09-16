import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exportEnv } from '../cli/commands/export.js';
import { push } from '../cli/commands/push.js';
import { setup } from '../cli/commands/setup.js';
import { findTool } from '../cli/lib/tool.js';

const SECRET = 'sk_live_do_not_print_me';
const PEM = '-----BEGIN KEY-----\nline two\n-----END KEY-----';

let dir;
let logs;
let calls;

const args = (target, flags = {}, rest = []) => ({ flags: { cwd: dir, ...flags }, positional: target ? [target] : [], rest });

// Stands in for child_process.spawn, and remembers what each run was handed
function fakeSpawn({ fail = () => false } = {}) {
  return (command, argv, options) => {
    if (!Array.isArray(argv)) options = argv;

    const line = Array.isArray(argv) ? [command, ...argv].join(' ') : command;
    const child = new EventEmitter();
    const call = { line, stdin: '' };

    child.stdin = new PassThrough();
    child.stdout = options.stdio[1] === 'pipe' ? new PassThrough() : null;
    child.stderr = options.stdio[2] === 'pipe' ? new PassThrough() : null;

    let input = '';
    child.stdin.on('data', (chunk) => (input += chunk));
    child.stdin.on('end', () => {
      call.stdin = input;
      calls.push(call);

      const refused = fail(call);
      if (refused) child.stderr?.write('Error: not allowed\n');

      setImmediate(() => child.emit('close', refused ? 1 : 0, null));
    });

    return child;
  };
}

const run = (a, spawnOptions) => exportEnv(a, { spawn: fakeSpawn(spawnOptions), locate: (bin) => `/bin/${bin}` });
const said = () => logs.join('\n');

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wenv-export-'));
  process.env.WILSOON_ENV_STATE_DIR = dir;
  process.env.WILSOON_ENV_PASSPHRASE = 'a sufficiently long passphrase';

  logs = [];
  calls = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));

  await writeFile(path.join(dir, '.env'), `API_KEY=${SECRET}\nPRIVATE_KEY="${PEM.replace(/\n/g, '\\n')}"\nEMPTY=\n`);
  await setup(args(null, { project: 'demo' }));
  await push(args(null, { yes: true }));

  await writeFile(path.join(dir, 'wrangler.jsonc'), '{}');
  await mkdir(path.join(dir, '.vercel'));
  await writeFile(path.join(dir, '.vercel', 'project.json'), '{}');

  logs = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.WILSOON_ENV_PASSPHRASE;
  delete process.env.WILSOON_ENV_STATE_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('export wrangler', () => {
  it('sends the chosen keys as JSON on stdin to secret bulk', async () => {
    expect(await run(args('wrangler', { keys: 'API_KEY,PRIVATE_KEY', yes: true }))).toBe(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].line).toMatch(/secret bulk/);
    expect(JSON.parse(calls[0].stdin)).toEqual({ API_KEY: SECRET, PRIVATE_KEY: PEM });
  });

  it('sends every key with --yes when nobody can be asked', async () => {
    expect(await run(args('wrangler', { yes: true }))).toBe(0);
    expect(Object.keys(JSON.parse(calls[0].stdin))).toEqual(['API_KEY', 'PRIVATE_KEY', 'EMPTY']);
  });

  it('passes --env and anything after -- through to wrangler', async () => {
    await run(args('wrangler', { yes: true, env: 'staging' }, ['--name', 'my-worker']));
    expect(calls[0].line).toMatch(/secret bulk --env staging --name my-worker/);
  });

  it('splits more than a hundred secrets into batches wrangler accepts', async () => {
    await writeFile(path.join(dir, '.env'), Array.from({ length: 150 }, (_, i) => `K${i}=v${i}`).join('\n'));
    await push(args(null, { yes: true }));

    expect(await run(args('wrangler', { yes: true }))).toBe(0);
    expect(calls.map((c) => Object.keys(JSON.parse(c.stdin)).length)).toEqual([100, 50]);
  });

  it('refuses without a wrangler config or a worker name', async () => {
    await rm(path.join(dir, 'wrangler.jsonc'));

    expect(await run(args('wrangler', { yes: true }))).toBe(1);
    expect(said()).toMatch(/--name my-worker/);
    expect(calls).toHaveLength(0);
  });
});

describe('export vercel', () => {
  it('adds each key as a sensitive variable, value on stdin with nothing added', async () => {
    expect(await run(args('vercel', { env: 'production', keys: 'API_KEY,PRIVATE_KEY', yes: true }))).toBe(0);

    expect(calls.map((c) => c.line)).toEqual([expect.stringMatching(/env add API_KEY production --sensitive --force$/), expect.stringMatching(/env add PRIVATE_KEY production --sensitive --force$/)]);
    expect(calls.map((c) => c.stdin)).toEqual([SECRET, PEM]);
  });

  it('scopes preview to a branch', async () => {
    await run(args('vercel', { env: 'preview', branch: 'feature-x', keys: 'API_KEY', yes: true }));
    expect(calls[0].line).toMatch(/env add API_KEY preview feature-x --sensitive/);
  });

  it('refuses a branch outside preview', async () => await expect(run(args('vercel', { env: 'production', branch: 'feature-x', yes: true }))).rejects.toThrow(/--branch only applies/));

  // Development values cannot be sensitive on Vercel, and quietly sending them as plain would be the one thing this must not do
  it('refuses development rather than sending a plain variable', async () => {
    await expect(run(args('vercel', { env: 'development', yes: true }))).rejects.toThrow(/cannot mark development variables as sensitive/);
    expect(calls).toHaveLength(0);
  });

  it('stops at the first refusal and says what did go through', async () => {
    expect(await run(args('vercel', { env: 'production', yes: true }), { fail: (c) => /PRIVATE_KEY/.test(c.line) })).toBe(1);

    expect(calls).toHaveLength(2);
    expect(said()).toMatch(/refused.*PRIVATE_KEY/);
    expect(said()).toMatch(/did go through: API_KEY/);
    expect(said()).toMatch(/not allowed/);
  });

  it('refuses a directory not linked to a project', async () => {
    await rm(path.join(dir, '.vercel'), { recursive: true });

    expect(await run(args('vercel', { env: 'production', yes: true }))).toBe(1);
    expect(said()).toMatch(/vercel link/);
  });

  it('needs an environment when nobody can be asked', async () => await expect(run(args('vercel', { yes: true }))).rejects.toThrow(/--env production/));
});

describe('export, whichever target', () => {
  it('never prints a value', async () => {
    await run(args('vercel', { env: 'production', yes: true }), { fail: (c) => /PRIVATE_KEY/.test(c.line) });
    await run(args('wrangler', { yes: true }));

    expect(said()).not.toContain(SECRET);
    expect(said()).not.toContain('line two');
  });

  it('never puts a value in the command line', async () => {
    await run(args('vercel', { env: 'production', yes: true }));
    await run(args('wrangler', { yes: true }));

    for (const call of calls) expect(call.line).not.toContain(SECRET);
  });

  it('writes nothing into the project', async () => {
    const before = (await readdir(dir)).sort();
    await run(args('wrangler', { yes: true }));

    expect((await readdir(dir)).sort()).toEqual(before);
  });

  it('says how to install a missing tool, before asking for anything', async () => {
    delete process.env.WILSOON_ENV_PASSPHRASE;

    expect(await exportEnv(args('wrangler', { yes: true }), { spawn: fakeSpawn(), locate: () => null })).toBe(1);
    expect(said()).toMatch(/npm i -D wrangler/);
  });

  it('will not send everything unasked', async () => {
    await expect(run(args('wrangler'))).rejects.toThrow(/--keys A,B.*--yes/);
    expect(calls).toHaveLength(0);
  });

  it('names keys that are not in the file', async () => await expect(run(args('wrangler', { keys: 'API_KEY,NOPE', yes: true }))).rejects.toThrow(/Not in the file: NOPE/));

  it('rejects a target it does not know', async () => await expect(run(args('netlify'))).rejects.toThrow(/Export to one of: vercel, wrangler/));

  it('lets a later file override an earlier one', async () => {
    await writeFile(path.join(dir, '.env.production'), 'API_KEY=prod\n');
    await push(args(null, { yes: true }));

    await run(args('wrangler', { file: '.env,.env.production', keys: 'API_KEY', yes: true }));
    expect(JSON.parse(calls[0].stdin)).toEqual({ API_KEY: 'prod' });
  });
});

describe('findTool', () => {
  it("finds a project's own install, from a subdirectory of a workspace", async () => {
    const bin = path.join(dir, 'node_modules', '.bin');
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, 'wrangler'), '');
    await mkdir(path.join(dir, 'apps', 'web'), { recursive: true });

    expect(findTool('wrangler', path.join(dir, 'apps', 'web'), { env: { PATH: '' }, platform: 'linux' })).toBe(path.join(bin, 'wrangler'));
  });

  it('falls back to PATH, with Windows extensions', async () => {
    const elsewhere = path.join(dir, 'global');
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, 'vercel.cmd'), '');

    expect(findTool('vercel', dir, { env: { PATH: elsewhere, PATHEXT: '.EXE;.CMD' }, platform: 'win32' })).toBe(path.join(elsewhere, 'vercel.cmd'));
  });

  it('returns null rather than reaching for a download', () => expect(findTool('definitely-not-installed', dir, { env: { PATH: '' }, platform: 'linux' })).toBe(null));
});
