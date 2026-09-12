import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadConfig, SCHEMA_RELATIVE, SCHEMA_URL, schemaRef } from '../core/config.js';
import { encodePublic, generateIdentity, keyIdOf } from '../core/crypto/identity.js';
import { DEFAULT_KDF } from '../core/crypto/kdf.js';
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from '../core/dotenv.js';

/*
  A schema that drifts from the validator is worse than none: it tells editors a
  config is fine when the CLI will reject it, or underlines a field that works.
  These tests compare the two against each other rather than trusting either.
*/
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(await readFile(path.join(root, 'schema', 'env.config.v1.json'), 'utf8'));

describe('config schema', () => {
  it('requires exactly what the validator requires', async () => {
    expect(schema.required).toEqual(['project', 'provider']);

    const dir = await mkdtemp(path.join(tmpdir(), 'wenv-sch-'));
    try {
      const file = path.join(dir, 'env.config.json');

      await writeFile(file, JSON.stringify({ provider: 'local' }));
      await expect(loadConfig(dir)).rejects.toThrow(/missing "project"/);

      await writeFile(file, JSON.stringify({ project: 'demo' }));
      await expect(loadConfig(dir)).rejects.toThrow(/missing "provider"/);

      // Nothing else is required.
      await writeFile(file, JSON.stringify({ project: 'demo', provider: 'local' }));
      await expect(loadConfig(dir)).resolves.toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('describes every field the validator returns', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wenv-sch-'));
    try {
      await writeFile(path.join(dir, 'env.config.json'), JSON.stringify({ project: 'demo', provider: 'local' }));
      const { config } = await loadConfig(dir);

      for (const key of Object.keys(config))
        expect(schema.properties, `schema is missing "${key}"`).toHaveProperty(key);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a project name the validator would reject', () => {
    const pattern = new RegExp(schema.properties.project.pattern);

    expect(pattern.test('my-app')).toBe(true);
    expect(pattern.test('a/b')).toBe(false);
    expect(pattern.test('a\\b')).toBe(false);
  });

  it('accepts a real public key and key id', () => {
    const { publicRaw } = generateIdentity();
    const recipient = schema.properties.recipients.items.properties;

    expect(new RegExp(recipient.pubkey.pattern).test(encodePublic(publicRaw))).toBe(true);
    expect(new RegExp(recipient.keyid.pattern).test(keyIdOf(publicRaw).toString('hex'))).toBe(true);
  });

  it('bounds the KDF exactly as the KDF module does', () => {
    const kdf = schema.properties.kdf.properties;

    // Mirrors assertKdfParams: the ceiling is what stops a hostile blob asking
    // for a terabyte of memory.
    expect(kdf.log2m.minimum).toBe(10);
    expect(kdf.log2m.maximum).toBe(21);
    expect(kdf.t.maximum).toBe(16);
    expect(kdf.p.maximum).toBe(8);

    expect(DEFAULT_KDF.log2m).toBeGreaterThanOrEqual(kdf.log2m.minimum);
    expect(DEFAULT_KDF.log2m).toBeLessThanOrEqual(kdf.log2m.maximum);
    expect(kdf.id.const).toBe(DEFAULT_KDF.id);
  });

  it('documents the defaults the code actually uses', () => {
    expect(schema.properties.include.default).toEqual(DEFAULT_INCLUDE);
    expect(schema.properties.exclude.default).toEqual(DEFAULT_EXCLUDE);
  });

  it('names every built-in provider option the s3 adapter reads', () => {
    const options = schema.properties.options.properties;

    for (const key of ['path', 'bucket', 'endpoint', 'region', 'prefix', 'profile', 'forcePathStyle'])
      expect(options, `schema should document options.${key}`).toHaveProperty(key);
  });
});

describe('$schema resolution', () => {
  it('points at the installed copy when there is one', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wenv-sch-'));
    try {
      const installed = path.join(dir, 'node_modules', '@wilsoon', 'env', 'schema');
      await mkdir(installed, { recursive: true });
      await writeFile(path.join(installed, 'env.config.v1.json'), '{}');

      expect(await schemaRef(dir)).toBe(SCHEMA_RELATIVE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the URL when the package is not installed locally', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wenv-sch-'));
    try {
      expect(await schemaRef(dir)).toBe(SCHEMA_URL);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('agrees with the $id the schema declares', () => expect(schema.$id).toBe(SCHEMA_URL));
});
