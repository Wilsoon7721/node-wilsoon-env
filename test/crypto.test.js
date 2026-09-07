import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import { DEFAULT_KDF, assertKdfParams, deriveKey } from '../core/crypto/kdf.js';
import { IDENTITY_BLOB_LEN, PAYLOAD_HEADER_LEN, SLOT_LEN } from '../core/crypto/header.js';
import { decodePublic, encodePublic, generateIdentity, keyIdOf, openIdentity, publicOf, sealIdentity } from '../core/crypto/identity.js';
import { open, seal } from '../core/crypto/envelope.js';

/*
  Argon2 at the real parameters is deliberately slow, and these tests exercise it
  dozens of times. Everything being verified here is structural - that the right
  bytes are bound into the right places - and none of it depends on the work
  factor, so the identity tests run at the floor. One test at the shipped
  parameters guards the default itself.
*/
const FAST_KDF = Object.freeze({ id: 1, log2m: 10, t: 1, p: 1 });

const CONTEXT = { project: 'demo', name: '.env.production', version: 7 };
const ENV_FILE = 'DATABASE_URL=postgres://localhost/app\nSTRIPE_SECRET_KEY=sk_live_abc123\n';

describe('kdf', () => {
  it('derives 32 bytes, deterministically for the same inputs', async () => {
    const salt = randomBytes(16);
    const a = await deriveKey('correct horse battery staple', salt, FAST_KDF);
    const b = await deriveKey('correct horse battery staple', salt, FAST_KDF);

    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(true);
  });

  it('separates passphrases and salts', async () => {
    const salt = randomBytes(16);
    const base = await deriveKey('one', salt, FAST_KDF);

    expect((await deriveKey('two', salt, FAST_KDF)).equals(base)).toBe(false);
    expect((await deriveKey('one', randomBytes(16), FAST_KDF)).equals(base)).toBe(false);
  });

  it('refuses an empty passphrase', async () => await expect(deriveKey('', randomBytes(16), FAST_KDF)).rejects.toThrow(/empty passphrase/i));

  it('refuses a hostile memory parameter rather than allocating it', () => {
    // 2^40 KiB is a terabyte. An unvalidated exponent off a stolen blob is a
    // denial of service against whoever opens it.
    expect(() => assertKdfParams({ ...DEFAULT_KDF, log2m: 40 })).toThrow(/log2m/);
    expect(() => assertKdfParams({ ...DEFAULT_KDF, log2m: 2 })).toThrow(/log2m/);
    expect(() => assertKdfParams({ ...DEFAULT_KDF, id: 99 })).toThrow(/Unsupported KDF/);
  });

  it('ships parameters at or above the intended floor', () => {
    expect(DEFAULT_KDF.log2m).toBeGreaterThanOrEqual(16); // 64 MiB
    expect(DEFAULT_KDF.t).toBeGreaterThanOrEqual(3);
  });
});

describe('public key encoding', () => {
  it('round-trips', () => {
    const { publicRaw } = generateIdentity();
    const text = encodePublic(publicRaw);

    expect(text.startsWith('wenv1')).toBe(true);
    expect(decodePublic(text).equals(publicRaw)).toBe(true);
  });

  it('tolerates whitespace and case from a copy-paste', () => {
    const { publicRaw } = generateIdentity();
    const text = encodePublic(publicRaw);

    expect(decodePublic(`  ${text.toUpperCase()}\n`).equals(publicRaw)).toBe(true);
  });

  it('catches a truncated key instead of decoding the wrong bytes', () => {
    const text = encodePublic(generateIdentity().publicRaw);

    expect(() => decodePublic(text.slice(0, -4))).toThrow(/length|checksum/i);
  });

  it('catches a single altered character', () => {
    const text = encodePublic(generateIdentity().publicRaw);
    const at = 10;
    const swapped = text[at] === 'a' ? 'b' : 'a';

    expect(() => decodePublic(text.slice(0, at) + swapped + text.slice(at + 1))).toThrow(/checksum/i);
  });

  it('rejects a key without the prefix', () => expect(() => decodePublic('abcdef')).toThrow(/wenv1/));
});

describe('identity blob', () => {
  it('round-trips through the passphrase, at the documented size', async () => {
    const { privateRaw, publicRaw } = generateIdentity();
    const blob = await sealIdentity(privateRaw, 'a good passphrase', FAST_KDF);

    expect(blob).toHaveLength(IDENTITY_BLOB_LEN);

    const opened = await openIdentity(blob, 'a good passphrase');

    expect(opened.equals(privateRaw)).toBe(true);
    expect(publicOf(opened).equals(publicRaw)).toBe(true);
  });

  it('yields nothing at all on a wrong passphrase', async () => {
    const blob = await sealIdentity(generateIdentity().privateRaw, 'right', FAST_KDF);

    await expect(openIdentity(blob, 'wrong')).rejects.toThrow(/wrong passphrase|altered/i);
  });

  it('detects a flipped bit anywhere in the blob', async () => {
    const blob = await sealIdentity(generateIdentity().privateRaw, 'pass', FAST_KDF);

    for (const at of [6, 7, 12, 30, 45, 80, 87]) {
      const tampered = Buffer.from(blob);
      tampered[at] ^= 0x01;

      await expect(openIdentity(tampered, 'pass')).rejects.toThrow();
    }
  });

  it('normalises unicode so the same phrase works across platforms', async () => {
    const composed = 'passé'; // e + combining acute
    const precomposed = 'passé'; // single character

    const blob = await sealIdentity(generateIdentity().privateRaw, composed, FAST_KDF);

    await expect(openIdentity(blob, precomposed)).resolves.toBeInstanceOf(Buffer);
  });
});

