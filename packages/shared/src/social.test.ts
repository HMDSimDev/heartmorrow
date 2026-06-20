import { describe, it, expect } from 'vitest';
import {
  relationshipStage,
  jealousyProbability,
  isInternalFlagKey,
  capWarmthGain,
  positiveWarmth,
  textEngagementDelta,
  TEXT_DAILY_GAIN_CAP,
  pickConversationTopic,
  CONVERSATION_TOPICS,
  type TopicSignals,
} from './social';

const stats = (affection: number, rest = 5, tension = 0) => ({
  affection,
  trust: rest,
  chemistry: rest,
  comfort: rest,
  respect: rest,
  tension,
});

describe('relationshipStage', () => {
  it('reads as near-strangers at baseline', () => {
    expect(relationshipStage(stats(5)).label).toBe('near-strangers');
  });
  it('reads as sweethearts when very warm', () => {
    expect(relationshipStage({ affection: 90, trust: 90, chemistry: 85, comfort: 88, respect: 90, tension: 0 }).label).toBe(
      'sweethearts',
    );
  });
  it('flags tension when high', () => {
    expect(relationshipStage(stats(50, 50, 70)).guidance).toMatch(/tension/i);
  });
});

describe('jealousyProbability', () => {
  it('is zero with no other dates', () => {
    expect(jealousyProbability(0)).toBe(0);
  });
  it('rises with more dates and never exceeds the cap', () => {
    expect(jealousyProbability(1)).toBeGreaterThan(0);
    expect(jealousyProbability(99)).toBeLessThanOrEqual(0.7);
  });
});

describe('isInternalFlagKey', () => {
  it('hides bookkeeping keys but not story flags', () => {
    expect(isInternalFlagKey('lastSeenDay')).toBe(true);
    expect(isInternalFlagKey('buff:charm')).toBe(true);
    expect(isInternalFlagKey('state:jealous')).toBe(true);
    expect(isInternalFlagKey('metHerMother')).toBe(false);
  });
});

describe('capWarmthGain (daily texting cap)', () => {
  it('a single high-engagement text cannot exceed the daily cap', () => {
    // +3 engagement carries 4 positive warmth points, but the cap is 3.
    const base = textEngagementDelta(3);
    expect(positiveWarmth(base)).toBe(4);
    const { delta, applied } = capWarmthGain(base, TEXT_DAILY_GAIN_CAP);
    expect(applied).toBe(TEXT_DAILY_GAIN_CAP); // exactly 3, not 4
    expect(positiveWarmth(delta)).toBe(TEXT_DAILY_GAIN_CAP);
  });

  it('passes a delta through untouched when it fits the headroom', () => {
    const base = textEngagementDelta(1); // { comfort: 1 } → 1 point
    const { delta, applied } = capWarmthGain(base, 3);
    expect(applied).toBe(1);
    expect(delta).toEqual(base);
  });

  it('drops all positive warmth when no headroom remains, leaving negatives intact', () => {
    const base = { affection: 2, comfort: 1, tension: 0 };
    const { delta, applied } = capWarmthGain(base, 0);
    expect(applied).toBe(0);
    expect(positiveWarmth(delta)).toBe(0);
  });

  it('never touches negative components (being rude always lands)', () => {
    const base = textEngagementDelta(-2); // { affection: -1, comfort: -1, tension: 2 }
    const { delta } = capWarmthGain(base, 0);
    expect(delta.affection).toBe(-1);
    expect(delta.tension).toBe(2);
  });
});

describe('pickConversationTopic', () => {
  const bare: TopicSignals = {
    relationKind: null,
    bothEmployed: false,
    eitherHasGoals: false,
    sharesMutual: false,
    involvesPlayer: false,
  };

  it('always returns a canonical topic', () => {
    for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
      expect(CONVERSATION_TOPICS).toContain(pickConversationTopic(bare, roll));
    }
  });

  it('is deterministic — same signals + roll always yield the same topic', () => {
    const s: TopicSignals = { ...bare, bothEmployed: true, involvesPlayer: true };
    expect(pickConversationTopic(s, 0.42)).toBe(pickConversationTopic(s, 0.42));
  });

  it('falls back to catching-up with no signals', () => {
    expect(pickConversationTopic(bare, 0)).toBe('catching-up');
    expect(pickConversationTopic(bare, 0.999)).toBe('catching-up');
  });

  it('never offers the-player unless one of them is involved with the player', () => {
    // Even at every roll, a pair carrying no word about the player can't land on it.
    for (let r = 0; r < 1; r += 0.05) {
      expect(pickConversationTopic({ ...bare, bothEmployed: true, eitherHasGoals: true }, r)).not.toBe('the-player');
    }
  });

  it('can land on the-player only when involvesPlayer is set', () => {
    const involved: TopicSignals = { ...bare, involvesPlayer: true };
    // weights: catching-up(1) + the-player(3); a high roll lands in the-player band.
    expect(pickConversationTopic(involved, 0.9)).toBe('the-player');
  });

  it('leans exes toward the-past', () => {
    const exes: TopicSignals = { ...bare, relationKind: 'ex' };
    expect(pickConversationTopic(exes, 0.9)).toBe('the-past');
  });
});
