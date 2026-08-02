import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { sessionsRepo, worldStatesRepo } from '../db/repositories';
import { createCharacter } from './character-service';
import {
  addPlayerMessage,
  assertNoActiveDate,
  createSession,
  endSession,
  getPendingDateResult,
  markDateResultSeen,
} from './conversation-service';
import { getRelationship } from './relationship-service';
import { ensureWorldState } from './world-clock-service';
import { getCharacterAvailability } from './availability-service';
import { performActivity } from './activity-service';
import { startMinigame } from './minigame-service';
import { beginWorldAdvance, endWorldAdvance } from '../lib/world-transition';
import { buildApp } from '../app';

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
  it('refuses a date while the world day is rolling over', () => {
    const { world, character } = seedWorldAndCharacter();
    expect(beginWorldAdvance(world.id)).toBe(true);
    try {
      expect(() => createSession({ characterId: character.id, mode: 'date', locationId: null })).toThrow(
        /day is turning over/i,
      );
      // Plain chats do not spend a day action and remain available.
      expect(() => createSession({ characterId: character.id, mode: 'chat', locationId: null })).not.toThrow();
    } finally {
      endWorldAdvance(world.id);
    }
  });

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

describe('a live date locks day-spending actions (server-authoritative)', () => {
  it('assertNoActiveDate throws, naming the date partner', () => {
    const { world, character } = seedWorldAndCharacter();
    expect(() => assertNoActiveDate(world.id)).not.toThrow();
    createSession({ characterId: character.id, mode: 'date', locationId: null });
    expect(() => assertNoActiveDate(world.id)).toThrow(new RegExp(character.name.split(' ')[0]!));
  });

  it('refuses a work shift while a date is open', () => {
    const { world, character } = seedWorldAndCharacter();
    createSession({ characterId: character.id, mode: 'date', locationId: null });
    expect(() => performActivity({ activityId: 'work_shift', worldId: world.id, characterId: null })).toThrow(
      /on a date/i,
    );
  });

  it('refuses a world-bound minigame start while a date is open', async () => {
    const { character } = seedWorldAndCharacter();
    createSession({ characterId: character.id, mode: 'date', locationId: null });
    await expect(
      startMinigame({ minigameId: 'memory_match', characterId: character.id, worldId: null }),
    ).rejects.toThrow(/on a date/i);
  });

  it('a plain chat never locks the day', () => {
    const { world, character } = seedWorldAndCharacter();
    createSession({ characterId: character.id, mode: 'chat', locationId: null });
    expect(() => assertNoActiveDate(world.id)).not.toThrow();
  });
});

describe('end-of-date report persistence (replay after a lost response)', () => {
  it('returns the winning durable report to a duplicate end request', async () => {
    const { world, character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'Tonight was lovely.');
    setAdapterOverride(evalReply({ affection: 2 }));

    const [first, duplicate] = await Promise.all([endSession(session.id), endSession(session.id)]);

    expect(first.evaluated).toBe(true);
    expect(duplicate).toEqual(first);
    expect(getPendingDateResult(world.id)).toEqual(first);
  });

  it('persists the report and retires it on DELIVERY — a replay can never haunt later visits', async () => {
    const { world, character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'Tonight was lovely.');
    setAdapterOverride(evalReply({ affection: 2 }));

    expect(getPendingDateResult(world.id)).toBeNull();
    const res = await endSession(session.id);
    expect(res.evaluated).toBe(true);

    // The report survives independently of the HTTP response that carried it…
    const pending = getPendingDateResult(world.id);
    expect(pending?.session.id).toBe(session.id);
    expect(pending?.mood).toBe('warm');
    expect(pending?.summaryLine).toBe('Nice.');

    // …and that one delivery retired it — no ack round-trip required, so a
    // player who leaves the recap via nav never sees it replayed days later.
    expect(getPendingDateResult(world.id)).toBeNull();
  });

  it('the live-path ack retires a report that was never replayed', async () => {
    const { world, character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'Tonight was lovely.');
    setAdapterOverride(evalReply({ affection: 2 }));
    await endSession(session.id);

    markDateResultSeen(session.id); // the client displayed the recap live
    expect(getPendingDateResult(world.id)).toBeNull();
  });

  it('a duplicate end request returns the full report even after delivery retired it', async () => {
    const { world, character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'Tonight was lovely.');
    setAdapterOverride(evalReply({ affection: 2 }));
    const first = await endSession(session.id);

    expect(getPendingDateResult(world.id)?.session.id).toBe(session.id); // delivery retires it
    // The durable report ignores seen-state for duplicate/retried END requests —
    // otherwise a retry after the replay would get a synthetic "already ended".
    const duplicate = await endSession(session.id);
    expect(duplicate).toEqual(first);
  });

  it('persists nothing for a plain chat', async () => {
    const { world, character } = seedWorldAndCharacter();
    const chat = createSession({ characterId: character.id, mode: 'chat', locationId: null });
    addPlayerMessage(chat.id, 'hey');
    setAdapterOverride(evalReply({}));
    await endSession(chat.id);
    expect(getPendingDateResult(world.id)).toBeNull();
  });

  it('persists nothing when the evaluator fails and the date stays open', async () => {
    const { world, character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'Tonight was lovely.');
    setAdapterOverride(new ScriptedAdapter([])); // the required eval call fails

    const res = await endSession(session.id);
    expect(res.evaluated).toBe(false);
    expect(sessionsRepo.get(session.id)?.ended).toBe(false); // still re-endable
    expect(getPendingDateResult(world.id)).toBeNull();
  });
});