describe('envelope', () => {
  it('round-trips for a single recipient', () => {
    const me = generateIdentity();
    const blob = seal({ plaintext: ENV_FILE, recipients: [me.publicRaw], ...CONTEXT });
    const { plaintext, version } = open({ blob, privateRaw: me.privateRaw, project: CONTEXT.project, name: CONTEXT.name });

    expect(plaintext.toString('utf8')).toBe(ENV_FILE);
    expect(version).toBe(7n);
  });

  it('opens for every recipient, and for nobody else', () => {
    const team = [generateIdentity(), generateIdentity(), generateIdentity()];
    const outsider = generateIdentity();

    const blob = seal({ plaintext: ENV_FILE, recipients: team.map((m) => m.publicRaw), ...CONTEXT });

    for (const member of team) {
      expect(open({ blob, privateRaw: member.privateRaw, project: CONTEXT.project, name: CONTEXT.name }).plaintext.toString()).toBe(ENV_FILE);
    }

    expect(() => open({ blob, privateRaw: outsider.privateRaw, project: CONTEXT.project, name: CONTEXT.name })).toThrow(/no usable recipient slot/);
  });

  it('grows by exactly one slot per recipient', () => {
    const a = generateIdentity(),
      b = generateIdentity();

    const one = seal({ plaintext: ENV_FILE, recipients: [a.publicRaw], ...CONTEXT });
    const two = seal({ plaintext: ENV_FILE, recipients: [a.publicRaw, b.publicRaw], ...CONTEXT });

    expect(two.length - one.length).toBe(SLOT_LEN);
    expect(one.length).toBe(PAYLOAD_HEADER_LEN + SLOT_LEN + 12 + 16 + Buffer.byteLength(ENV_FILE));
  });

  it('mints a fresh DEK per push, so no two seals share a keystream', () => {
    const me = generateIdentity();
    const args = { plaintext: ENV_FILE, recipients: [me.publicRaw], ...CONTEXT };

    const first = seal(args);
    const second = seal(args);

    // Same inputs, same length, entirely different bytes past the header.
    expect(first.length).toBe(second.length);
    expect(first.subarray(PAYLOAD_HEADER_LEN).equals(second.subarray(PAYLOAD_HEADER_LEN))).toBe(false);
  });

  it('refuses a blob relabelled as another file', () => {
    const me = generateIdentity();
    const blob = seal({ plaintext: ENV_FILE, recipients: [me.publicRaw], ...CONTEXT });

    expect(() => open({ blob, privateRaw: me.privateRaw, project: CONTEXT.project, name: '.env.local' })).toThrow();
  });

  it('refuses a blob relabelled into another project', () => {
    const me = generateIdentity();
    const blob = seal({ plaintext: ENV_FILE, recipients: [me.publicRaw], ...CONTEXT });

    expect(() => open({ blob, privateRaw: me.privateRaw, project: 'other', name: CONTEXT.name })).toThrow();
  });

  it('binds the version, so a rolled-back blob cannot pose as current', () => {
    const me = generateIdentity();
    const blob = seal({ plaintext: ENV_FILE, recipients: [me.publicRaw], ...CONTEXT });

    // Rewrite the version in the header, as an attacker serving an old blob would.
    const forged = Buffer.from(blob);
    forged.writeBigUInt64LE(9n, 8);

    expect(() => open({ blob: forged, privateRaw: me.privateRaw, project: CONTEXT.project, name: CONTEXT.name })).toThrow();
  });

  it('detects tampering in the body, the slots and the header alike', () => {
    const me = generateIdentity();
    const blob = seal({ plaintext: ENV_FILE, recipients: [me.publicRaw], ...CONTEXT });

    for (const at of [PAYLOAD_HEADER_LEN + 20, PAYLOAD_HEADER_LEN + SLOT_LEN + 4, blob.length - 5]) {
      const tampered = Buffer.from(blob);
      tampered[at] ^= 0x01;

      expect(() => open({ blob: tampered, privateRaw: me.privateRaw, project: CONTEXT.project, name: CONTEXT.name })).toThrow();
    }
  });

  it('rejects foreign or corrupt blobs before reading fields off them', () => {
    const me = generateIdentity();

    expect(() => open({ blob: Buffer.from('not a blob at all'), privateRaw: me.privateRaw, ...CONTEXT })).toThrow(/bad magic/);
    expect(() => open({ blob: Buffer.alloc(2), privateRaw: me.privateRaw, ...CONTEXT })).toThrow(/too short/);

    const future = seal({ plaintext: ENV_FILE, recipients: [me.publicRaw], ...CONTEXT });
    future[4] = 99;

    expect(() => open({ blob: future, privateRaw: me.privateRaw, ...CONTEXT })).toThrow(/not supported by this version/);
  });

  it('handles an empty file and a large one', () => {
    const me = generateIdentity();
    const big = randomBytes(512 * 1024).toString('base64');

    for (const content of ['', big]) {
      const blob = seal({ plaintext: content, recipients: [me.publicRaw], ...CONTEXT });
      expect(open({ blob, privateRaw: me.privateRaw, project: CONTEXT.project, name: CONTEXT.name }).plaintext.toString()).toBe(content);
    }
  });

  it('needs at least one recipient', () => expect(() => seal({ plaintext: ENV_FILE, recipients: [], ...CONTEXT })).toThrow(/at least one recipient/i));

  it('keeps keyids stable and short', () => {
    const { publicRaw } = generateIdentity();

    expect(keyIdOf(publicRaw)).toHaveLength(8);
    expect(keyIdOf(publicRaw).equals(keyIdOf(publicRaw))).toBe(true);
  });
});
