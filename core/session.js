import { loadConfig } from './config.js';
import { decodePrivate, decodePublic, encodePublic, keyIdOf, openIdentity, publicOf } from './crypto/identity.js';
import { matchesAny } from './dotenv.js';
import { accountFor, forget, identityAccount, recall, remember } from './keychain.js';
import { personalRef, readPersonal, writePersonal } from './personal.js';
import { closeProvider, KIND_ENV, KIND_IDENTITY, resolveProvider } from './provider.js';

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
    identityRef: (keyid) => personalRef(keyid),
    // Identities from before they were personal lived beside each project's files
    legacyIdentityRef: (keyid) => ({ project: loaded.config.project, kind: KIND_IDENTITY, name: String(keyid) })
  };
}

/** A recipient's sealed identity from the store, wherever this version or an older one filed it */
export async function storedIdentity(session, keyid) {
  return (await session.provider.get(session.identityRef(keyid))) ?? (await session.provider.get(session.legacyIdentityRef(keyid)));
}

const described = (r) => ({ keyid: r.keyid, name: r.name ?? r.keyid });

/** Decide whose identity to unlock. `--as` names one; otherwise this machine's own identity wins. */
export async function findIdentity(session, { as } = {}) {
  const { recipients } = session.config;

  if (as) {
    const wanted = recipients.find((r) => r.name === as || r.keyid === as);

    if (!wanted) throw new Error(`No recipient called "${as}" in this project's config.\n\n  Known: ${recipients.map((r) => r.name ?? r.keyid).join(', ')}\n`);

    if (!(await storedIdentity(session, wanted.keyid))) throw new Error(`No identity key is stored for "${as}".\n\n  Their key lives wherever they set it up - a CI key, or a teammate's own store.\n`);

    return described(wanted);
  }

  const personal = await readPersonal();
  const mine = personal && recipients.find((r) => r.keyid === personal.keyid);
  if (mine) return described(mine);

  // Recipients like a CI key have nothing stored to unlock, so only count the ones that do
  const unlockable = [];
  for (const r of recipients) if (await storedIdentity(session, r.keyid)) unlockable.push(r);

  if (unlockable.length === 1) return described(unlockable[0]);

  if (!unlockable.length) throw new Error(`No identity key is stored for "${session.project}".\n\n  Run "npx @wilsoon/env setup" on a machine that has one, or restore it from your recovery notes.\n`);

  throw new Error(`This project has ${unlockable.length} stored identities.\n\n  Choose one with --as: ${unlockable.map((r) => r.name ?? r.keyid).sort().join(', ')}\n`);
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

  // Cached once per key, so unlocking in one project unlocks every project that key belongs to
  const shared = identityAccount(chosen.keyid);

  if (cache) {
    for (const account of [shared, accountFor(session.project, chosen.keyid)]) {
      const cached = await recall(account);
      if (!cached) continue;

      if (keyIdOf(publicOf(cached)).toString('hex') === chosen.keyid) {
        if (account !== shared) await remember(shared, cached);

        return { privateRaw: cached, keyid: keyIdOf(publicOf(cached)), name: chosen.name, source: 'keychain' };
      }

      await forget(account);
    }
  }

  const personal = await readPersonal();
  const sealed = (await storedIdentity(session, chosen.keyid))?.blob ?? (personal?.keyid === chosen.keyid ? personal.sealed : null);

  if (!sealed) throw new Error(`No identity key is stored for "${chosen.name}".`);

  const privateRaw = await openIdentity(Buffer.from(sealed), await askPassphrase());

  if (cache) await remember(shared, privateRaw);

  // The first unlock on a machine is how it learns whose identity is yours, so later projects here need nothing typed
  if (!personal) await writePersonal({ keyid: chosen.keyid, pubkey: encodePublic(publicOf(privateRaw)), sealed });

  return { privateRaw, keyid: keyIdOf(publicOf(privateRaw)), name: chosen.name, source: 'passphrase' };
}
