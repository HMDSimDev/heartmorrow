import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { sessionsRepo, worldStatesRepo } from '../db/repositories';
import { createCharacter } from './character-service';
import { createSession, addPlayerMessage, endSession } from './conversation-service';
import { getRelationship } from './relationship-service';
import { ensureWorldState } from './world-clock-service';
import { getCharacterAvailability } from './availability-service';

/**
 * Advance the world clock to a day the given character is available. Availability
 * is a deterministic hash of (world, day, character), and the world guard only
 * frees SOME character — with more than one in the world the one we want to date
 * first can roll "busy", which would fail the availability gate before the guard
 * under test is ever reached. Randomized ids make that roll vary run-to-run.
 */
function advanceToAvailableDay(worldId: string, characterId: string): void {
  const state = ensureWorldState(worldId);
  for (let offset = 0; offset < 60; offset += 1) {
    const day = state.day + offset;
    if (getCharacterAvailability(worldId, day, characterId).available) {
      if (day !== state.day) worldStatesRepo.update({ ...state, day, updatedAt: Date.now() });
      return;
    }
  }
  throw new Error(`Could not find an available test day for ${characterId}.`);
}

const evalReply = (deltas: object) =>
  new ScriptedAdapter([
    JSON.stringify({ mood: 'warm', expression: 'smiling', relationshipDeltas: deltas, memoryCandidates: [], summaryLine: 'Nice.' }),
  ]);

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('session end concurrency guard', () => {
  it('two concurrent endSession calls evaluate exactly once (no double-applied deltas)', async () => {
    const { character } = seedWorldAndCharacter();
    // chat mode isolates the evaluation delta from weather/venue/rapport effects.
    const session = createSession({ characterId: character.id, mode: 'chat', locationId: null });
    addPlayerMessage(session.id, 'That was a good talk.');
    const before = getRelationship(character.id).affection;
    setAdapterOverride(evalReply({ affection: 4 }));

    const results = await Promise.allSettled([endSession(session.id), endSession(session.id)]);

    // Neither call throws — the loser returns evaluated:false ("already ended").
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof endSession>>>).value);
    expect(values.filter((v) => v.evaluated)).toHaveLength(1);

    // The evaluation delta landed exactly ONCE.
    expect(getRelationship(character.id).affection).toBe(before + 4);
    expect(sessionsRepo.get(session.id)?.ended).toBe(true);
  });
});

describe('one live date per world', () => {
  it('refuses a second date while one is already open (same character)', () => {
    const { character } = seedWorldAndCharacter();
    createSession({ characterId: character.id, mode: 'date', locationId: null });
    expect(() => createSession({ characterId: character.id, mode: 'date', locationId: null })).toThrow(
      /already on a date/i,
    );
  });

  it('refuses a second date with a DIFFERENT character in the same world', () => {
    const { world, character } = seedWorldAndCharacter();
    const other = createCharacter({
      worldId: world.id,
      name: 'Second Character',
      age: 26,
      datingStats: { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 },
    });
    // The first date must actually open, so land on a day the first character is
    // free — otherwise the availability gate fires before the open-date guard we're
    // asserting on (the second character's roll is irrelevant: the open-date check
    // short-circuits before its availability is ever consulted).
    advanceToAvailableDay(world.id, character.id);
    createSession({ characterId: character.id, mode: 'date', locationId: null });
    expect(() => createSession({ characterId: other.id, mode: 'date', locationId: null })).toThrow(
      /already on a date/i,
    );
  });

  it('allows a new date once the open one has ended', async () => {
    const { character } = seedWorldAndCharacter();
    const first = createSession({ characterId: character.id, mode: 'date', locationId: null });
    // An unspoken date is discarded by endSession (no player turn), clearing the world.
    await endSession(first.id);
    expect(() => createSession({ characterId: character.id, mode: 'date', locationId: null })).not.toThrow();
  });

  it('never blocks a plain chat, even with a date open', () => {
    const { character } = seedWorldAndCharacter();
    createSession({ characterId: character.id, mode: 'date', locationId: null });
    expect(() => createSession({ characterId: character.id, mode: 'chat', locationId: null })).not.toThrow();
  });
});
