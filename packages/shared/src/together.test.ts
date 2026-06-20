import { describe, it, expect } from 'vitest';
import { resolveTogether, togetherFit, fitLabel, type TogetherInput } from './together';
import { ACTIVITIES, TOGETHER_SOFT_CEILING, type ActivityDef } from './activities';
import type { DatingStats } from './stats';

const act = (id: string): ActivityDef => ACTIVITIES.find((a) => a.id === id)!;

const stats = (over: Partial<DatingStats> = {}): DatingStats => ({
  charm: 50,
  empathy: 50,
  humor: 50,
  confidence: 50,
  intellect: 50,
  style: 50,
  ...over,
});

type Rel = TogetherInput['relationship'];
const rel = (over: Partial<Rel> = {}): Rel => ({
  affection: 5,
  trust: 5,
  chemistry: 5,
  comfort: 5,
  respect: 5,
  curiosity: 10,
  tension: 0,
  ...over,
});

// A baseline for the no-risk cozy outing (boldness 0 → never misfires, never sparks
// at ok fit), so a single varied knob is what moves the result.
const base = (over: Partial<TogetherInput> = {}): TogetherInput => ({
  activity: act('tg_in'),
  datingStats: stats(),
  guardedness: 30,
  relationship: rel(),
  current: 5,
  timesToday: 0,
  roll: 0.2,
  ...over,
});

describe('togetherFit / fitLabel', () => {
  it('averages the activity fit-traits and buckets them', () => {
    expect(togetherFit(act('tg_in'), stats({ empathy: 90 }))).toBe(90);
    expect(togetherFit(act('tg_culture'), stats({ intellect: 80, style: 40 }))).toBe(60);
    expect(fitLabel(90)).toBe('great');
    expect(fitLabel(50)).toBe('ok');
    expect(fitLabel(20)).toBe('poor');
  });
});

describe('resolveTogether — fit', () => {
  it('a great fit lands warmer than a poor fit', () => {
    const good = resolveTogether(base({ datingStats: stats({ empathy: 100 }) }));
    const poor = resolveTogether(base({ datingStats: stats({ empathy: 0 }) }));
    expect(good.result.statDelta).toBeGreaterThan(poor.result.statDelta);
    expect(good.result.fit).toBe('great');
    expect(poor.result.fit).toBe('poor');
  });
});

describe('resolveTogether — diminishing returns toward the ceiling', () => {
  it('gives less the closer the stat is to the soft ceiling', () => {
    const low = resolveTogether(base({ current: 5 }));
    const high = resolveTogether(base({ current: 40 }));
    expect(low.result.statDelta).toBeGreaterThan(high.result.statDelta);
  });

  it('cannot push a warmth stat past the ceiling — it goes flat', () => {
    const atCeiling = resolveTogether(base({ current: TOGETHER_SOFT_CEILING }));
    expect(atCeiling.result.statDelta).toBe(0);
    expect(atCeiling.result.outcome).toBe('flat');
  });
});

describe('resolveTogether — per-person daily cap', () => {
  it('a second outing the same day gives strictly less, a third crowds', () => {
    const first = resolveTogether(base({ timesToday: 0 }));
    const second = resolveTogether(base({ timesToday: 1 }));
    const third = resolveTogether(base({ timesToday: 2 }));
    expect(second.result.statDelta).toBeLessThan(first.result.statDelta);
    expect(third.result.outcome).toBe('crowded');
    expect(third.result.statDelta).toBe(0);
    expect(third.result.tensionDelta).toBeGreaterThan(0);
  });
});

describe('resolveTogether — risk', () => {
  it('a bold move on a guarded, cool, poorly-matched person misfires', () => {
    const res = resolveTogether({
      activity: act('tg_talk'), // boldness 0.55
      datingStats: stats({ empathy: 0, intellect: 0 }),
      guardedness: 100,
      relationship: rel(),
      current: 5,
      timesToday: 0,
      roll: 0,
    });
    expect(res.result.outcome).toBe('misfire');
    expect(res.result.statDelta).toBe(0);
    expect(res.result.tensionDelta).toBeGreaterThan(0);
  });

  it('the same bold move is safe once it suits them and the bond is warm', () => {
    const res = resolveTogether({
      activity: act('tg_talk'),
      datingStats: stats({ empathy: 100, intellect: 100 }),
      guardedness: 0,
      relationship: rel({ affection: 30, trust: 30, chemistry: 30, comfort: 30, respect: 30 }),
      current: 20,
      timesToday: 0,
      roll: 0.5,
    });
    expect(res.result.outcome).not.toBe('misfire');
  });

  it('a great-fit, first-of-day outing with room can spark a remembered moment', () => {
    const res = resolveTogether(base({ datingStats: stats({ empathy: 100 }), roll: 0.99 }));
    expect(res.result.outcome).toBe('spark');
    expect(res.result.memorable).toBe(true);
  });
});

describe('resolveTogether — invariants', () => {
  it('is deterministic for identical inputs', () => {
    const input = base({ activity: act('tg_out'), current: 10, roll: 0.42 });
    expect(resolveTogether(input)).toEqual(resolveTogether(input));
  });

  it('never targets affection — the romantic core stays date-only', () => {
    const togetherActs = ACTIVITIES.filter((a) => a.kind === 'together');
    expect(togetherActs.length).toBeGreaterThan(0);
    expect(togetherActs.every((a) => a.relationshipStat !== 'affection')).toBe(true);
  });
});
