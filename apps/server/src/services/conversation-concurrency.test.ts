import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { sessionsRepo } from '../db/repositories';
import { createCharacter } from './character-service';
import { createSession, addPlayerMessage, endSession } from './conversation-service';
import { getRelationship } from './relationship-service';

const evalReply = (deltas: object) =>
  new ScriptedAdapter([
    JSON.stringify({ mood: 'warm', expression: 'smiling', relationshipDeltas: deltas, memoryCandidates: [], summaryLine: 'Nice.' }),
  ]);

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('session end concurrency guard', () => {
  it('sessionsRepo.claimEnd is atomic: the first caller wins, the rest are no-ops', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });

    expect(sessionsRepo.claimEnd(session.id)).toBe(true); // first claim flips ended 0->1
    expect(sessionsRepo.claimEnd(session.id)).toBe(false); // already ended → no-op
    expect(sessionsRepo.get(session.id)?.ended).toBe(true);
  });

  it('claimEnd on a missing session is a no-op (false)', () => {
    expect(sessionsRepo.claimEnd('sess_does_not_exist')).toBe(false);
  });

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
