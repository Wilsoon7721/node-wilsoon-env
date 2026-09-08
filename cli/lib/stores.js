import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { credentialsPath } from '../../auth/tokens.js';

export function storesPath() {
  return path.join(path.dirname(credentialsPath()), 'stores.json');
}

async function readAll() {
  try {
    const parsed = JSON.parse(await readFile(storesPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** @returns {Promise<Array<{name: string, provider: string, options: object, auth: object|null}>>} */
export async function listStores() {
  return Object.entries(await readAll())
    .map(([name, store]) => ({ name, provider: store.provider, options: store.options ?? {}, auth: store.auth ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readStore(name) {
  const found = (await readAll())[name];
  return found ? { name, provider: found.provider, options: found.options ?? {}, auth: found.auth ?? null } : null;
}

export async function saveStore(name, { provider, options, auth }) {
  const all = await readAll();
  all[name] = { provider, options: options ?? {}, ...(auth ? { auth } : {}) };

  const file = storesPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });

  try {
    await chmod(file, 0o600);
  } catch {}

  return file;
}

export async function removeStore(name) {
  const all = await readAll();
  if (!(name in all)) return false;

  delete all[name];
  await writeFile(storesPath(), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });

  return true;
}
