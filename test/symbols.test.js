import { describe, expect, it, vi } from 'vitest';

/*
  Colour and glyphs are separate capabilities. The classic Windows console draws
  ANSI colour fine but has no code page for "✓", so gating the symbols on the
  colour check is how a tick turns into a "?" on somebody's machine.
*/
describe('symbol fallback', () => {
  const load = async (env) => {
    const saved = { ...process.env };

    for (const key of ['WT_SESSION', 'TERM', 'TERM_PROGRAM', 'ConEmuTask', 'TERMINUS_SUBLIME']) delete process.env[key];
    Object.assign(process.env, env);

    vi.resetModules();

    try {
      return await import('../cli/lib/format.js');
    } finally {
      process.env = saved;
    }
  };

  it('uses plain ASCII where nothing says the terminal is modern', async () => {
    if (process.platform !== 'win32') return;

    const { S, unicode } = await load({});

    expect(unicode).toBe(false);
    expect(S.pointer).toBe('>');
    expect(S.ok).toBe('ok');
  });

  it('uses the glyphs inside Windows Terminal', async () => {
    const { S, unicode } = await load({ WT_SESSION: 'abc' });

    expect(unicode).toBe(true);
    expect(S.pointer).toBe('❯');
  });

  it('uses the glyphs everywhere that is not Windows', async () => {
    if (process.platform === 'win32') return;

    const { unicode } = await load({});
    expect(unicode).toBe(true);
  });

  it('does not let NO_COLOR change which glyphs are drawn', async () => {
    const withColour = await load({ WT_SESSION: 'abc' });
    const without = await load({ WT_SESSION: 'abc', NO_COLOR: '1' });

    expect(without.S.pointer).toBe(withColour.S.pointer);
  });
});
