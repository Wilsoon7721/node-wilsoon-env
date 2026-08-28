export const KIND_IDENTITY = 'identity';
export const KIND_ENV = 'env';

export class ConflictError extends Error {
  constructor(expected, actual) {
    super(`This file changed in the store since you last pulled (expected version ${expected}, found ${actual}). Pull first, then push again.`);
    this.name = 'ConflictError';
    this.expected = expected;
    this.actual = actual;
  }
}

const BUILTIN = {
  local: () => import('../providers/local.js'),
  s3: () => import('../providers/s3.js')
};

const OPTIONAL = {
  supabase: { module: '../providers/supabase.js', peer: '@supabase/supabase-js' },
  mongodb: { module: '../providers/mongodb.js', peer: 'mongodb' },
  aws: { module: '../providers/aws-sm.js', peer: '@aws-sdk/client-secrets-manager' }
};

export function assertRef({ project, kind, name }) {
  for (const [label, value] of [
    ['project', project],
    ['name', name]
  ]) {
    if (typeof value !== 'string' || !value) throw new Error(`A blob reference needs a ${label}.`);

    if (value === '.' || value === '..' || /[/\\]/.test(value) || value.includes('\0')) throw new Error(`Refusing "${value}" as a ${label}: it would escape the store.`);
  }

  if (kind !== KIND_IDENTITY && kind !== KIND_ENV) throw new Error(`Unknown blob kind "${kind}".`);
}

export async function resolveProvider(config, dir) {
  const name = config.provider;

  if (BUILTIN[name]) {
    const mod = await BUILTIN[name]();
    return mod.create(config.options ?? {}, { dir });
  }

  if (OPTIONAL[name]) {
    const { module, peer } = OPTIONAL[name];
    let mod;
    try {
      mod = await import(module);
    } catch (err) {
      if (err.code === 'ERR_MODULE_NOT_FOUND' && err.message.includes(`Cannot find package '${peer}'`)) throw new Error(`The "${name}" provider needs its driver installed:\n\n  npm i ${peer}\n`);

      if (err.code === 'ERR_MODULE_NOT_FOUND') throw new Error(`The "${name}" provider is not available in this version yet.`);

      throw err;
    }
    return mod.create(config.options ?? {}, { dir });
  }

  throw new Error(`Unknown provider "${name}". Available: ${[...Object.keys(BUILTIN), ...Object.keys(OPTIONAL)].join(', ')}.`);
}
