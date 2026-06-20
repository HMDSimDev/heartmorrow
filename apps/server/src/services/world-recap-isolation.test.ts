import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { createWorld } from './world-service';
import { createCharacter } from './character-service';
import { recordEvent } from './event-service';
import { advanceDay, getWorldState } from './world-clock-service';
import { eventsRepo } from '../db/repositories';
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

describe('game events are world-stamped', () => {
  it('stamps world_id derived from the payload character, and scopes reads to one world', () => {
    const a = makeWorld('Alpha');
    const b = makeWorld('Beta');

    recordEvent('session_eval', { characterId: a.character.id, summaryLine: 'alpha date' });
    recordEvent('session_eval', { characterId: b.character.id, summaryLine: 'beta date' });
    // A genuinely world-less event resolves to null and belongs to no world's reads.
    recordEvent('data_imported', {});

    const aEvents = eventsRepo.listSinceByWorld(a.world.id, 0);
    expect(aEvents.every((e) => e.worldId === a.world.id)).toBe(true);
    expect(aEvents.some((e) => e.payload.summaryLine === 'alpha date')).toBe(true);
    expect(aEvents.some((e) => e.payload.summaryLine === 'beta date')).toBe(false);

    // The unscoped read still sees everything (debug/export), including the null-world row.
    expect(eventsRepo.list(100).some((e) => e.type === 'data_imported' && e.worldId === null)).toBe(true);
  });

  it('prefers an explicit payload.worldId over the character-derived world', () => {
    const a = makeWorld('Alpha');
    const b = makeWorld('Beta');
    // Pair event names a character from world A but is explicitly tagged to world B.
    recordEvent('npc_meeting', { worldId: b.world.id, aId: a.character.id, bId: b.character.id });
    expect(eventsRepo.listSinceByWorld(b.world.id, 0).some((e) => e.type === 'npc_meeting')).toBe(true);
    expect(eventsRepo.listSinceByWorld(a.world.id, 0).some((e) => e.type === 'npc_meeting')).toBe(false);
  });
});

describe('day recap is isolated to the active world', () => {
  it("does not pull another world's events into the ending day's recap", async () => {
    const a = makeWorld('Alpha');
    const b = makeWorld('Beta');
    // Materialize world A's clock first so its day window (dayStartedAt) is open…
    getWorldState(a.world.id);
    // …then a recap-driving event happens in world B within that same real-time window.
    recordEvent('session_eval', { characterId: b.character.id, mood: 'happy', summaryLine: 'beta had a great date' });

    // No adapter configured: a recap WITH meaningful events would attempt the LLM and
    // fail (recapError set, recap null). A recap with NO events returns the canned
    // "quiet day". So a quiet recap here proves world B's event never leaked into A.
    const sleep = await advanceDay(a.world.id);
    expect(sleep.recapError).toBeNull();
    expect(sleep.recap?.headline).toMatch(/quiet/i);
  });

  it("does narrate the active world's own events (positive control)", async () => {
    const a = makeWorld('Alpha');
    setAdapterOverride(
      new ScriptedAdapter([JSON.stringify({ headline: 'A lovely day', narrative: 'It was good.', highlights: [] })]),
    );
    getWorldState(a.world.id);
    recordEvent('session_eval', { characterId: a.character.id, mood: 'happy', summaryLine: 'alpha date' });

    const sleep = await advanceDay(a.world.id);
    expect(sleep.recapError).toBeNull();
    expect(sleep.recap?.headline).toBe('A lovely day');
  });
});
