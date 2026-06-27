import {
  DayRecordSchema,
  WorldCalendarSchema,
  SEASON_LENGTH,
  GEN_TEXT,
  type CalendarEntry,
  type DayRecap,
  type DayRecord,
  type DayRecordBeat,
  type GameEvent,
  type WorldCalendar,
  type WorldSimResult,
} from '@dsim/shared';
import { dayRecordsRepo, eventsRepo, worldStatesRepo } from '../db/repositories';
import { weatherForDay } from './ambiance-service';
import { RECAP_EVENT_TYPES, beatFromEvent, summarizeRepeatables } from '../lib/day-events';

/**
 * The almanac: persists one summary per world-day and serves the Calendar app.
 *
 * Two write paths feed the same `day_records` table:
 *   1. LIVE — `recordDay` is called by the world clock when a day ends, storing
 *      the real LLM recap + the day's beats.
 *   2. BACKFILL — `getWorldCalendar` lazily reconstructs any earlier day that has
 *      no record yet (days that elapsed before this feature existed) from the
 *      world's events, marking them `reconstructed: true` with a synthesized
 *      narrative. Idempotent: it only fills gaps.
 *
 * Weather / day-of-week / season / holiday are NOT stored — they are pure
 * functions of (worldId, day) and are recomputed on read.
 */

const MAX_BEATS_PER_DAY = 24;

/** Collect the day's player-facing beats (+ the world-sim "around town" beats). */
function buildBeats(events: GameEvent[], worldSim: WorldSimResult | null): DayRecordBeat[] {
  const townBeats: DayRecordBeat[] = [];
  for (const wb of worldSim?.beats ?? []) {
    if (wb.summary && wb.summary.trim()) {
      townBeats.push({ icon: '🏘️', text: wb.summary.trim().slice(0, GEN_TEXT.line), tone: 'neutral' });
    }
  }
  const playerBeats: DayRecordBeat[] = [];
  for (const e of events) {
    if (!RECAP_EVENT_TYPES.has(e.type)) continue;
    const beat = beatFromEvent(e);
    if (beat) playerBeats.push(beat);
  }
  // Collapsed work/bonding/texting beats (kept out of RECAP_EVENT_TYPES on purpose,
  // so they're summarized here from the full event list rather than rendered each).
  playerBeats.push(...summarizeRepeatables(events));
  // Reserve room for the (already bounded) town beats so a very busy player day
  // never truncates the "Around town" summary away — keep player beats first.
  const playerRoom = Math.max(0, MAX_BEATS_PER_DAY - townBeats.length);
  return [...playerBeats.slice(0, playerRoom), ...townBeats].slice(0, MAX_BEATS_PER_DAY);
}

/** A deterministic (no-LLM) recap for a reconstructed day, built from its beats. */
function synthesizeRecap(beats: DayRecordBeat[]): Pick<DayRecord, 'headline' | 'narrative' | 'highlights'> {
  if (beats.length === 0) {
    return {
      headline: 'A quiet day',
      narrative: 'A calm, uneventful day — nothing much happened.',
      highlights: [],
    };
  }
  const highlights = beats.map((b) => b.text).slice(0, 8);
  const lead = beats.find((b) => b.tone !== 'neutral') ?? beats[0]!;
  const headline = lead.text.length <= 64 ? lead.text : `${beats.length} things happened`;
  return { headline, narrative: beats.map((b) => b.text).join(' '), highlights };
}

export interface RecordDayInput {
  recap: DayRecap | null;
  worldSim: WorldSimResult | null;
  income: number;
  /** The ended day's events (captured before the clock advanced). */
  events: GameEvent[];
}

