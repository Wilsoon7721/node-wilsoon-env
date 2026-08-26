import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { open } from '../core/crypto/envelope.js';
import { openIdentity, publicOf } from '../core/crypto/identity.js';

/*
  Blobs frozen at format v1, generated once and never regenerated.

  Everything the on-disk format depends on is checked here at once: the header
  layout, the AAD construction, the KDF parameter encoding, and the HKDF domain
  separator in envelope.js. None of those can be changed without these failing,
  which is the point - each is invisible in normal use and each would break every
  vault in existence.

  If a change here is genuinely intended, it needs a new format byte and a reader
  for the old one. Regenerating this file to make the suite pass is how you
  silently strand every vault your users already have.
*/
const vectors = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'vectors', 'v1.json'), 'utf8'));

const payload = Buffer.from(vectors.payloadBlob, 'base64');
const identity = Buffer.from(vectors.identityBlob, 'base64');
const privateRaw = Buffer.from(vectors.privateRaw, 'hex');
const secondPrivateRaw = Buffer.from(vectors.secondPrivateRaw, 'hex');

describe('format v1 compatibility', () => {
  it('still opens a payload sealed by an earlier build', () => {
    const { plaintext, version } = open({ blob: payload, privateRaw, project: vectors.context.project, name: vectors.context.name });

    expect(plaintext.toString('utf8')).toBe(vectors.plaintext);
    expect(version).toBe(BigInt(vectors.context.version));
  });

  it('still opens it for the second recipient', () => {
    const { plaintext } = open({ blob: payload, privateRaw: secondPrivateRaw, project: vectors.context.project, name: vectors.context.name });

    expect(plaintext.toString('utf8')).toBe(vectors.plaintext);
  });

  it('still unlocks an identity blob with the recorded parameters', async () => {
    const opened = await openIdentity(identity, vectors.passphrase);

    expect(opened.equals(privateRaw)).toBe(true);
    expect(publicOf(opened).equals(publicOf(privateRaw))).toBe(true);
  });

  it('still refuses the frozen blob under the wrong context', () => {
    expect(() => open({ blob: payload, privateRaw, project: vectors.context.project, name: '.env.local' })).toThrow();
    expect(() => open({ blob: payload, privateRaw, project: 'elsewhere', name: vectors.context.name })).toThrow();
  });

  it('has the header bytes the spec documents', () => {
    expect(payload.subarray(0, 4).toString('ascii')).toBe('WENV');
    expect(payload[4]).toBe(1); // format
    expect(payload[5]).toBe(2); // kind: payload
    expect(payload[6]).toBe(1); // alg: aes-256-gcm
    expect(payload[7]).toBe(2); // recipient slots
    expect(payload.readBigUInt64LE(8)).toBe(42n);

    expect(identity).toHaveLength(88);
    expect(identity[5]).toBe(1); // kind: identity
    expect(identity[6]).toBe(1); // kdf: argon2id
  });
});
