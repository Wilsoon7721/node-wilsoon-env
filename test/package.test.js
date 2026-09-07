import { describe, expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/*
  The package manifest makes promises that nothing else checks. `main` and
  `exports` pointed at an index.js that did not exist, and three `exports`
  subpaths named adapter files that had never been written - none of which the
  CLI touches, so the whole suite stayed green while `import '@wilsoon/env'`
  threw for anyone who tried it.

  These tests resolve what the manifest claims, so a promise and a file cannot
  drift apart again.
*/

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const exists = async (rel) => {
  await access(path.join(root, rel));
  return true;
};

describe('package manifest', () => {
  it('resolves every exports target, and each one imports', async () => {
    const targets = Object.entries(pkg.exports).map(([subpath, target]) => [subpath, typeof target === 'string' ? target : (target.default ?? target.import)]);

    expect(targets.length).toBeGreaterThan(0);

    for (const [subpath, target] of targets) {
      await expect(exists(target), `exports["${subpath}"] -> ${target}`).resolves.toBe(true);

      if (target.endsWith('.js')) await expect(import(path.join(root, target)), `importing ${target}`).resolves.toBeTruthy();
    }
  });

  it('resolves main and bin', async () => {
    await expect(exists(pkg.main)).resolves.toBe(true);

    for (const target of Object.values(pkg.bin)) await expect(exists(target), `bin -> ${target}`).resolves.toBe(true);
  });

  it('ships every path listed in files', async () => {
    for (const entry of pkg.files) await expect(exists(entry), `files -> ${entry}`).resolves.toBe(true);
  });

  it('has the licence file its metadata claims', async () => {
    expect(pkg.license).toBe('MIT');

    const licence = await readFile(path.join(root, 'LICENSE'), 'utf8');
    expect(licence).toMatch(/MIT License/);
    expect(licence).toMatch(/Wilson Oon/);
  });

  it('declares every optional peer as optional, so npx stays small', () => {
    for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
      expect(pkg.peerDependenciesMeta?.[peer]?.optional, `${peer} must be optional`).toBe(true);
    }
  });

  it('keeps the runtime dependency list to what the crypto needs', () => expect(Object.keys(pkg.dependencies)).toEqual(['hash-wasm']));

  it('points every url at one repository, which npm provenance requires', () => {
    // Provenance attests "built from this repo", so a stale repository url is
    // not cosmetic: npm refuses the publish. These three drifted apart once.
    const slug = pkg.repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)?.[1];

    expect(slug, `no repo slug in ${pkg.repository.url}`).toBeTruthy();
    expect(pkg.bugs.url).toContain(slug);
    expect(pkg.homepage).toContain(slug);
  });

  it('exposes a single bin, which is what makes npx @wilsoon/env work', () => {
    // npx resolves a package to its only bin. A second entry makes the bare
    // `npx @wilsoon/env` ambiguous, and every help string in the CLI uses it.
    expect(Object.keys(pkg.bin)).toHaveLength(1);
    expect(Object.keys(pkg.bin)[0]).toBe('wilsoon-env');
  });
});

describe('public API', () => {
  it('exports the surface the README will document', async () => {
    const api = await import(path.join(root, 'index.js'));

    for (const name of ['seal', 'open', 'generateIdentity', 'sealIdentity', 'openIdentity', 'encodePublic', 'decodePublic', 'encodePrivate', 'decodePrivate', 'resolveProvider', 'loadConfig', 'openSession', 'parse', 'ConflictError']) {
      expect(api[name], `index.js should export ${name}`).toBeDefined();
    }
  });

  it('does not leak the CLI into the library entry point', async () => {
    const api = await import(path.join(root, 'index.js'));

    for (const name of ['push', 'pull', 'setup', 'status', 'run', 'keys']) {
      expect(api[name], `${name} is a command, not library API`).toBeUndefined();
    }
  });
});
