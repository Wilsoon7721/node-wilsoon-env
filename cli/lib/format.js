const enabled = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb' && Boolean(process.stdout.isTTY);

/*
  Colour and glyphs are separate questions, and answering them together is how a
  tick becomes a "?". The classic Windows console renders ANSI colour perfectly
  well while its code page has nothing to draw a "✓" with, so the symbols need
  their own test: on Windows, assume a modern terminal only when one says so.
*/
export const unicode =
  process.platform !== 'win32' ||
  Boolean(process.env.WT_SESSION) ||
  Boolean(process.env.TERMINUS_SUBLIME) ||
  process.env.ConEmuTask === '{cmd::Cmder}' ||
  process.env.TERM_PROGRAM === 'vscode' ||
  ['xterm-256color', 'xterm', 'alacritty', 'cygwin'].includes(process.env.TERM);

const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text));

export const bold = wrap(1);
export const dim = wrap(2);
export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const cyan = wrap(36);

export const S = unicode ? { ok: '✓', bad: '✗', info: '·', arrow: '→', pointer: '❯', plus: '+', minus: '-', tilde: '~' } : { ok: 'ok', bad: 'x', info: '-', arrow: '->', pointer: '>', plus: '+', minus: '-', tilde: '~' };

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
