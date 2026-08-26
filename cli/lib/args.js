const BOOLEAN = new Set(['force', 'yes', 'help', 'version', 'no-browser', 'quiet']);

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');

      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }

      const next = argv[i + 1];
      if (BOOLEAN.has(body) || next === undefined || next.startsWith('-')) flags[body] = true;
      else flags[body] = argv[++i];

      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) flags[ch] = true;
      continue;
    }

    positional.push(arg);
  }

  return { flags, positional, rest };
}
