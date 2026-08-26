const enabled = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb' && Boolean(process.stdout.isTTY);

const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text));

export const bold = wrap(1);
export const dim = wrap(2);
export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const cyan = wrap(36);

export const S = enabled ? { ok: '✓', bad: '✗', info: '·', arrow: '→', plus: '+', minus: '-', tilde: '~' } : { ok: 'ok', bad: 'x', info: '-', arrow: '->', plus: '+', minus: '-', tilde: '~' };

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
