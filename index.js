/**
 * Programmatic entry point.
 *
 * Deliberately narrower than the module tree: everything re-exported here is
 * something an outside caller has a reason to reach for, and everything named
 * here is something that cannot change without a major version. Internals stay
 * internal - reach into core/ at your own risk.
 */

export { open, recipientsOf, seal } from './core/crypto/envelope.js';

export { decodePrivate, decodePublic, encodePrivate, encodePublic, generateIdentity, keyIdOf, openIdentity, publicOf, sealIdentity } from './core/crypto/identity.js';

export { DEFAULT_KDF, deriveKey } from './core/crypto/kdf.js';

export { FORMAT, KIND_IDENTITY as BLOB_KIND_IDENTITY, KIND_PAYLOAD as BLOB_KIND_PAYLOAD } from './core/crypto/header.js';

export { assertRef, ConflictError, KIND_ENV, KIND_IDENTITY, resolveProvider } from './core/provider.js';

export { CONFIG_FILENAMES, findConfig, loadConfig, PACKAGE_KEY } from './core/config.js';

export { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, diff, discover, isSyncable, parse, serialise } from './core/dotenv.js';

export { findIdentity, openSession, recipientKeys, recipientsFor, unlockIdentity } from './core/session.js';
