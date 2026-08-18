import { describe, expect, it } from 'vitest';
import {
  CONTEXT_WINDOW_STORAGE_KEY,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  contextUsagePercent,
  contextUsageTone,
  readContextWindowTokens,
} from './context-window';

describe('context window usage', () => {
  it('reads a valid saved context window and falls back for invalid values', () => {
    const saved = { getItem: (key: string) => (key === CONTEXT_WINDOW_STORAGE_KEY ? '32768' : null) };
    const invalid = { getItem: () => 'not-a-number' };

    expect(readContextWindowTokens(saved)).toBe(32_768);
    expect(readContextWindowTokens(invalid)).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it('calculates rounded usage without hiding overflow', () => {
    expect(contextUsagePercent(5_775, 8_192)).toBe(70);
    expect(contextUsagePercent(9_000, 8_192)).toBe(110);
  });

  it('changes tone at exactly 70 and 90 percent', () => {
    expect(contextUsageTone(69)).toBe('normal');
    expect(contextUsageTone(70)).toBe('warning');
    expect(contextUsageTone(89)).toBe('warning');
    expect(contextUsageTone(90)).toBe('critical');
  });
});
