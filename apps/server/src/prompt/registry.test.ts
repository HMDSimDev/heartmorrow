import { describe, it, expect, afterEach } from 'vitest';
import {
  resolvePrompt,
  buildPromptCatalog,
  validateOverride,
  setPromptOverrides,
  applyPreviewOverrides,
  isPromptId,
} from './registry';
import {
  SYSTEM_GUARDRAILS,
  EVALUATOR_GUARDRAILS,
  TURN_JUDGE_GUARDRAILS,
  GIFT_GUARDRAILS,
  PLAYER_FAREWELL_GUARDRAILS,
  ITEM_GEN_GUARDRAILS,
  SMS_GUARDRAILS,
} from './guardrails';

// Always leave the global override cache empty for the next test/file.
afterEach(() => setPromptOverrides({}));

describe('prompt registry', () => {
  it('round-trips every named guardrail byte-for-byte with no override', () => {
    // The enum-interpolated ones are the risky ones (tokenize → fill must invert);
    // include plain ones too. Covers EXPRESSIONS, MEMORY_TAGS, STORY_FLAGS + DATA_NOT_INSTRUCTIONS.
    const cases: Array<[Parameters<typeof resolvePrompt>[0], string]> = [
      ['SYSTEM_GUARDRAILS', SYSTEM_GUARDRAILS],
      ['EVALUATOR_GUARDRAILS', EVALUATOR_GUARDRAILS],
      ['TURN_JUDGE_GUARDRAILS', TURN_JUDGE_GUARDRAILS],
      ['GIFT_GUARDRAILS', GIFT_GUARDRAILS],
      ['PLAYER_FAREWELL_GUARDRAILS', PLAYER_FAREWELL_GUARDRAILS],
      ['ITEM_GEN_GUARDRAILS', ITEM_GEN_GUARDRAILS],
      ['SMS_GUARDRAILS', SMS_GUARDRAILS],
    ];
    for (const [id, expected] of cases) {
      expect(resolvePrompt(id)).toBe(expected);
    }
  });

  it('exposes a complete catalog with metadata for every prompt', () => {
    const catalog = buildPromptCatalog();
    expect(catalog.length).toBeGreaterThan(40);
    for (const e of catalog) {
      expect(e.label.length).toBeGreaterThan(0);
      expect(e.purpose.length).toBeGreaterThan(0);
      expect(e.defaultText.length).toBeGreaterThan(0);
      expect(e.currentText).toBe(e.defaultText); // no overrides yet
      expect(e.isOverridden).toBe(false);
      expect(isPromptId(e.id)).toBe(true);
    }
  });

  it('fills inline-fragment tokens from the call-site vars', () => {
    const out = resolvePrompt('date.tonight', { dateNeed: 'They want to feel SEEN.', playerName: 'Robin' });
    expect(out).toContain('They want to feel SEEN.');
    expect(out).toContain('make Robin earn it');
    expect(out).not.toContain('{{'); // every token was filled
  });

  it('keeps the live enum list in a custom override via the {{EXPRESSIONS}} token', () => {
    setPromptOverrides({ TURN_JUDGE_GUARDRAILS: 'Pick an expression from: {{EXPRESSIONS}}. Be terse.' });
    const out = resolvePrompt('TURN_JUDGE_GUARDRAILS');
    expect(out).toContain('Pick an expression from:');
    expect(out).not.toContain('{{EXPRESSIONS}}'); // token resolved to the real list
    expect(out).toContain('happy'); // a known expression value
  });

  it('validates that required tokens are retained', () => {
    // date.tonight requires {{dateNeed}} and {{playerName}}.
    expect(validateOverride('date.tonight', 'just {{dateNeed}} for {{playerName}}.')).toEqual({ ok: true });
    const bad = validateOverride('date.tonight', 'no tokens here');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.missing.sort()).toEqual(['dateNeed', 'playerName']);
  });

  it('applies and restores preview overrides cleanly', () => {
    const before = resolvePrompt('SYSTEM_GUARDRAILS');
    const restore = applyPreviewOverrides({ SYSTEM_GUARDRAILS: 'PREVIEW ONLY' });
    expect(resolvePrompt('SYSTEM_GUARDRAILS')).toBe('PREVIEW ONLY');
    restore();
    expect(resolvePrompt('SYSTEM_GUARDRAILS')).toBe(before);
  });
});