describe('duplicate Sleep requests (route-level)', () => {
  it('a concurrent duplicate queues behind the rollover and no-ops instead of erroring', async () => {
    const app = await buildApp({ logger: false });
    try {
      const { world } = seedWorldAndCharacter();
      const day = ensureWorldState(world.id).day;
      // Two tabs click Sleep at once. The loser must get the clean advanced:false
      // no-op `expectedDay` exists for — not a 400 from the rollover claim.
      const [a, b] = await Promise.all([
        app.inject({ method: 'POST', url: `/api/worlds/${world.id}/sleep`, payload: { expectedDay: day } }),
        app.inject({ method: 'POST', url: `/api/worlds/${world.id}/sleep`, payload: { expectedDay: day } }),
      ]);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      const advanced = [a.json(), b.json()].filter((r: { advanced: boolean }) => r.advanced);
      expect(advanced).toHaveLength(1);
      expect(ensureWorldState(world.id).day).toBe(day + 1); // exactly ONE day passed
    } finally {
      await app.close();
    }
  });

  it('a BODILESS Sleep advances — doc body schemas must never validate at runtime', async () => {
    // Regression: docSchema's body annotation fed Fastify's AJV, and a POST with
    // no body (no content-type → request.body undefined) failed with
    // "must be object" even though every field of the sleep body is optional.
    const app = await buildApp({ logger: false });
    try {
      const { world } = seedWorldAndCharacter();
      const day = ensureWorldState(world.id).day;
      const res = await app.inject({ method: 'POST', url: `/api/worlds/${world.id}/sleep` });
      expect(res.statusCode).toBe(200);
      expect(res.json().advanced).toBe(true);
      expect(ensureWorldState(world.id).day).toBe(day + 1);
    } finally {
      await app.close();
    }
  });

  it('a stale duplicate stays a no-op even when a date opened on the new day', async () => {
    const app = await buildApp({ logger: false });
    try {
      const { world, character } = seedWorldAndCharacter();
      const day = ensureWorldState(world.id).day;
      const first = await app.inject({ method: 'POST', url: `/api/worlds/${world.id}/sleep`, payload: { expectedDay: day } });
      expect(first.json().advanced).toBe(true);

      // A date opens after the rollover…
      advanceToAvailableDay(world.id, character.id);
      createSession({ characterId: character.id, mode: 'date', locationId: null });

      // …and the old day's straggler retry must read as the no-op it is, not a
      // spurious "you're on a date" error (staleness is checked before the gate).
      const dup = await app.inject({ method: 'POST', url: `/api/worlds/${world.id}/sleep`, payload: { expectedDay: day } });
      expect(dup.statusCode).toBe(200);
      expect(dup.json().advanced).toBe(false);
    } finally {
      await app.close();
    }
  });
});
