import { createInterface } from 'node:readline/promises';

import { dim } from './format.js';

const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(8);
const DELETE = String.fromCharCode(127);

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.CI !== 'true';
}

// Interactivity checker for CIs
export function requireInteractive(what) {
  if (!isInteractive()) throw new Error(`${what} needs a terminal.\n\n  In CI, set WILSOON_ENV_KEY (and WILSOON_ENV_TOKEN where the provider needs it) instead.\n`);
}

// Reads without showing. Raw mode is always restored, including on Ctrl+C
export function password(question) {
  requireInteractive('Entering a passphrase');

  return new Promise((resolve, reject) => {
    const input = process.stdin;

    process.stdout.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let buffer = '';

    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          return resolve(buffer);
        }

        if (ch === CTRL_C) {
          cleanup();
          process.stdout.write('\n');
          return reject(new Error('Cancelled.'));
        }

        if (ch === DELETE || ch === BACKSPACE) {
          if (buffer.length) {
            buffer = buffer.slice(0, -1);
            process.stdout.write('\b \b');
          }

          continue;
        }

        if (ch < ' ') continue;

        buffer += ch;
        process.stdout.write('*');
      }
    };

    input.on('data', onData);
  });
}

export async function newPassphrase({ min = 8 } = {}) {
  for (;;) {
    const first = await password('  Choose a passphrase: ');

    if (first.length < min) {
      console.log(dim(`  Too short - use at least ${min} characters. This is the only thing protecting your secrets offline.`));
      continue;
    }

    const second = await password('  Type it again:       ');

    if (first !== second) {
      console.log(dim('  Those did not match.'));
      continue;
    }

    return first;
  }
}

export async function confirm(question, { fallback = false } = {}) {
  if (!isInteractive()) return fallback;

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = (await rl.question(`${question} ${dim('[y/N]')} `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
