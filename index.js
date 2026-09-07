/**
 * Programmatic entry point.
 *
 * Deliberately narrower than the module tree: everything re-exported here is
 * something an outside caller has a reason to reach for, and everything named
 * here is something that cannot change without a major version. Internals stay
 * internal - reach into core/ at your own risk.
 */

export { seal, open, recipientsOf } from './core/crypto/envelope.js';

export { generateIdentity, sealIdentity, openIdentity, publicOf, keyIdOf, encodePublic, decodePublic, encodePrivate, decodePrivate } from './core/crypto/identity.js';

export { DEFAULT_KDF, deriveKey } from './core/crypto/kdf.js';

export { FORMAT, KIND_IDENTITY as BLOB_KIND_IDENTITY, KIND_PAYLOAD as BLOB_KIND_PAYLOAD } from './core/crypto/header.js';

export { KIND_ENV, KIND_IDENTITY, ConflictError, assertRef, resolveProvider } from './core/provider.js';

export { findConfig, loadConfig, CONFIG_FILENAMES, PACKAGE_KEY } from './core/config.js';

export { discover, isSyncable, parse, serialise, diff, DEFAULT_INCLUDE, DEFAULT_EXCLUDE } from './core/dotenv.js';

export { openSession, unlockIdentity, findIdentity, recipientKeys, recipientsFor } from './core/session.js';
