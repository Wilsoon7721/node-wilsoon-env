import { createCipheriv, createDecipheriv, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { keyIdOf, privateFromRaw, publicFromRaw, publicOf, rawPublic } from './identity.js';
import { DEK_LEN, KEYID_LEN, MAX_SLOTS, NONCE_LEN, PAYLOAD_HEADER_LEN, SLOT_LEN, TAG_LEN, X25519_LEN, bodyAad, packPayloadHeader, slotAad, unpackPayloadHeader } from './header.js';

// Envelope encryption: one random key encrypts the file, and that key is wrapped once per recipient.
const WRAP_INFO = Buffer.from('wilsoon-env/v1/wrap', 'ascii');

// Derive a wrapping key from an X25519 exchange.
function wrapKey(shared, ephemeralPublicRaw, recipientPublicRaw) {
  const info = Buffer.concat([WRAP_INFO, ephemeralPublicRaw, recipientPublicRaw]);
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info, 32));
}

/**
 * Seal a file for a set of recipients.
 *
 * @param {object} args
 * @param {Buffer|string} args.plaintext
 * @param {Buffer[]} args.recipients
 * @param {string} args.project
 * @param {string} args.name
 * @param {number|bigint} args.version
 * @returns {Buffer}
 */
export function seal({ plaintext, recipients, project, name, version }) {
  if (!Array.isArray(recipients) || recipients.length === 0) throw new Error('A payload needs at least one recipient.');

  if (recipients.length > MAX_SLOTS) throw new Error(`At most ${MAX_SLOTS} recipients per payload.`);

  const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const dek = randomBytes(DEK_LEN);
  const header = packPayloadHeader({ slots: recipients.length, version });

  const slots = recipients.map((recipientPublicRaw) => {
    if (!Buffer.isBuffer(recipientPublicRaw) || recipientPublicRaw.length !== X25519_LEN) throw new Error(`Recipient keys must be ${X25519_LEN} raw bytes.`);

    const keyid = keyIdOf(recipientPublicRaw);

    const ephemeral = generateKeyPairSync('x25519');
    const ephemeralPublicRaw = rawPublic(ephemeral.publicKey);

    const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicFromRaw(recipientPublicRaw) });
    const key = wrapKey(shared, ephemeralPublicRaw, recipientPublicRaw);

    const nonce = randomBytes(NONCE_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(slotAad({ project, name, version, keyid }));

    const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);

    return Buffer.concat([keyid, ephemeralPublicRaw, nonce, wrapped, cipher.getAuthTag()]);
  });

  const bodyNonce = randomBytes(NONCE_LEN);
  const bodyCipher = createCipheriv('aes-256-gcm', dek, bodyNonce);
  bodyCipher.setAAD(bodyAad({ project, name, version }));

  const ciphertext = Buffer.concat([bodyCipher.update(body), bodyCipher.final()]);

  return Buffer.concat([header, ...slots, bodyNonce, bodyCipher.getAuthTag(), ciphertext]);
}

/**
 * Open a sealed file with an identity private key.
 *
 * @returns {{ plaintext: Buffer, version: bigint }}
 */
export function open({ blob, privateRaw, project, name }) {
  const { slots, version, bodyStart } = unpackPayloadHeader(blob);

  const recipientPublicRaw = publicOf(privateRaw);
  const wanted = keyIdOf(recipientPublicRaw);
  const privateKey = privateFromRaw(privateRaw);

  let dek = null;

  for (let i = 0; i < slots; i++) {
    const at = PAYLOAD_HEADER_LEN + i * SLOT_LEN;
    const keyid = blob.subarray(at, at + KEYID_LEN);

    if (!keyid.equals(wanted)) continue;

    const ephemeralPublicRaw = Buffer.from(blob.subarray(at + KEYID_LEN, at + KEYID_LEN + X25519_LEN));
    const nonce = blob.subarray(at + KEYID_LEN + X25519_LEN, at + KEYID_LEN + X25519_LEN + NONCE_LEN);
    const wrapped = blob.subarray(at + KEYID_LEN + X25519_LEN + NONCE_LEN, at + SLOT_LEN - TAG_LEN);
    const tag = blob.subarray(at + SLOT_LEN - TAG_LEN, at + SLOT_LEN);

    const shared = diffieHellman({ privateKey, publicKey: publicFromRaw(ephemeralPublicRaw) });
    const key = wrapKey(shared, ephemeralPublicRaw, recipientPublicRaw);

    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(slotAad({ project, name, version, keyid: Buffer.from(keyid) }));
    decipher.setAuthTag(tag);

    try {
      dek = Buffer.concat([decipher.update(wrapped), decipher.final()]);
      break;
    } catch {}
  }

  if (!dek) throw new Error('Could not open this file with that identity key: no usable recipient slot.');

  const bodyNonce = blob.subarray(bodyStart, bodyStart + NONCE_LEN);
  const bodyTag = blob.subarray(bodyStart + NONCE_LEN, bodyStart + NONCE_LEN + TAG_LEN);
  const ciphertext = blob.subarray(bodyStart + NONCE_LEN + TAG_LEN);

  const decipher = createDecipheriv('aes-256-gcm', dek, bodyNonce);
  decipher.setAAD(bodyAad({ project, name, version }));
  decipher.setAuthTag(bodyTag);

  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error(`Refusing to use ${name}: it failed authentication. The file has been altered, or it was written for a different project, filename or version.`);
  }

  return { plaintext, version };
}