/** Persist the day that just ended (the live path, from the world clock). */
export function recordDay(worldId: string, day: number, input: RecordDayInput): DayRecord {
  const now = Date.now();
  const beats = buildBeats(input.events, input.worldSim);
  const existing = dayRecordsRepo.get(worldId, day);
  const rec = DayRecordSchema.parse({
    worldId,
    day,
    headline: input.recap?.headline ?? '',
    narrative: input.recap?.narrative ?? '',
    highlights: input.recap?.highlights ?? [],
    beats,
    income: Math.max(0, Math.round(input.income ?? 0)),
    reconstructed: false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  return dayRecordsRepo.upsert(rec);
}

/**
 * Reconstruct any completed day (1 … currentDay-1) that has no record yet. Events
 * are bucketed by their in-world day using the `day_advanced` markers: the day
 * that ENDS at an advance(→N) is day N-1, so events recorded before that marker
 * belong to it. The trailing bucket is the in-progress day and is left alone.
 */
function backfillWorld(worldId: string, currentDay: number): void {
  if (currentDay <= 1) return; // nothing has been completed yet
  const existing = dayRecordsRepo.daysForWorld(worldId);
  let hasGap = false;
  for (let d = 1; d < currentDay; d += 1) {
    if (!existing.has(d)) {
      hasGap = true;
      break;
    }
  }
  if (!hasGap) return;

  // World-scoped + oldest-first (legacy NULL-world rows are excluded by the repo,
  // so one world's calendar never narrates another's day).
  const events = eventsRepo.listSinceByWorld(worldId, 0);
  const byDay = new Map<number, GameEvent[]>();
  let bucket: GameEvent[] = [];
  for (const e of events) {
    if (e.type === 'day_advanced') {
      const newDay = Number((e.payload as Record<string, unknown>).day);
      if (Number.isFinite(newDay) && newDay >= 2) {
        const endedDay = newDay - 1;
        byDay.set(endedDay, (byDay.get(endedDay) ?? []).concat(bucket));
      }
      bucket = [];
    } else {
      bucket.push(e);
    }
  }

  const now = Date.now();
  for (let d = 1; d < currentDay; d += 1) {
    if (existing.has(d)) continue;
    const beats = buildBeats(byDay.get(d) ?? [], null);
    const synth = synthesizeRecap(beats);
    dayRecordsRepo.upsert(
      DayRecordSchema.parse({
        worldId,
        day: d,
        ...synth,
        beats,
        income: 0,
        reconstructed: true,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }
}

/**
 * Force-fill any missing completed-day records for a world. Used before export so
 * the bundle is self-contained — exportAll caps the event log at the newest 1000
 * rows, so without this an old day whose live recordDay never ran (or predates the
 * feature) could not be reconstructed from a truncated event stream after import.
 */
export function ensureDayRecords(worldId: string): void {
  const state = worldStatesRepo.get(worldId);
  backfillWorld(worldId, state?.day ?? 1);
}

/**
 * The full almanac for a world: every day 1 … end-of-current-season, oldest first.
 * O(currentDay) in entries — fine for a local single-user save; if playthroughs
 * ever run to thousands of days, window this to a season range.
 */
export function getWorldCalendar(worldId: string): WorldCalendar {
  const state = worldStatesRepo.get(worldId);
  const currentDay = state?.day ?? 1;
  backfillWorld(worldId, currentDay);

  const records = new Map(dayRecordsRepo.listByWorld(worldId).map((r) => [r.day, r] as const));
  // Round up to the end of the current season so the live season renders as a full
  // 4×7 grid (28-day seasons start on a Monday — see deriveCalendar).
  const lastDay = Math.ceil(currentDay / SEASON_LENGTH) * SEASON_LENGTH;
  const entries: CalendarEntry[] = [];
  for (let day = 1; day <= lastDay; day += 1) {
    const w = weatherForDay(worldId, day);
    entries.push({
      day,
      weather: { kind: w.kind, label: w.label, icon: w.icon },
      record: records.get(day) ?? null,
    });
  }
  return WorldCalendarSchema.parse({ worldId, currentDay, entries });
}
