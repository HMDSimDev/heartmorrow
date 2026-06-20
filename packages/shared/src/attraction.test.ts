import { describe, it, expect } from 'vitest';
import { attractedToGender, mutualAttraction, orientationLabel, incompatibleWarmthCap, type Orientation } from './social';

const straightMan: Orientation = { gender: 'male', sexuality: 'straight' };
const straightWoman: Orientation = { gender: 'female', sexuality: 'straight' };
const gayMan: Orientation = { gender: 'male', sexuality: 'gay' };
const lesbian: Orientation = { gender: 'female', sexuality: 'gay' };
const biWoman: Orientation = { gender: 'female', sexuality: 'bisexual' };

describe('attractedToGender', () => {
  it('a straight man is into women, not men', () => {
    expect(attractedToGender(straightMan, 'female')).toBe(true);
    expect(attractedToGender(straightMan, 'male')).toBe(false);
  });
  it('a gay man is into men, not women', () => {
    expect(attractedToGender(gayMan, 'male')).toBe(true);
    expect(attractedToGender(gayMan, 'female')).toBe(false);
  });
  it('a bisexual person is into everyone', () => {
    expect(attractedToGender(biWoman, 'female')).toBe(true);
    expect(attractedToGender(biWoman, 'male')).toBe(true);
    expect(attractedToGender(biWoman, 'nonbinary')).toBe(true);
  });
  it('is permissive whenever info is missing or non-binary is involved (opt-in gate)', () => {
    expect(attractedToGender({ gender: 'unspecified', sexuality: 'straight' }, 'male')).toBe(true);
    expect(attractedToGender({ gender: 'male', sexuality: 'unspecified' }, 'male')).toBe(true);
    expect(attractedToGender({ gender: 'nonbinary', sexuality: 'gay' }, 'female')).toBe(true);
    expect(attractedToGender(gayMan, 'nonbinary')).toBe(true);
    expect(attractedToGender(gayMan, 'unspecified')).toBe(true);
  });
});

describe('mutualAttraction', () => {
  it('a straight man + a lesbian are NOT mutual (she is the one not into him)', () => {
    const m = mutualAttraction(straightMan, lesbian);
    expect(m.mutual).toBe(false);
    expect(m.aIntoB).toBe(true); // he's into a woman
    expect(m.bIntoA).toBe(false); // she's not into a man
  });
  it('a gay man + a straight woman are NOT mutual (he is the one not into her)', () => {
    const m = mutualAttraction(gayMan, straightWoman);
    expect(m.mutual).toBe(false);
    expect(m.aIntoB).toBe(false); // he's not into a woman
    expect(m.bIntoA).toBe(true); // she's into a man
  });
  it('a straight man + a straight woman ARE mutual', () => {
    expect(mutualAttraction(straightMan, straightWoman).mutual).toBe(true);
  });
  it('anyone unspecified is treated as compatible (no gating)', () => {
    expect(mutualAttraction({ gender: 'unspecified', sexuality: 'unspecified' }, lesbian).mutual).toBe(true);
  });
});

describe('orientationLabel', () => {
  it('names a gay woman a lesbian, a gay man gay', () => {
    expect(orientationLabel('female', 'gay')).toBe('a lesbian');
    expect(orientationLabel('male', 'gay')).toBe('gay');
    expect(orientationLabel('male', 'straight')).toBe('straight');
    expect(orientationLabel('female', 'bisexual')).toBe('bisexual');
    expect(orientationLabel('unspecified', 'unspecified')).toBe('');
  });
});

describe('incompatibleWarmthCap', () => {
  it('caps below the romantic "getting-close" band', () => {
    // Acquaintances (10–24) is the default ceiling; just under warming-up (25).
    expect(incompatibleWarmthCap()).toBe(24);
  });
});
