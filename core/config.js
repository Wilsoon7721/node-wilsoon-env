import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from './dotenv.js';

export const CONFIG_FILENAMES = ['wilsoon-env.config.json', 'env.config.json'];
export const PACKAGE_KEY = 'wilsoon-env';

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;

    if (err instanceof SyntaxError) throw new Error(`${file} is not valid JSON: ${err.message}`);

    throw err;
  }
}

// Walks up from `from`, checking package.json first at each level
export async function findConfig(from = process.cwd()) {
  let dir = path.resolve(from);

  for (;;) {
    const pkg = await readJson(path.join(dir, 'package.json'));
    if (pkg && pkg[PACKAGE_KEY]) return { dir, file: path.join(dir, 'package.json'), source: 'package.json' };

    for (const name of CONFIG_FILENAMES) {
      const file = path.join(dir, name);
      if (await readJson(file)) return { dir, file, source: name };
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null;

    dir = parent;
  }
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function interpolate(value, file) {
  if (typeof value === 'string')
    return value.replace(VAR, (_, name) => {
      const found = process.env[name];
      if (found === undefined) throw new Error(`${file} refers to \${${name}}, which is not set in the environment.`);

      return found;
    });

  if (Array.isArray(value)) return value.map((v) => interpolate(v, file));

  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, file)]));

  return value;
}

function validate(raw, file) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${file} must contain a configuration object.`);

  const project = raw.project;
  if (typeof project !== 'string' || !project.trim()) throw new Error(`${file} is missing "project".`);

  if (/[/\\]/.test(project)) throw new Error(`${file}: "project" must not contain path separators.`);

  const provider = raw.provider;
  if (typeof provider !== 'string' || !provider.trim()) throw new Error(`${file} is missing "provider".`);

  const recipients = raw.recipients ?? [];
  if (!Array.isArray(recipients)) throw new Error(`${file}: "recipients" must be an array.`);

  for (const [i, r] of recipients.entries()) {
    if (!r || typeof r !== 'object') throw new Error(`${file}: recipients[${i}] must be an object.`);

    if (typeof r.pubkey !== 'string' || !r.pubkey) throw new Error(`${file}: recipients[${i}] is missing "pubkey".`);
  }

  return {
    project: project.trim(),
    provider: provider.trim(),
    recipients,
    include: raw.include ?? DEFAULT_INCLUDE,
    exclude: raw.exclude ?? DEFAULT_EXCLUDE,
    options: raw.options ?? {},
    kdf: raw.kdf
  };
}

export async function loadConfig(from = process.cwd()) {
  const found = await findConfig(from);
  if (!found) return null;

  const contents = await readJson(found.file);
  const raw = found.source === 'package.json' ? contents[PACKAGE_KEY] : contents;

  return { ...found, config: validate(interpolate(raw, found.file), found.file) };
}
