import { describe, expect, it } from 'vitest';
import {
  availableIntents,
  toIntent,
  INTENTS,
  INTENT_CUE,
  INTENT_LABELS,
  INTENT_ICONS,
  IntentSchema,
} from './intent';

describe('intents', () => {
  it('toIntent accepts canonical values and rejects everything else', () => {
    expect(toIntent('flirt')).toBe('flirt');
    expect(toIntent('apologize')).toBe('apologize');
    expect(toIntent('smooch')).toBeNull();
    expect(toIntent(null)).toBeNull();
    expect(toIntent(42)).toBeNull();
    expect(toIntent(undefined)).toBeNull();
  });

  it('every intent has a label, icon, and cue', () => {
    for (const i of INTENTS) {
      expect(INTENT_LABELS[i]).toBeTruthy();
      expect(INTENT_ICONS[i]).toBeTruthy();
      expect(INTENT_CUE[i]).toBeTruthy();
    }
  });

  it('IntentSchema validates membership', () => {
    expect(IntentSchema.safeParse('tease').success).toBe(true);
    expect(IntentSchema.safeParse('nope').success).toBe(false);
  });

  it('offers only the connection moves on a calm relationship', () => {
    const calm = availableIntents({ tension: 0 });
    expect(calm).toEqual(['flirt', 'tease', 'open_up']);
    expect(calm).not.toContain('apologize');
    expect(calm).not.toContain('reassure');
  });

  it('surfaces the repair moves once tension is real (and keeps the rest)', () => {
    const tense = availableIntents({ tension: 40 });
    expect(tense).toContain('apologize');
    expect(tense).toContain('reassure');
    expect(tense).toContain('flirt');
    expect(tense).toContain('tease');
    expect(tense).toContain('open_up');
  });

  it('gates the repair moves exactly at the tension threshold', () => {
    expect(availableIntents({ tension: 19 })).not.toContain('apologize');
    expect(availableIntents({ tension: 20 })).toContain('apologize');
  });
});
