import { createInterface } from 'node:readline/promises';
import { clearScreenDown, cursorTo, emitKeypressEvents, moveCursor } from 'node:readline';

import { S, bold, cyan, dim } from './format.js';

const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(8);
const DELETE = String.fromCharCode(127);

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export function isInteractive(input = process.stdin, output = process.stdout) {
  return Boolean(input.isTTY && output.isTTY) && process.env.CI !== 'true';
}

// Interactivity checker for CIs
export function requireInteractive(what, input = process.stdin, output = process.stdout) {
  if (!isInteractive(input, output)) throw new Error(`${what} needs a terminal.\n\n  In CI, set WILSOON_ENV_KEY (and whatever credentials your provider needs) instead.\n`);
}

/*
  Raw mode belongs to the terminal, not to this process: exiting without clearing
  it leaves the user's shell with no echo, typing into the dark and blaming us.
  Every prompt restores it on the way out, and this is the net for the ways out
  nobody planned - an exception mid-render, a throw from a validation step.
*/
let guarded = false;

function guardTerminal(input, output) {
  if (guarded) return;

  guarded = true;

  process.on('exit', () => {
    try {
      if (input.isTTY) input.setRawMode(false);
    } catch {}

    try {
      output.write(SHOW_CURSOR);
    } catch {}
  });
}

// Reads without showing
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

/* Read one visible line - for things that are not secret: an email, a code */
export async function ask(question, { input = process.stdin, output = process.stdout } = {}) {
  requireInteractive('This', input, output);

  const rl = createInterface({ input, output });

  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question, { fallback = false, input = process.stdin, output = process.stdout } = {}) {
  if (!isInteractive(input, output)) return fallback;

  const rl = createInterface({ input, output });

  try {
    const answer = (await rl.question(`${question} ${dim('[y/N]')} `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

const labelOf = (choice) => (typeof choice === 'string' ? choice : choice.label);
const valueOf = (choice) => (typeof choice === 'string' ? choice : choice.value);
const hintOf = (choice) => (typeof choice === 'string' ? '' : (choice.hint ?? ''));

/**
 * Pick one of a list. Arrow keys move the highlight, Enter to select.
 * A digit picks an option directly: a shortcut once the menu is known.
 *
 * @param {string} question
 * @param {Array<string|{value: any, label: string, hint?: string}>} choices
 * @returns {Promise<any>} the chosen value
 */
export function choose(question, choices, { initial = 0, input = process.stdin, output = process.stdout } = {}) {
  requireInteractive('Choosing an option', input, output);

  if (!Array.isArray(choices) || choices.length === 0) throw new Error('choose() needs at least one choice.');

  const width = String(choices.length).length;
  const hinted = choices.some((choice) => hintOf(choice));
  const labels = Math.max(...choices.map((choice) => labelOf(choice).length));

  let at = Math.min(Math.max(initial, 0), choices.length - 1);
  let drawn = 0;

  return new Promise((resolve, reject) => {
    const render = () => {
      if (drawn) {
        cursorTo(output, 0);
        moveCursor(output, 0, -drawn);
        clearScreenDown(output);
      }

      const lines = [`  ${bold(question)}`, ''];

      choices.forEach((choice, i) => {
        const hint = hintOf(choice);
        const label = hinted && hint ? labelOf(choice).padEnd(labels) : labelOf(choice);
        const body = `${String(i + 1).padStart(width)}  ${label}`;
        const tail = hint ? `  ${dim(hint)}` : '';

        lines.push(i === at ? `  ${cyan(S.pointer)} ${cyan(body)}${tail}` : `    ${body}${tail}`);
      });

      lines.push('');
      output.write(lines.join('\n') + '\n');
      drawn = lines.length;
    };

    const cleanup = () => {
      input.removeListener('keypress', onKeypress);

      try {
        if (input.isTTY) input.setRawMode(false);
      } catch {}

      try {
        input.pause();
      } catch {}

      try {
        output.write(SHOW_CURSOR);
      } catch {}
    };

    const settle = (act) => {
      cleanup();
      act();
    };

    function onKeypress(str, key = {}) {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') return settle(() => reject(new Error('Cancelled.')));

      if (key.name === 'up') {
        at = (at - 1 + choices.length) % choices.length;
        return render();
      }

      if (key.name === 'down') {
        at = (at + 1) % choices.length;
        return render();
      }

      if (key.name === 'return' || key.name === 'enter') return settle(() => resolve(valueOf(choices[at])));

      const digit = Number.parseInt(str ?? '', 10);

      if (Number.isInteger(digit) && digit >= 1 && digit <= choices.length) {
        at = digit - 1;
        render();
        return settle(() => resolve(valueOf(choices[at])));
      }
    }

    try {
      guardTerminal(input, output);
      emitKeypressEvents(input);

      output.write(HIDE_CURSOR);
      input.setRawMode(true);
      input.resume();
      input.setEncoding('utf8');
      input.on('keypress', onKeypress);

      render();
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}
