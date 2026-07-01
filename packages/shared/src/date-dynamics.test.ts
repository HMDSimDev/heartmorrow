import { describe, it, expect } from 'vitest';
import {
  RAPPORT_START,
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
