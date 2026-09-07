import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Cache an unlocked identity key so a passphrase is asked for once per machine rather than once per command.
 *   win32 - DPAPI via PowerShell, ciphertext in a file under %APPDATA%
 *   darwin - the login keychain, via `security`
 *   linux - libsecret, via `secret-tool`
 */

const SERVICE = 'wilsoon-env';
const DEFAULT_TTL_DAYS = 14;

function cacheDir() {
  if (process.env.WILSOON_ENV_CACHE_DIR) return process.env.WILSOON_ENV_CACHE_DIR;

  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, SERVICE, 'cache');
  }

  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), SERVICE);
}

/** Runs a helper, feeding stdin, so no secret is ever visible in the process list. */
function run(file, args, input) {
  return new Promise((resolve) => {
    let child;

    try {
      child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      return resolve(null);
    }

    let out = '';
    let failed = false;

    child.stdout.on('data', (d) => (out += d));
    child.stderr.resume();
    child.on('error', () => {
      failed = true;
      resolve(null);
    });

    child.on('close', (code) => {
      if (failed) return;

      resolve(code === 0 ? out.trim() : null);
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** DPAPI binds the ciphertext to this Windows user account, so the file on disk is useless to anyone else on the machine. */
const POWERSHELL = ['-NoProfile', '-NonInteractive', '-Command'];

const dpapi = {
  name: 'windows-dpapi',

  async available() {
    return (await run('powershell', [...POWERSHELL, 'Write-Output ok'])) === 'ok';
  },

  async protect(plaintext) {
    return await run('powershell', [...POWERSHELL, '$p = [Console]::In.ReadToEnd(); ConvertFrom-SecureString -SecureString (ConvertTo-SecureString -String $p -AsPlainText -Force)'], plaintext);
  },

  async unprotect(protectedText) {
    return await run(
      'powershell',
      [...POWERSHELL, '$e = [Console]::In.ReadToEnd().Trim(); $s = ConvertTo-SecureString -String $e; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))'],
      protectedText
    );
  }
};

async function fileGet(account) {
  const file = path.join(cacheDir(), createHash('sha256').update(account).digest('hex') + '.bin');

  let protectedText;
  try {
    protectedText = await readFile(file, 'utf8');
  } catch {
    return null;
  }

  const plaintext = await dpapi.unprotect(protectedText);
  return plaintext || null;
}

async function fileSet(account, secret) {
  const protectedText = await dpapi.protect(secret);
  if (!protectedText) return false;

  const file = path.join(cacheDir(), createHash('sha256').update(account).digest('hex') + '.bin');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, protectedText, { mode: 0o600 });

  return true;
}

async function fileClear(account) {
  const file = path.join(cacheDir(), createHash('sha256').update(account).digest('hex') + '.bin');

  try {
    await rm(file);
    return true;
  } catch {
    return false;
  }
}

// MacOS

const macos = {
  name: 'macos-keychain',
  available: async () => (await run('security', ['-h'])) !== null || true,
  get: (account) => run('security', ['find-generic-password', '-a', account, '-s', SERVICE, '-w']),
  set: async (account, secret) => (await run('security', ['add-generic-password', '-U', '-a', account, '-s', SERVICE, '-w', secret])) !== null,
  clear: async (account) => (await run('security', ['delete-generic-password', '-a', account, '-s', SERVICE])) !== null
};

// Linux

const libsecret = {
  name: 'libsecret',
  available: async () => (await run('secret-tool', ['--version'])) !== null,
  get: (account) => run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]),
  set: async (account, secret) => (await run('secret-tool', ['store', '--label', `${SERVICE} ${account}`, 'service', SERVICE, 'account', account], secret)) !== null,
  clear: async (account) => (await run('secret-tool', ['clear', 'service', SERVICE, 'account', account])) !== null
};

function backend() {
  if (process.env.WILSOON_ENV_NO_KEYCHAIN) return null;
  if (process.platform === 'win32') return { name: dpapi.name, get: fileGet, set: fileSet, clear: fileClear };
  if (process.platform === 'darwin') return macos;
  if (process.platform === 'linux') return libsecret;

  return null;
}

export function describe() {
  return backend()?.name ?? null;
}

export const accountFor = (project, keyid) => `${project}:${keyid}`;

/**
 * @returns {Promise<Buffer|null>} the cached key, or null for any reason at all
 */
export async function recall(account) {
  const store = backend();
  if (!store) return null;

  let payload;
  try {
    payload = await store.get(account);
  } catch {
    return null;
  }

  if (!payload) return null;

  try {
    const { key, expires } = JSON.parse(payload);

    if (!key || (expires && Date.now() > expires)) {
      await forget(account);
      return null;
    }

    return Buffer.from(key, 'hex');
  } catch {
    return null;
  }
}

/** @returns {Promise<boolean>} whether it was actually cached. Never throws. */
export async function remember(account, privateRaw, { days = DEFAULT_TTL_DAYS } = {}) {
  const store = backend();
  if (!store) return false;

  try {
    return await store.set(account, JSON.stringify({ key: privateRaw.toString('hex'), expires: Date.now() + days * 86400000 }));
  } catch {
    return false;
  }
}

export async function forget(account) {
  const store = backend();
  if (!store) return false;

  try {
    return await store.clear(account);
  } catch {
    return false;
  }
}
