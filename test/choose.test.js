import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { choose } from '../cli/lib/prompt.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeTerminal({ writeThrows = false } = {}) {
  const input = new PassThrough();
  const rawCalls = [];

  input.isTTY = true;
  input.setRawMode = (value) => {
    rawCalls.push(value);
    return input;
  };

  const written = [];
  const output = new PassThrough();

  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  output.write = (chunk) => {
    if (writeThrows) throw new Error('EPIPE');

    written.push(String(chunk));
    return true;
  };

  return { input, output, rawCalls, written, rendered: () => written.join('') };
}

// A GitHub runner sets CI=true, which is exactly what isInteractive() refuses.
afterEach(() => vi.unstubAllEnvs());
const interactive = () => vi.stubEnv('CI', '');

describe('choose', () => {
  it('takes the highlighted choice on Enter', async () => {
    interactive();
    const t = fakeTerminal();
    const picked = choose('Pick one', ['alpha', 'beta'], t);

    await tick();
    t.input.write('\r');

    await expect(picked).resolves.toBe('alpha');
  });

  it('moves the highlight with the arrow keys', async () => {
    interactive();
    const t = fakeTerminal();
    const picked = choose('Pick one', ['alpha', 'beta', 'gamma'], t);

    await tick();
    t.input.write('\x1b[B');
    await tick();
    t.input.write('\x1b[B');
    await tick();
    t.input.write('\r');

    await expect(picked).resolves.toBe('gamma');
  });

  it('wraps around rather than stopping at the ends', async () => {
    interactive();
    const t = fakeTerminal();
    const picked = choose('Pick one', ['alpha', 'beta', 'gamma'], t);

    await tick();
    t.input.write('\x1b[A');
    await tick();
    t.input.write('\r');

    await expect(picked).resolves.toBe('gamma');
  });

  it('takes a digit outright, which is the path a screen reader can use', async () => {
    interactive();
    const t = fakeTerminal();
    const picked = choose('Pick one', ['alpha', 'beta', 'gamma'], t);

    await tick();
    t.input.write('2');

    await expect(picked).resolves.toBe('beta');
  });

  it('always draws the numbers, so the digit shortcut is discoverable', async () => {
    interactive();
    const t = fakeTerminal();
    const picked = choose('Pick one', ['alpha', 'beta'], t);

    await tick();
    expect(t.rendered()).toMatch(/1\s+alpha/);
    expect(t.rendered()).toMatch(/2\s+beta/);

    t.input.write('\r');
    await picked;
  });

  it('returns the value behind a labelled choice', async () => {
    interactive();
    const t = fakeTerminal();
    const picked = choose('Store', [{ value: 'supabase', label: 'Supabase', hint: 'row level security' }], t);

    await tick();
    expect(t.rendered()).toContain('row level security');

    t.input.write('\r');
    await expect(picked).resolves.toBe('supabase');
  });

  it('lines the hints up, and leaves no trailing space on rows without one', async () => {
    interactive();
    const t = fakeTerminal();
    const picked = choose(
      'Pick one',
      [
        { value: 'a', label: 'Short', hint: 'first' },
        { value: 'b', label: 'A much longer label', hint: 'second' },
        { value: 'c', label: 'No hint here' }
      ],
      t
    );

    await tick();

    const rows = t
      .rendered()
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .split('\n');

    expect(rows.find((r) => r.includes('first')).indexOf('first')).toBe(rows.find((r) => r.includes('second')).indexOf('second'));
    expect(rows.find((r) => r.includes('No hint here'))).toBe('    3  No hint here');

    t.input.write('\r');
    await picked;
  });
  it('cancels on ctrl-c instead of returning a choice nobody made', async () => {
    interactive();
    const t = fakeTerminal();
    const picked = choose('Pick one', ['alpha'], t);

    await tick();
    t.input.write('\x03');

    await expect(picked).rejects.toThrow(/Cancelled/);
  });
});

/*
  The one that matters. Raw mode is terminal state, not process state: leaving it
  set means the user's shell stops echoing what they type, long after this
  process is gone.
*/
describe('choose restores the terminal', () => {
  it('after a normal pick', async () => {
    interactive();
    const t = fakeTerminal();
    const picked = choose('Pick one', ['alpha'], t);

    await tick();
    t.input.write('\r');
    await picked;

    expect(t.rawCalls).toEqual([true, false]);
  });

  it('after a cancel', async () => {
    interactive();
    const t = fakeTerminal();
    const picked = choose('Pick one', ['alpha'], t);

    await tick();
    t.input.write('\x03');
    await picked.catch(() => {});

    expect(t.rawCalls).toEqual([true, false]);
  });

  it('after the render itself throws', async () => {
    interactive();
    const t = fakeTerminal({ writeThrows: true });

    await expect(choose('Pick one', ['alpha'], t)).rejects.toThrow();
    expect(t.rawCalls.at(-1), 'raw mode must be off however we left').toBe(false);
  });

  it('leaves the cursor visible', async () => {
    interactive();
    const t = fakeTerminal();
    const picked = choose('Pick one', ['alpha'], t);

    await tick();
    t.input.write('\r');
    await picked;

    expect(t.rendered().endsWith('\x1b[?25h')).toBe(true);
  });
});

describe('choose without a terminal', () => {
  it('refuses rather than blocking on a read that will never come', () => {
    interactive();
    const t = fakeTerminal();
    t.input.isTTY = false;

    expect(() => choose('Pick one', ['alpha'], t)).toThrow(/needs a terminal/);
  });

  it('refuses an empty list rather than rendering nothing', () => {
    interactive();
    expect(() => choose('Pick one', [], fakeTerminal())).toThrow(/at least one choice/);
  });
});
