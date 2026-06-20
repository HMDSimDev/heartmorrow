import { describe, it, expect } from 'vitest';
import { deriveCalendar, SEASON_LENGTH } from './time';

describe('deriveCalendar', () => {
  it('day 1 is a Spring Monday; days 6-7 are the weekend', () => {
    const d1 = deriveCalendar(1);
    expect(d1.dayOfWeek).toBe('Monday');
    expect(d1.isWeekend).toBe(false);
    expect(d1.season).toBe('Spring');
    expect(d1.seasonDay).toBe(1);
    expect(deriveCalendar(6).isWeekend).toBe(true); // Saturday
    expect(deriveCalendar(7).isWeekend).toBe(true); // Sunday
    expect(deriveCalendar(8).isWeekend).toBe(false); // next Monday
  });

  it('rolls into the next season after SEASON_LENGTH days, wrapping after four', () => {
    expect(deriveCalendar(SEASON_LENGTH).season).toBe('Spring');
    expect(deriveCalendar(SEASON_LENGTH + 1).season).toBe('Summer');
    expect(deriveCalendar(SEASON_LENGTH * 4 + 1).season).toBe('Spring'); // year wraps
  });

  it('surfaces a holiday only on its day', () => {
    expect(deriveCalendar(7).holiday?.name).toBe('First Bloom'); // spring day 7
    expect(deriveCalendar(8).holiday).toBeNull();
  });
});
