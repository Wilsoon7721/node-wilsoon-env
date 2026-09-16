import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { credentialsPath } from '../auth/tokens.js';
import { openIdentity, publicOf } from './crypto/identity.js';
import { KIND_IDENTITY } from './provider.js';

/* One identity per person, shared by every project they work on */

export const IDENTITY_PROJECT = '~identities';

export const personalRef = (keyid) => ({ project: IDENTITY_PROJECT, kind: KIND_IDENTITY, name: String(keyid) });

export function personalPath() {
  return path.join(path.dirname(credentialsPath()), 'identity.json');
}

/** @returns {Promise<{keyid: string, pubkey: string, sealed: Buffer} | null>} */
export async function readPersonal() {
  try {
    const parsed = JSON.parse(await readFile(personalPath(), 'utf8'));
    if (!parsed?.keyid || !parsed?.pubkey || !parsed?.sealed) return null;

    return { keyid: parsed.keyid, pubkey: parsed.pubkey, sealed: Buffer.from(parsed.sealed, 'base64') };
  } catch {
    return null;
  }
}

// The sealed blob is kept too: it is only as readable as it is in the store, and it lets a new store receive your identity without asking for the passphrase.
export async function writePersonal({ keyid, pubkey, sealed }) {
  const file = personalPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ keyid, pubkey, sealed: Buffer.from(sealed).toString('base64') }, null, 2) + '\n', { mode: 0o600 });
}

export class IdentityClash extends Error {
  constructor(keyid) {
    super(`A different identity is already filed under your key id (${keyid}) in this store.`);
    this.name = 'IdentityClash';
    this.keyid = keyid;
  }
}

/**
 * Make sure this store holds your sealed identity, and that whatever is filed under your key id really is yours.
 */
export async function ensureStored(provider, personal, askPassphrase) {
  const ref = personalRef(personal.keyid);
  const existing = await provider.get(ref);

  if (!existing) {
    await provider.put(ref, personal.sealed);
    return 'uploaded';
  }

  if (Buffer.from(existing.blob).equals(personal.sealed)) return 'present';

  const passphrase = await askPassphrase();
  const mine = await openIdentity(personal.sealed, passphrase);

  let theirs = null;

  try {
    theirs = await openIdentity(Buffer.from(existing.blob), passphrase);
  } catch {}

  if (theirs && publicOf(theirs).equals(publicOf(mine))) return 'present';

  throw new IdentityClash(personal.keyid);
}
