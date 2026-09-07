import { loadConfig } from './config.js';
import { KIND_ENV, KIND_IDENTITY, closeProvider, resolveProvider } from './provider.js';
import { decodePrivate, decodePublic, keyIdOf, openIdentity, publicOf } from './crypto/identity.js';
import { matchesAny } from './dotenv.js';
import { accountFor, forget, recall, remember } from './keychain.js';

const opened = new Set();

/** Release every provider this process opened, safe even with nothing to close */
export async function closeSessions() {
  const all = [...opened];
  opened.clear();

  for (const provider of all) await closeProvider(provider);
}

// Everything a command needs before it can do anything - config, provider, project
export async function openSession({ cwd = process.cwd() } = {}) {
  const loaded = await loadConfig(cwd);

  if (!loaded) throw new Error('No wilsoon-env configuration found here or in any parent directory.\n\n  Run "npx @wilsoon/env setup" to create one.\n');

  const provider = await resolveProvider(loaded.config, loaded.dir);
  opened.add(provider);

  return {
    ...loaded,
    provider,
    project: loaded.config.project,
    envRef: (name) => ({ project: loaded.config.project, kind: KIND_ENV, name }),
    identityRef: (keyid) => ({ project: loaded.config.project, kind: KIND_IDENTITY, name: String(keyid) })
  };
}

/** Decide whose identity to unlock. A store may hold several, so `--as` is used to name one. */
export async function findIdentity(session, { as } = {}) {
  const stored = (await session.provider.list(session.project)).filter((e) => e.kind === KIND_IDENTITY);

  const nameOf = (keyid) => session.config.recipients.find((r) => r.keyid === keyid)?.name;
  const describe = (entry) => nameOf(entry.name) ?? entry.name;

  if (as) {
    const wanted = session.config.recipients.find((r) => r.name === as || r.keyid === as);

    if (!wanted) throw new Error(`No recipient called "${as}" in this project's config.\n\n  Known: ${session.config.recipients.map((r) => r.name ?? r.keyid).join(', ')}\n`);

    const match = stored.find((e) => e.name === wanted.keyid);

    if (!match) throw new Error(`No identity key is stored for "${as}".\n\n  Their key lives wherever they set it up - a CI key, or a teammate's own store.\n`);

    return { ref: session.identityRef(match.name), keyid: match.name, name: describe(match) };
  }

  if (stored.length === 1) return { ref: session.identityRef(stored[0].name), keyid: stored[0].name, name: describe(stored[0]) };

  if (stored.length === 0) throw new Error(`No identity key is stored for "${session.project}".\n\n  Run "npx @wilsoon/env setup" on a machine that has one, or restore it from your recovery notes.\n`);

  throw new Error(`This project has ${stored.length} stored identities.\n\n  Choose one with --as: ${stored.map(describe).sort().join(', ')}\n`);
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

// Which recipients a given file is sealed to. No `files` means all of them.
export function recipientsFor(name, recipients) {
  return recipients.filter((r) => !r.files?.length || matchesAny(name, r.files));
}

// Fetch the identity blob and unlock it
export async function unlockIdentity(session, askPassphrase, { as, cache = true } = {}) {
  // CI has no browser and no passphrase, so it carries a scoped private key directly
  const fromEnv = process.env.WILSOON_ENV_KEY;

  if (fromEnv) {
    const privateRaw = decodePrivate(fromEnv);
    return { privateRaw, keyid: keyIdOf(publicOf(privateRaw)), source: 'WILSOON_ENV_KEY' };
  }

  const chosen = await findIdentity(session, { as });
  const account = accountFor(session.project, chosen.keyid);

  if (cache) {
    const cached = await recall(account);

    // A cached key that no longer matches the stored identity is stale - drop it
    if (cached && keyIdOf(publicOf(cached)).toString('hex') === chosen.keyid) return { privateRaw: cached, keyid: keyIdOf(publicOf(cached)), name: chosen.name, source: 'keychain' };

    if (cached) await forget(account);
  }

  const stored = await session.provider.get(chosen.ref);

  const passphrase = await askPassphrase();
  const privateRaw = await openIdentity(stored.blob, passphrase);

  if (cache) await remember(account, privateRaw);

  return { privateRaw, keyid: keyIdOf(publicOf(privateRaw)), name: chosen.name, source: 'passphrase' };
}
