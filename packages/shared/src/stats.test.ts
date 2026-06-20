import { describe, it, expect } from 'vitest';
import {
  clampStat,
  applyRelationshipDeltas,
  applyDatingDeltas,
  DEFAULT_RELATIONSHIP_STATS,
  DEFAULT_DATING_STATS,
} from './stats';

describe('clampStat', () => {
  it('clamps below the minimum', () => {
    expect(clampStat(-20)).toBe(0);
  });

  it('clamps above the maximum', () => {
    expect(clampStat(180)).toBe(100);
  });

  it('rounds fractional values', () => {
    expect(clampStat(50.6)).toBe(51);
    expect(clampStat(50.4)).toBe(50);
  });

  it('returns the min for non-finite input', () => {
    expect(clampStat(Number.NaN)).toBe(0);
    expect(clampStat(Number.POSITIVE_INFINITY)).toBe(100);
  });

  it('respects custom bounds', () => {
    expect(clampStat(5, 1, 3)).toBe(3);
    expect(clampStat(-5, 1, 3)).toBe(1);
  });
});

describe('applyRelationshipDeltas', () => {
  it('applies and clamps deltas, leaving omitted keys unchanged', () => {
    const next = applyRelationshipDeltas(DEFAULT_RELATIONSHIP_STATS, {
      affection: 10,
      tension: -50,
    });
    expect(next.affection).toBe(15);
    expect(next.tension).toBe(0); // clamped at floor
    expect(next.trust).toBe(DEFAULT_RELATIONSHIP_STATS.trust);
  });

  it('never exceeds the ceiling', () => {
    const next = applyRelationshipDeltas({ ...DEFAULT_RELATIONSHIP_STATS, affection: 98 }, {
      affection: 50,
    });
    expect(next.affection).toBe(100);
  });
});

describe('applyDatingDeltas', () => {
  it('clamps dating stats to the valid range', () => {
    const next = applyDatingDeltas(DEFAULT_DATING_STATS, { charm: 999, style: -999 });
    expect(next.charm).toBe(100);
    expect(next.style).toBe(0);
  });
});
