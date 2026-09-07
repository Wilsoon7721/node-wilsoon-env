import { readdir } from 'node:fs/promises';

export const DEFAULT_INCLUDE = ['.env', '.env.*'];
export const DEFAULT_EXCLUDE = ['.env.example', '.env.*.example', '.env.sample', '.env.*.sample', '.env.template', '.env.*.template', '*.enc', '*.bak', '*~', '*.swp'];

function toRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*');
  return new RegExp(`^${escaped}$`);
}

export function matchesAny(name, patterns) {
  return patterns.some((p) => toRegExp(p).test(name));
}

// Filenames in `dir` that this project should sync, sorted for stable output
export async function discover(dir, { include = DEFAULT_INCLUDE, exclude = DEFAULT_EXCLUDE } = {}) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => matchesAny(name, include) && !matchesAny(name, exclude))
    .sort();
}

export function isSyncable(name, { include = DEFAULT_INCLUDE, exclude = DEFAULT_EXCLUDE } = {}) {
  return matchesAny(name, include) && !matchesAny(name, exclude);
}

const LINE = /(?:^|\n)[ \t]*(?:export[ \t]+)?([\w.$-]+)[ \t]*=[ \t]*(?:'([^']*)'|"((?:\\.|[^"\\])*)"|([^\n]*))/g;

// Parses a .env file into an ordered Map
export function parse(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const out = new Map();

  for (const m of src.matchAll(LINE)) {
    const [, key, single, double, bare] = m;

    let value;
    if (single !== undefined) value = single;
    else if (double !== undefined) value = double.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\(.)/g, '$1');
    else value = (bare ?? '').replace(/[ \t]+#.*$/, '').trim();

    out.set(key, value);
  }

  return out;
}

const NEEDS_QUOTES = /[\s#'"\\]|^$/;

export function serialise(entries) {
  const map = entries instanceof Map ? entries : new Map(Object.entries(entries ?? {}));
  const lines = [];

  for (const [key, raw] of map) {
    const value = String(raw ?? '');
    lines.push(NEEDS_QUOTES.test(value) ? `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : `${key}=${value}`);
  }

  return lines.length ? lines.join('\n') + '\n' : '';
}

// Reports what changed between two .env files
export function diff(before, after) {
  const a = before instanceof Map ? before : parse(before);
  const b = after instanceof Map ? after : parse(after);

  const added = [],
    removed = [],
    changed = [];

  for (const key of b.keys()) if (!a.has(key)) added.push(key);
  for (const key of a.keys()) if (!b.has(key)) removed.push(key);
  for (const [key, value] of a) if (b.has(key) && b.get(key) !== value) changed.push(key);

  return { added, removed, changed, unchanged: [...a.keys()].filter((k) => b.has(k) && b.get(k) === a.get(k)) };
}
