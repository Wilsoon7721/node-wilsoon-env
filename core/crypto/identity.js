import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { IDENTITY_BLOB_LEN, IDENTITY_HEADER_LEN, KEYID_LEN, NONCE_LEN, packIdentityHeader, TAG_LEN, unpackIdentityHeader, X25519_LEN } from './header.js';
import { DEFAULT_KDF, deriveKey, SALT_LEN } from './kdf.js';

const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export function generateIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicRaw: rawPublic(publicKey), privateRaw: rawPrivate(privateKey) };
}

export function rawPublic(keyObject) {
  return Buffer.from(keyObject.export({ format: 'jwk' }).x, 'base64url');
}

export function rawPrivate(keyObject) {
  return Buffer.from(keyObject.export({ format: 'jwk' }).d, 'base64url');
}

export function publicFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== X25519_LEN) throw new Error(`A public key must be ${X25519_LEN} bytes.`);

  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
}

export function privateFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== X25519_LEN) throw new Error(`A private key must be ${X25519_LEN} bytes.`);

  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, raw]), format: 'der', type: 'pkcs8' });
}

export function publicOf(privateRaw) {
  return rawPublic(createPublicKey(privateFromRaw(privateRaw)));
}

/** A short handle for a public key, used to pick which slot to try. */
export function keyIdOf(publicRaw) {
  return createHash('sha256').update(publicRaw).digest().subarray(0, KEYID_LEN);
}

/** Using RFC 4648 base32 charset (no padding, no checksum, lowercase) */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const PREFIX = 'wenv1';
const CHECKSUM_LEN = 4;

function base32Encode(buf) {
  let bits = 0,
    value = 0,
    out = '';

  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

function base32Decode(str) {
  let bits = 0,
    value = 0;
  const out = [];

  for (const ch of str) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid character "${ch}" in key.`);

    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

// Keys as copy-pasteable strings: prefix + base32(key || checksum)
const SECRET_PREFIX = 'wenvsk1';

function encodeKey(raw, prefix) {
  if (!Buffer.isBuffer(raw) || raw.length !== X25519_LEN) throw new Error(`A key must be ${X25519_LEN} bytes.`);

  const checksum = createHash('sha256').update(raw).digest().subarray(0, CHECKSUM_LEN);
  return prefix + base32Encode(Buffer.concat([raw, checksum]));
}

function decodeKey(str, prefix, label) {
  const text = String(str ?? '')
    .trim()
    .toLowerCase();

  if (!text.startsWith(prefix)) throw new Error(`Not a wilsoon-env ${label} (expected it to start with "${prefix}").`);

  const decoded = base32Decode(text.slice(prefix.length));

  if (decoded.length !== X25519_LEN + CHECKSUM_LEN) throw new Error(`The ${label} is the wrong length - it looks truncated, or has extra characters.`);

  const raw = decoded.subarray(0, X25519_LEN);
  const expected = createHash('sha256').update(raw).digest().subarray(0, CHECKSUM_LEN);

  if (!decoded.subarray(X25519_LEN).equals(expected)) throw new Error(`The ${label} failed its checksum - it was probably copied incompletely.`);

  return raw;
}

export function encodePublic(publicRaw) {
  return encodeKey(publicRaw, PREFIX);
}

export function decodePublic(str) {
  return decodeKey(str, PREFIX, 'public key');
}

/* A private key in text form, for a CI runner that can neither open a browser nor type a passphrase */
export function encodePrivate(privateRaw) {
  return encodeKey(privateRaw, SECRET_PREFIX);
}

export function decodePrivate(str) {
  return decodeKey(str, SECRET_PREFIX, 'private key');
}

/**
 * Encrypt the private key under the passphrase.
 *
 * @param {Buffer} privateRaw 32 bytes
 * @param {string} passphrase
 */
export async function sealIdentity(privateRaw, passphrase, params = DEFAULT_KDF) {
  if (!Buffer.isBuffer(privateRaw) || privateRaw.length !== X25519_LEN) throw new Error(`A private key must be ${X25519_LEN} bytes.`);

  const header = packIdentityHeader(params);
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = await deriveKey(passphrase, salt, params);

  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([header, salt]));

  const ciphertext = Buffer.concat([cipher.update(privateRaw), cipher.final()]);

  return Buffer.concat([header, salt, nonce, ciphertext, cipher.getAuthTag()]);
}

/**
 * @returns {Promise<Buffer>} the 32-byte private key
 */
export async function openIdentity(blob, passphrase) {
  const params = unpackIdentityHeader(blob);

  const salt = blob.subarray(IDENTITY_HEADER_LEN, IDENTITY_HEADER_LEN + SALT_LEN);
  const nonce = blob.subarray(IDENTITY_HEADER_LEN + SALT_LEN, IDENTITY_HEADER_LEN + SALT_LEN + NONCE_LEN);
  const ciphertext = blob.subarray(IDENTITY_BLOB_LEN - X25519_LEN - TAG_LEN, IDENTITY_BLOB_LEN - TAG_LEN);
  const tag = blob.subarray(IDENTITY_BLOB_LEN - TAG_LEN);

  const key = await deriveKey(passphrase, Buffer.from(salt), params);

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.concat([blob.subarray(0, IDENTITY_HEADER_LEN), salt]));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Could not unlock the identity key: wrong passphrase, or the blob has been altered.');
  }
}
