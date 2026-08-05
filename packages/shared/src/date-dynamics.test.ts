import { describe, it, expect } from 'vitest';
import {
  DIFFICULTIES,
  DIFFICULTY,
  RAPPORT_START,
  scaleEvaluationDeltas,
  startingRapport,
  turnRapportDelta,
  rapportLabel,
  guardednessDescriptor,
} from './date-dynamics';

describe('startingRapport', () => {
  it('opens at the neutral midpoint for an open character', () => {
    expect(startingRapport(0)).toBe(RAPPORT_START);
  });
  it('opens cooler the more guarded the character', () => {
    expect(startingRapport(100)).toBeLessThan(startingRapport(50));
    expect(startingRapport(50)).toBeLessThan(startingRapport(0));
    expect(startingRapport(100)).toBeGreaterThanOrEqual(0);
  });
});

describe('turnRapportDelta', () => {
  it('is asymmetric: a bad beat costs more than an equal good beat gains', () => {
    expect(Math.abs(turnRapportDelta(-3))).toBeGreaterThan(turnRapportDelta(3));
    expect(Math.abs(turnRapportDelta(-2))).toBeGreaterThan(turnRapportDelta(2));
  });

  it('an empty turn builds nothing: steady for an open character, a slight cool for a guarded one', () => {
    expect(turnRapportDelta(0)).toBe(0); // open: a forgettable turn holds the line — no free coasting UP
    expect(turnRapportDelta(0, { guardedness: 80 })).toBeLessThan(0); // guarded: extends less goodwill → slips
    // …and a guarded person cools faster on a wasted turn than an open one.
    expect(turnRapportDelta(0, { guardedness: 80 })).toBeLessThan(turnRapportDelta(0, { guardedness: 0 }));
  });

  it('guarded characters warm more slowly on a good turn', () => {
    expect(turnRapportDelta(3, { guardedness: 80 })).toBeLessThan(turnRapportDelta(3, { guardedness: 0 }));
    expect(turnRapportDelta(2, { guardedness: 80 })).toBeLessThan(turnRapportDelta(2, { guardedness: 0 }));
    expect(turnRapportDelta(3, { guardedness: 80 })).toBeGreaterThan(0); // still warms, just less
  });

  it('but cools just as fast regardless of guardedness (only the upside is dampened)', () => {
    expect(turnRapportDelta(-3, { guardedness: 80 })).toBe(turnRapportDelta(-3, { guardedness: 0 }));
    expect(turnRapportDelta(-2, { guardedness: 80 })).toBe(turnRapportDelta(-2, { guardedness: 0 }));
  });

  it('clamps engagement to the -3..+3 range', () => {
    expect(turnRapportDelta(99)).toBe(turnRapportDelta(3));
    expect(turnRapportDelta(-99)).toBe(turnRapportDelta(-3));
  });
});

describe('difficulty', () => {
  it("'normal' is the identity row — the tuned baseline stays byte-identical", () => {
    expect(DIFFICULTY.normal.posMult).toBe(1);
    expect(DIFFICULTY.normal.negMult).toBe(1);
    expect(DIFFICULTY.normal.endShift).toBe(0);
    expect(DIFFICULTY.normal.evalGainMult).toBe(1);
    expect(DIFFICULTY.normal.evalHarmMult).toBe(1);
    for (const e of [-3, -2, -1, 0, 1, 2, 3]) {
      expect(turnRapportDelta(e, { difficulty: 'normal' })).toBe(turnRapportDelta(e));
      expect(turnRapportDelta(e, { guardedness: 80, difficulty: 'normal' })).toBe(
        turnRapportDelta(e, { guardedness: 80 }),
      );
    }
  });

  it('gentle warms faster and cools slower; harsh the reverse', () => {
    expect(turnRapportDelta(2, { difficulty: 'gentle' })).toBeGreaterThan(turnRapportDelta(2));
    expect(turnRapportDelta(-2, { difficulty: 'gentle' })).toBeGreaterThan(turnRapportDelta(-2)); // a softer loss
    expect(turnRapportDelta(2, { difficulty: 'harsh' })).toBeLessThan(turnRapportDelta(2));
    expect(turnRapportDelta(-2, { difficulty: 'harsh' })).toBeLessThan(turnRapportDelta(-2)); // a deeper loss
  });

  it('never inverts a turn: an open character’s empty turn stays 0 on every difficulty', () => {
    for (const d of DIFFICULTIES) expect(turnRapportDelta(0, { difficulty: d })).toBe(0);
  });

  it('a genuine +1 still registers on harsh, even fully guarded (hard, not futile)', () => {
    expect(turnRapportDelta(1, { guardedness: 100, difficulty: 'harsh' })).toBeGreaterThanOrEqual(1);
  });

  it('difficulty never moves the opening rapport (startingRapport has no difficulty input)', () => {
    expect(startingRapport(0)).toBe(RAPPORT_START);
    expect(startingRapport.length).toBeLessThanOrEqual(1); // guardedness only — keep it that way
  });
});

describe('scaleEvaluationDeltas', () => {
  it("'normal' is exactly identity", () => {
    const deltas = { affection: 3, comfort: -2, tension: -1 };
    expect(scaleEvaluationDeltas(deltas, 'normal')).toEqual(deltas);
  });

  it('scales by HARM direction, not raw sign — tension is inverted', () => {
    const gentle = scaleEvaluationDeltas({ affection: -2, comfort: 2, tension: 3 }, 'gentle');
    expect(gentle.affection).toBe(-1); // a loss, softened (−2 × 0.6)
    expect(gentle.comfort).toBe(3); // a gain, sweetened (2 × 1.25)
    expect(gentle.tension).toBe(2); // a tension RISE is harm → softened (3 × 0.6)

    const harsh = scaleEvaluationDeltas({ affection: -2, tension: -2 }, 'harsh');
    expect(harsh.affection).toBe(-3); // a loss, sharpened (−2 × 1.3)
    expect(harsh.tension).toBe(-2); // a tension DROP is a win → gain-scaled (−2 × 0.8)
  });

  it('a zero delta stays zero and unknown junk is dropped', () => {
    expect(scaleEvaluationDeltas({ affection: 0 }, 'harsh')).toEqual({ affection: 0 });
    expect(scaleEvaluationDeltas({ affection: Number.NaN }, 'gentle')).toEqual({});
  });
});

describe('rapportLabel', () => {
  it('reads neutral at the midpoint and diverges to warm / cold', () => {
    expect(rapportLabel(RAPPORT_START)).toBe('finding the rhythm');
    expect(rapportLabel(95)).toBe('enchanted');
    expect(rapportLabel(5)).toBe('checked out');
  });
});

describe('guardednessDescriptor', () => {
  it('scales from an open book to walled off', () => {
    expect(guardednessDescriptor(0)).toMatch(/open/);
    expect(guardednessDescriptor(90)).toMatch(/guarded/);
  });
});
