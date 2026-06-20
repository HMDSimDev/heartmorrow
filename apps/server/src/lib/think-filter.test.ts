import { describe, it, expect } from 'vitest';
import { ThinkStripper, stripThink } from './think-filter';

describe('stripThink (one-shot)', () => {
  it('removes a complete think block', () => {
    expect(stripThink('<think>reasoning here</think>Hello there!')).toBe('Hello there!');
  });

  it('removes multiline/multiblock reasoning', () => {
    expect(stripThink('<think>line1\nline2</think>A<think>more</think>B')).toBe('AB');
  });

  it('is case-insensitive', () => {
    expect(stripThink('<THINK>x</THINK>Hi')).toBe('Hi');
  });

  it('surfaces an unclosed think block rather than returning empty', () => {
    // Some models open <think> but never close it; we must not lose the reply.
    expect(stripThink('<think>reasoning then the actual answer at the end')).toBe(
      'reasoning then the actual answer at the end',
    );
    expect(stripThink('Visible.<think>more')).toBe('Visible.more');
  });

  it('leaves text without think tags untouched', () => {
    expect(stripThink('Just a normal reply with a < sign and 3<4.')).toBe('Just a normal reply with a < sign and 3<4.');
  });
});

describe('ThinkStripper (streaming)', () => {
  it('emits nothing while inside a think block, then the real reply', () => {
    const s = new ThinkStripper();
    const chunks = ['<think>', 'reasoning ', 'tokens', '</think>', 'Hi', ' there'];
    const emitted = chunks.map((c) => s.push(c)).join('') + s.end();
    expect(emitted).toBe('Hi there');
    expect(s.visible).toBe('Hi there');
  });

  it('never emits a partial tag split across chunk boundaries', () => {
    const s = new ThinkStripper();
    // "<think>" arrives as "<thi" + "nk>"
    const out: string[] = [];
    out.push(s.push('<thi'));
    out.push(s.push('nk>secret'));
    out.push(s.push(' more</thin'));
    out.push(s.push('k>Done'));
    out.push(s.end());
    expect(out.join('')).toBe('Done');
    // crucially, the partial "<thi" was never emitted as visible text
    expect(out.join('')).not.toContain('<');
  });

  it('flushes an unclosed think block at end of stream', () => {
    const s = new ThinkStripper();
    const live = ['<think>', 'reasoning ', 'and answer'].map((c) => s.push(c));
    expect(live.join('')).toBe(''); // nothing emitted while (apparently) inside think
    expect(s.end()).toBe('reasoning and answer'); // surfaced at the end, not lost
  });

  it('streams a normal reply token-by-token unchanged', () => {
    const s = new ThinkStripper();
    const emitted = ['He', 'llo', ' world'].map((c) => s.push(c)).join('') + s.end();
    expect(emitted).toBe('Hello world');
  });

  it('holds back a trailing lone "<" until disambiguated, then flushes it', () => {
    const s = new ThinkStripper();
    let out = s.push('value <'); // could be start of <think>
    out += s.push(' 3'); // it was not; "<" should now be safe
    out += s.end();
    expect(out).toBe('value < 3');
  });
});
