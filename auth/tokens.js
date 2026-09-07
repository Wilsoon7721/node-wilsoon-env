import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { refresh as refreshOidc } from './oidc.js';
import { refresh as refreshSupabase } from './supabase.js';

const REFRESH = { oidc: refreshOidc, supabase: refreshSupabase };

/**
 * Access tokens on disk, keyed by issuer. These are bearer credentials for the store, not a key.
 */

const DIR_NAME = 'wilsoon-env';
const FILE_NAME = 'credentials.json';
const SKEW_MS = 60_000;

export function credentialsPath() {
  if (process.env.WILSOON_ENV_CREDENTIALS_DIR) return path.join(process.env.WILSOON_ENV_CREDENTIALS_DIR, FILE_NAME);

  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, DIR_NAME, FILE_NAME);
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), DIR_NAME, FILE_NAME);
}

export const issuerKey = (issuer) => String(issuer ?? '').replace(/\/+$/, '');

async function readAll() {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAll(store) {
  const file = credentialsPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });

  try {
    await chmod(file, 0o600);
  } catch {}
}

export async function readCredential(issuer) {
  return (await readAll())[issuerKey(issuer)] ?? null;
}

export async function writeCredential(issuer, credential) {
  const store = await readAll();
  store[issuerKey(issuer)] = credential;
  await writeAll(store);
  return credentialsPath();
}

export async function clearCredential(issuer) {
  const store = await readAll();
  const key = issuerKey(issuer);

  if (!(key in store)) return false;

  delete store[key];
  await writeAll(store);
  return true;
}

/**
 * The token to send, refreshing it if it has expired.
 *
 * @returns {Promise<string|null>} null when there is nothing stored, or when a refresh failed.
 */
export async function accessTokenFor(auth) {
  const stored = await readCredential(auth.issuer);
  if (!stored?.access_token) return null;

  const fresh = !stored.expiresAt || Date.now() + SKEW_MS < stored.expiresAt;
  if (fresh) return stored.access_token;

  if (!stored.refresh_token) return null;

  const renew = REFRESH[auth.type];
  if (!renew) return null;

  try {
    const renewed = await renew(auth, stored.refresh_token);

    await writeCredential(auth.issuer, {
      access_token: renewed.access_token,
      refresh_token: renewed.refresh_token ?? stored.refresh_token,
      expiresAt: renewed.expiresAt ?? (renewed.expires_in ? Date.now() + renewed.expires_in * 1000 : undefined),
      sub: renewed.sub ?? stored.sub,
      email: renewed.email ?? stored.email
    });

    return renewed.access_token;
  } catch {
    return null;
  }
}
