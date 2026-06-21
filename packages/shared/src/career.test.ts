import { describe, it, expect } from 'vitest';
import { CAREER } from './constants';
import { xpToReachLevel, levelForXp, masteryMult, careerProgress } from './career';

describe('career math', () => {
  it('cumulative XP curve matches XP_BASE·L·(L+1)/2', () => {
    expect(xpToReachLevel(0)).toBe(0);
    expect(xpToReachLevel(1)).toBe(100);
    expect(xpToReachLevel(2)).toBe(300);
    expect(xpToReachLevel(3)).toBe(600);
    expect(xpToReachLevel(5)).toBe(1500);
  });

  it('levelForXp maps cumulative XP to a level, clamped to MAX_LEVEL', () => {
    expect(levelForXp(0)).toBe(0);
    expect(levelForXp(99)).toBe(0);
    expect(levelForXp(100)).toBe(1);
    expect(levelForXp(299)).toBe(1);
    expect(levelForXp(300)).toBe(2);
    expect(levelForXp(1500)).toBe(CAREER.MAX_LEVEL);
    expect(levelForXp(9_999_999)).toBe(CAREER.MAX_LEVEL); // never exceeds the cap
  });

  it('masteryMult is flat-capped: 1.0 at L0, 1.75 at L5, no higher', () => {
    expect(masteryMult(0)).toBe(1);
    expect(masteryMult(5)).toBeCloseTo(1.75, 5);
    expect(masteryMult(99)).toBeCloseTo(1.75, 5); // clamped at MAX_LEVEL
  });

  it('careerProgress reports within-level fraction and a max flag', () => {
    const mid = careerProgress(50); // halfway to L1 (0→100)
    expect(mid.level).toBe(0);
    expect(mid.pct).toBeCloseTo(0.5, 5);
    expect(mid.atMax).toBe(false);

    const maxed = careerProgress(xpToReachLevel(CAREER.MAX_LEVEL));
    expect(maxed.level).toBe(CAREER.MAX_LEVEL);
    expect(maxed.atMax).toBe(true);
    expect(maxed.pct).toBe(1);
  });
});
