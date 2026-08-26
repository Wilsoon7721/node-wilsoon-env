import { loadConfig } from './config.js';
import { KIND_ENV, KIND_IDENTITY, resolveProvider } from './provider.js';
import { decodePublic, keyIdOf, openIdentity, publicOf } from './crypto/identity.js';

export const IDENTITY_NAME = 'default';

// Everything a command needs before it can do anything: config, provider, project
export async function openSession({ cwd = process.cwd() } = {}) {
  const loaded = await loadConfig(cwd);

  if (!loaded) throw new Error('No wilsoon-env configuration found here or in any parent directory.\n\n  Run "npx @wilsoon/env setup" to create one.\n');

  const provider = await resolveProvider(loaded.config, loaded.dir);

  return { ...loaded, provider, project: loaded.config.project, envRef: (name) => ({ project: loaded.config.project, kind: KIND_ENV, name }), identityRef: () => ({ project: loaded.config.project, kind: KIND_IDENTITY, name: IDENTITY_NAME }) };
}

// Get recipient public keys from config, decode and verify checksum
export function recipientKeys(config) {
  if (!config.recipients.length) throw new Error('This project has no recipients configured, so there is nobody to encrypt to.\n\n  Run "npx @wilsoon/env setup" first.\n');

  return config.recipients.map((r) => {
    try {
      return { ...r, publicRaw: decodePublic(r.pubkey) };
    } catch (err) {
      throw new Error(`Recipient "${r.name ?? r.pubkey}" in your config has an unusable public key: ${err.message}`);
    }
  });
}

// Fetch the identity blob and unlock it
export async function unlockIdentity(session, askPassphrase) {
  const stored = await session.provider.get(session.identityRef());

  if (!stored) throw new Error(`No identity key is stored for "${session.project}".\n\n  Run "npx @wilsoon/env setup" on a machine that has one, or restore it from your recovery notes.\n`);

  const passphrase = await askPassphrase();
  const privateRaw = await openIdentity(stored.blob, passphrase);

  return { privateRaw, keyid: keyIdOf(publicOf(privateRaw)) };
}
