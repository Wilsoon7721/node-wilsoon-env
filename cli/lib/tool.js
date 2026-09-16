import { spawn as nodeSpawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

const CMD_SPECIAL = /[\s"^&|<>()%!]/;

export function quoteForCmd(arg) {
  if (!CMD_SPECIAL.test(arg)) return arg;

  return (
    '"'
    + String(arg)
      .replace(/(\\*)"/g, '$1$1\\"')
      .replace(/(\\*)$/, '$1$1')
    + '"'
  );
}

const isFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Where a CLI lives: the project's own node_modules first, walking up for workspaces, then PATH.
 * Nothing is ever downloaded - npx would, and would ask on a stdin that is carrying secrets.
 *
 * @returns {string|null}
 */
export function findTool(name, cwd, { env = process.env, platform = process.platform } = {}) {
  const extensions = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];

  for (let dir = path.resolve(cwd);; dir = path.dirname(dir)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, 'node_modules', '.bin', name + ext.toLowerCase());
      if (isFile(candidate)) return candidate;
    }

    if (path.dirname(dir) === dir) break;
  }

  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (isFile(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * Run a CLI with `stdin` written to it and closed. Secrets travel on stdin and
 * nowhere else: never an argument, which any process on the machine can list,
 * and never an environment variable, which the child passes on to its own.
 *
 * @returns {Promise<{code: number, output: string}>} output is only collected when not inherited
 */
export function runTool(bin, argv, { cwd, stdin = '', inherit = false, spawn = nodeSpawn } = {}) {
  const stdio = ['pipe', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'];
  const child = process.platform === 'win32' ? spawn([bin, ...argv].map(quoteForCmd).join(' '), { cwd, stdio, shell: true }) : spawn(bin, argv, { cwd, stdio });

  return new Promise((resolve) => {
    let output = '';

    child.stdout?.on('data', (chunk) => (output += chunk));
    child.stderr?.on('data', (chunk) => (output += chunk));

    child.on('error', (err) => resolve({ code: 1, output: err.message }));
    child.on('close', (code, signal) => resolve({ code: signal ? 1 : (code ?? 0), output }));

    // A tool that exits before reading everything closes the pipe under us; its exit code says what happened
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}
