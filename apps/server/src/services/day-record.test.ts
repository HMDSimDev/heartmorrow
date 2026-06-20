import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DAILY_INCOME } from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { createWorld } from './world-service';
import { createCharacter } from './character-service';
import { recordEvent } from './event-service';
import { advanceDay, getWorldState } from './world-clock-service';
import { getWorldCalendar } from './day-record-service';
import { exportAll } from './data-service';
import { dayRecordsRepo } from '../db/repositories';
import { getDb } from '../db/index';
import { setAdapterOverride } from '../llm/provider';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

function makeWorld(name: string) {
  const world = createWorld({ name });
  const character = createCharacter({
    worldId: world.id,
    name: `${name} person`,
    age: 25,
    datingStats: { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 },
  });
  return { world, character };
}

const recapAdapter = () =>
  new ScriptedAdapter([JSON.stringify({ headline: 'A lovely day', narrative: 'It was good.', highlights: ['saw someone'] })]);

/** Simulate a pre-feature save: drop the live records so getWorldCalendar must backfill. */
function dropDayRecords(worldId: string) {
  getDb().run('DELETE FROM day_records WHERE world_id = ?', worldId);
}

describe('day records — live persistence', () => {
  it('persists the ended day with the LLM recap and beats from the day events', async () => {
    const a = makeWorld('Alpha');
    setAdapterOverride(recapAdapter());
    getWorldState(a.world.id);
    recordEvent('milestone_reached', { characterId: a.character.id, label: 'First kiss' });

    await advanceDay(a.world.id); // day 1 → 2

    const rec = dayRecordsRepo.get(a.world.id, 1);
    expect(rec).toBeTruthy();
    expect(rec!.reconstructed).toBe(false);
    expect(rec!.headline).toBe('A lovely day');
    expect(rec!.beats.some((b) => /milestone/i.test(b.text) && b.tone === 'good')).toBe(true);
  });

  it('collapses repeatable actions (work, bonding, texting) into one beat apiece', async () => {
    const a = makeWorld('Alpha');
    setAdapterOverride(recapAdapter());
    getWorldState(a.world.id);

    // Two work shifts, one bonding session, and a text exchange — the kinds of
    // free/cheap actions that fire one event each and used to vanish from the recap.
    recordEvent('activity', { worldId: a.world.id, activityId: 'work_shift', kind: 'work', money: 50 });
    recordEvent('activity', { worldId: a.world.id, activityId: 'odd_jobs', kind: 'work', money: 50 });
    recordEvent('activity', { worldId: a.world.id, activityId: 'tg_in', kind: 'together', characterId: a.character.id, money: 0 });
    recordEvent('text_reply', { characterId: a.character.id, tone: 'warm' });

    await advanceDay(a.world.id); // day 1 → 2

    const beats = dayRecordsRepo.get(a.world.id, 1)!.beats;
    // Two shifts collapse to a single beat that sums the pay.
    expect(beats.some((b) => /Put in 2 shifts at work and earned 100 money/.test(b.text))).toBe(true);
    expect(beats.some((b) => /Spent time with Alpha person/.test(b.text))).toBe(true);
    expect(beats.some((b) => /Traded texts with Alpha person/.test(b.text))).toBe(true);
    // No flooding: each repeatable category yields at most one beat.
    expect(beats.filter((b) => /at work/.test(b.text))).toHaveLength(1);
  });

  it('records a quiet day with no beats when nothing meaningful happened', async () => {
    const a = makeWorld('Alpha');
    getWorldState(a.world.id);

    await advanceDay(a.world.id); // no events → canned quiet recap, no adapter needed

    const rec = dayRecordsRepo.get(a.world.id, 1);
    expect(rec).toBeTruthy();
    expect(rec!.beats).toHaveLength(0);
    expect(rec!.headline).toMatch(/quiet/i);
  });

  it('attributes income to the day it was credited (day 1 got none)', async () => {
    const a = makeWorld('Alpha');
    getWorldState(a.world.id);
    await advanceDay(a.world.id); // ends day 1
    await advanceDay(a.world.id); // ends day 2

    // Day 1 began with no rollover before it → no passive income on its record.
    expect(dayRecordsRepo.get(a.world.id, 1)!.income).toBe(0);
    // Day 2 began with the daily credit.
    expect(dayRecordsRepo.get(a.world.id, 2)!.income).toBe(DAILY_INCOME);
  });
});

