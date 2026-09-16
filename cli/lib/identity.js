import { encodePublic, generateIdentity, keyIdOf, sealIdentity } from '../../core/crypto/identity.js';
import { identityAccount, remember } from '../../core/keychain.js';
import { ensureStored, personalRef, readPersonal, writePersonal } from '../../core/personal.js';
import { newPassphrase, password, requireInteractive } from './prompt.js';
import { note } from './ui.js';

/**
 * The identity a project should list as you: the one this machine already knows,
 * or a new one if it knows none.
 *
 * `fresh` mints a key for this project alone and leaves your personal identity
 * untouched - the way out when a store already files someone else under your id.
 *
 * @returns {Promise<{keyid: string, pubkey: string, reused: boolean}>}
 */
export async function identityFor(provider, { fresh = false, purpose }) {
  const personal = fresh ? null : await readPersonal();

  if (personal) {
    await ensureStored(provider, personal, async () => process.env.WILSOON_ENV_PASSPHRASE ?? (requireInteractive(purpose), await password('  Passphrase: ')));

    note('Using your identity from this machine - no new key, and nothing to type.');
    console.log('');

    return { keyid: personal.keyid, pubkey: personal.pubkey, reused: true };
  }

  note(fresh ? 'This passphrase protects a key for this project alone.' : 'Your passphrase protects the one identity key every project you set up will use.');
  note('It is never sent anywhere, and it cannot be recovered.');
  console.log('');

  const passphrase = process.env.WILSOON_ENV_PASSPHRASE ?? (requireInteractive(purpose), await newPassphrase());

  for (let attempt = 0; attempt < 3; attempt++) {
    const { publicRaw, privateRaw } = generateIdentity();
    const keyid = keyIdOf(publicRaw).toString('hex');

    // A brand new random key whose id is already taken is a genuine collision, and the fix is simply another key
    if (await provider.get(personalRef(keyid))) continue;

    const sealed = await sealIdentity(privateRaw, passphrase);
    const pubkey = encodePublic(publicRaw);

    await provider.put(personalRef(keyid), sealed);

    if (!fresh) await writePersonal({ keyid, pubkey, sealed });

    await remember(identityAccount(keyid), privateRaw);

    return { keyid, pubkey, reused: false };
  }

  throw new Error('Could not find an unused key id in three tries. That should never happen - check the store is not answering every read with a blob.');
}
