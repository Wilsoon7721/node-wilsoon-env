import { argon2id } from 'hash-wasm';

export const KDF_ARGON2ID = 1;
export const DEFAULT_KDF = Object.freeze({ id: KDF_ARGON2ID, log2m: 16, t: 3, p: 1 });
export const SALT_LEN = 16;
export const KEY_LEN = 32;

const MIN_LOG2M = 10; //   1 MiB
const MAX_LOG2M = 21; //   2 GiB
const MAX_T = 16;
const MAX_P = 8;

export function assertKdfParams(params) {
  if (!params || typeof params !== 'object') throw new Error('Missing KDF parameters.');

  const { id, log2m, t, p } = params;

  if (id !== KDF_ARGON2ID) throw new Error(`Unsupported KDF id ${id}. This blob was written by a newer version.`);

  if (!Number.isInteger(log2m) || log2m < MIN_LOG2M || log2m > MAX_LOG2M) throw new Error(`Refusing KDF memory parameter log2m=${log2m}; expected ${MIN_LOG2M}..${MAX_LOG2M}.`);

  if (!Number.isInteger(t) || t < 1 || t > MAX_T) throw new Error(`Refusing KDF iteration parameter t=${t}; expected 1..${MAX_T}.`);

  if (!Number.isInteger(p) || p < 1 || p > MAX_P) throw new Error(`Refusing KDF parallelism parameter p=${p}; expected 1..${MAX_P}.`);

  return params;
}

/**
 * @param {string | Buffer} passphrase
 * @param {Buffer} salt 16 bytes, stored in the clear alongside the blob
 * @param {{ id: number, log2m: number, t: number, p: number }} params
 * @returns {Promise<Buffer>} 32 bytes
 */
export async function deriveKey(passphrase, salt, params = DEFAULT_KDF) {
  assertKdfParams(params);

  if (!Buffer.isBuffer(salt) || salt.length !== SALT_LEN) throw new Error(`Salt must be ${SALT_LEN} bytes.`);

  const password = typeof passphrase === 'string' ? passphrase.normalize('NFKC') : passphrase;

  if (!password || password.length === 0) throw new Error('Refusing to derive a key from an empty passphrase.');

  const out = await argon2id({
    password,
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: 2 ** params.log2m, // in KiB
    hashLength: KEY_LEN,
    outputType: 'binary'
  });

  return Buffer.from(out);
}