describe('day records — backfill of pre-existing days', () => {
  it('reconstructs missing days from events, bucketing each event onto its own day', async () => {
    const a = makeWorld('Alpha');
    setAdapterOverride(recapAdapter());
    getWorldState(a.world.id);

    recordEvent('milestone_reached', { characterId: a.character.id, label: 'First kiss' });
    await advanceDay(a.world.id); // ends day 1
    recordEvent('breakup', { characterId: a.character.id });
    await advanceDay(a.world.id); // ends day 2 (now on day 3)

    // Pretend these days predate the feature: wipe the records, then read the calendar.
    dropDayRecords(a.world.id);
    const cal = getWorldCalendar(a.world.id);
    expect(cal.currentDay).toBe(3);

    const byDay = new Map(cal.entries.map((e) => [e.day, e]));
    const day1 = byDay.get(1)!.record!;
    const day2 = byDay.get(2)!.record!;

    expect(day1.reconstructed).toBe(true);
    expect(day1.beats.some((b) => /milestone/i.test(b.text))).toBe(true);
    // The day-2 breakup must NOT leak into day 1's bucket (segmentation correctness).
    expect(day1.beats.some((b) => /broke up/i.test(b.text))).toBe(false);

    expect(day2.reconstructed).toBe(true);
    expect(day2.beats.some((b) => /broke up/i.test(b.text) && b.tone === 'bad')).toBe(true);

    // The in-progress day (3) has no record yet.
    expect(byDay.get(3)!.record).toBeNull();
  });

  it('is idempotent and leaves live records untouched', async () => {
    const a = makeWorld('Alpha');
    setAdapterOverride(recapAdapter());
    getWorldState(a.world.id);
    recordEvent('milestone_reached', { characterId: a.character.id, label: 'First kiss' });
    await advanceDay(a.world.id); // ends day 1 (live record), now on day 2

    getWorldCalendar(a.world.id); // would backfill, but day 1 already has a live record
    const rec = dayRecordsRepo.get(a.world.id, 1);
    expect(rec!.reconstructed).toBe(false); // not overwritten by a reconstruction
    expect(rec!.headline).toBe('A lovely day');
  });
});

describe('day records — per-world isolation', () => {
  it("one world's calendar never includes another world's beats", async () => {
    const a = makeWorld('Alpha');
    const b = makeWorld('Beta');
    setAdapterOverride(recapAdapter());

    getWorldState(a.world.id);
    getWorldState(b.world.id);
    recordEvent('milestone_reached', { characterId: a.character.id, label: 'Alpha milestone' });
    recordEvent('breakup', { characterId: b.character.id });

    await advanceDay(a.world.id);
    await advanceDay(b.world.id);
    dropDayRecords(a.world.id);
    dropDayRecords(b.world.id);

    const calA = getWorldCalendar(a.world.id);
    const beatsA = calA.entries.flatMap((e) => e.record?.beats ?? []);
    expect(beatsA.some((x) => /Alpha person/i.test(x.text))).toBe(true);
    expect(beatsA.some((x) => /Beta person/i.test(x.text))).toBe(false);
  });
});

describe('day records — export is self-contained', () => {
  it('backfills missing completed days before export so the bundle carries them', async () => {
    const a = makeWorld('Alpha');
    setAdapterOverride(recapAdapter());
    getWorldState(a.world.id);
    recordEvent('milestone_reached', { characterId: a.character.id, label: 'First kiss' });
    await advanceDay(a.world.id); // ends day 1, now on day 2

    // Simulate a save whose live record never persisted (best-effort write failed,
    // or it predates the feature) — export must still include day 1.
    dropDayRecords(a.world.id);
    const bundle = exportAll();
    const day1 = bundle.dayRecords.find((r) => r.worldId === a.world.id && r.day === 1);
    expect(day1).toBeTruthy();
    expect(day1!.beats.some((b) => /milestone/i.test(b.text))).toBe(true);
  });
});

describe('day records — calendar shape', () => {
  it('returns weather for every day and covers the whole current season', async () => {
    const a = makeWorld('Alpha');
    getWorldState(a.world.id);
    await advanceDay(a.world.id); // currentDay = 2

    const cal = getWorldCalendar(a.world.id);
    expect(cal.entries).toHaveLength(28); // ceil(2/28)*28 = a full first season
    expect(cal.entries.every((e) => e.weather.icon.length > 0 && e.weather.label.length > 0)).toBe(true);
    // Future days carry weather (a forecast) but no record yet.
    expect(cal.entries.find((e) => e.day === 10)!.record).toBeNull();
  });
});
