import { z } from 'zod';

/**
 * Time-of-day phases for the per-world game clock. This is the single source of
 * truth for the phase contract — the clock derives the current phase from
 * stamina spent, and (later) the phone schedules texts/emails by phase.
 */
export const PHASE_KEYS = ['morning', 'afternoon', 'evening', 'night'] as const;
export type Phase = (typeof PHASE_KEYS)[number];
export const PhaseSchema = z.enum(PHASE_KEYS);

export const PHASE_LABELS: Record<Phase, string> = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  night: 'Night',
};

export const PHASE_ICONS: Record<Phase, string> = {
  morning: '🌅',
  afternoon: '☀️',
  evening: '🌆',
  night: '🌙',
};

/**
 * Derive the time-of-day from how much stamina has been spent today. With the
 * default budget (3), the day visibly walks morning → afternoon → evening as
 * the player spends actions, landing on night when stamina hits 0.
 */
export function phaseForStaminaSpent(spent: number, staminaMax: number): Phase {
  if (staminaMax <= 0) return 'morning';
  const last = PHASE_KEYS.length - 1;
  const idx = Math.max(0, Math.min(last, Math.round((spent / staminaMax) * last)));
  return PHASE_KEYS[idx]!;
}

/** Ordinal of a phase within the day (morning=0 … night=3). */
export function phaseIndex(phase: Phase): number {
  return PHASE_KEYS.indexOf(phase);
}

// --- Calendar (day-of-week + seasons + holidays, derived from the day counter) ---

export const DAYS_OF_WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;
export type Season = (typeof SEASONS)[number];
export const SEASON_ICONS: Record<Season, string> = { Spring: '🌱', Summer: '☀️', Autumn: '🍂', Winter: '❄️' };

/** Days per season; four seasons make a 112-day "year". */
export const SEASON_LENGTH = 28;
/** Extra action stamina granted on weekend days. */
export const WEEKEND_BONUS_STAMINA = 1;

export interface Holiday {
  name: string;
  blurb: string; // player-facing one-liner
  tag: string; // injected into the dialogue prompt as scene atmosphere
}

/** Fixed in-world holidays, keyed by `${seasonIndex}:${seasonDay}`. Recur each year. */
export const HOLIDAYS: Record<string, Holiday> = {
  '0:7': {
    name: 'First Bloom',
    blurb: 'The Quarter celebrates the first flowers of spring.',
    tag: 'It is First Bloom — the first flowers of spring are everywhere and spirits are light.',
  },
  '1:21': {
    name: 'Midsummer Night',
    blurb: 'A warm, late-night street party fills the boardwalk.',
    tag: 'It is Midsummer Night — a warm, festive holiday that peaks in a slightly wild boardwalk street party after dark.',
  },
  '2:14': {
    name: 'The Lantern Festival',
    blurb: 'Paper lanterns drift down the river tonight — the most romantic night of the year.',
    tag: 'It is the Lantern Festival — a day of paper lanterns set adrift on the river, and the mood is romantic and a little magical.',
  },
  '3:25': {
    name: 'The Long Night',
    blurb: 'The coziest, quietest night of winter — everyone huddles close.',
    tag: 'It is the Long Night — the coziest, quietest stretch of winter, when people draw close for warmth.',
  },
};

export interface CalendarDay {
  day: number;
  /** 0 = Monday … 6 = Sunday. */
  dayIndex: number;
  dayOfWeek: string;
  isWeekend: boolean;
  seasonIndex: number;
  season: Season;
  /** 1 … SEASON_LENGTH. */
  seasonDay: number;
  holiday: Holiday | null;
}

/** Derive the calendar for an in-world day (day 1 = the first Monday of Spring). */
export function deriveCalendar(day: number): CalendarDay {
  const d = Math.max(1, Math.floor(day));
  const dayIndex = (d - 1) % 7;
  const yearLen = SEASONS.length * SEASON_LENGTH;
  const dayOfYear = (d - 1) % yearLen;
  const seasonIndex = Math.floor(dayOfYear / SEASON_LENGTH);
  const seasonDay = (dayOfYear % SEASON_LENGTH) + 1;
  return {
    day: d,
    dayIndex,
    dayOfWeek: DAYS_OF_WEEK[dayIndex]!,
    isWeekend: dayIndex >= 5,
    seasonIndex,
    season: SEASONS[seasonIndex]!,
    seasonDay,
    holiday: HOLIDAYS[`${seasonIndex}:${seasonDay}`] ?? null,
  };
}
