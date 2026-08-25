export const MAGIC = Buffer.from('WENV', 'ascii');
export const FORMAT = 1;

export const KIND_IDENTITY = 1;
export const KIND_PAYLOAD = 2;

export const ALG_AES_256_GCM = 1;

export const NONCE_LEN = 12;
export const TAG_LEN = 16;
export const KEYID_LEN = 8;
export const X25519_LEN = 32;
export const DEK_LEN = 32;

export const IDENTITY_HEADER_LEN = 12;
export const IDENTITY_BLOB_LEN = IDENTITY_HEADER_LEN + 16 + NONCE_LEN + X25519_LEN + TAG_LEN; // 88

export const PAYLOAD_HEADER_LEN = 16;
export const SLOT_LEN = KEYID_LEN + X25519_LEN + NONCE_LEN + DEK_LEN + TAG_LEN; // 100

export const MAX_SLOTS = 255;

// Reject anything that is not one of ours before reading a single field off it.
export function assertMagic(blob, kind) {
  if (!Buffer.isBuffer(blob) || blob.length < 6) throw new Error('Not a wilsoon-env blob: too short.');

  if (!blob.subarray(0, 4).equals(MAGIC)) throw new Error('Not a wilsoon-env blob: bad magic.');

  const format = blob[4];
  if (format !== FORMAT) throw new Error(`Blob format ${format} is not supported by this version. Upgrade @wilsoon/env.`);

  if (blob[5] !== kind) throw new Error(`Expected a ${kind === KIND_IDENTITY ? 'identity' : 'payload'} blob, got kind ${blob[5]}.`);
}

export function packIdentityHeader({ id, log2m, t, p }) {
  const h = Buffer.alloc(IDENTITY_HEADER_LEN);
  MAGIC.copy(h, 0);
  h[4] = FORMAT;
  h[5] = KIND_IDENTITY;
  h[6] = id;
  h[7] = log2m;
  h[8] = t;
  h[9] = p;
  // h[10..12] is reserved
  return h;
}

export function unpackIdentityHeader(blob) {
  assertMagic(blob, KIND_IDENTITY);
  if (blob.length !== IDENTITY_BLOB_LEN) throw new Error(`Identity blob must be ${IDENTITY_BLOB_LEN} bytes, got ${blob.length}.`);

  return { id: blob[6], log2m: blob[7], t: blob[8], p: blob[9] };
}

export function packPayloadHeader({ slots, version }) {
  if (!Number.isInteger(slots) || slots < 1 || slots > MAX_SLOTS) throw new Error(`Slot count must be 1..${MAX_SLOTS}.`);

  const h = Buffer.alloc(PAYLOAD_HEADER_LEN);
  MAGIC.copy(h, 0);
  h[4] = FORMAT;
  h[5] = KIND_PAYLOAD;
  h[6] = ALG_AES_256_GCM;
  h[7] = slots;
  h.writeBigUInt64LE(BigInt(version), 8);
  return h;
}

export function unpackPayloadHeader(blob) {
  assertMagic(blob, KIND_PAYLOAD);
  if (blob.length < PAYLOAD_HEADER_LEN) throw new Error('Payload blob is truncated.');

  const alg = blob[6];
  if (alg !== ALG_AES_256_GCM) throw new Error(`Unsupported payload cipher ${alg}.`);

  const slots = blob[7];
  if (slots < 1) throw new Error('Payload blob has no recipient slots.');

  const bodyStart = PAYLOAD_HEADER_LEN + slots * SLOT_LEN;
  if (blob.length < bodyStart + NONCE_LEN + TAG_LEN) throw new Error('Payload blob is truncated: slot table overruns the buffer.');

  return { alg, slots, version: blob.readBigUInt64LE(8), bodyStart };
}

/* AAD */

function lp(str) {
  const b = Buffer.from(String(str), 'utf8');
  if (b.length > 0xffff) throw new Error('Context string is too long to authenticate.');

  const len = Buffer.alloc(2);
  len.writeUInt16LE(b.length);
  return Buffer.concat([len, b]);
}

function u64(value) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}

/**
 * What the body ciphertext is bound to.
 * Stops a .env.local blob being served up as .env.production, and what makes rollback detectable as version is authenticated
 */
export function bodyAad({ project, name, version }) {
  return Buffer.concat([MAGIC, Buffer.from([FORMAT, KIND_PAYLOAD]), u64(version), lp(project), lp(name)]);
}

/** What each wrapped DEK is bound to. Includes the keyid, so a slot cannot be moved between recipients. */
export function slotAad({ project, name, version, keyid }) {
  if (!Buffer.isBuffer(keyid) || keyid.length !== KEYID_LEN) throw new Error('slotAad needs an 8-byte keyid.');

  return Buffer.concat([Buffer.from('WENVSLOT', 'ascii'), Buffer.from([FORMAT]), u64(version), keyid, lp(project), lp(name)]);
}
