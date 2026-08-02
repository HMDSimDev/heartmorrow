import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationSessionSchema, MessageSchema, DEFAULT_PLAYER_ID } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { emailsRepo, messagesRepo, sessionsRepo } from '../db/repositories';
import { createCharacter } from './character-service';
import { getRelationship } from './relationship-service';
import { setRelationshipFlag } from './stat-service';
import { isCharacterAvailable } from './availability-service';
import { absenceOn, generatePostcardsForDay, neutralizeAbsenceReason } from './postcard-service';
import { newId } from '../lib/ids';

/** Make hasDated() true (a real, ended date with a player turn). */
function markDated(characterId: string): void {
  const now = Date.now();
  const s = sessionsRepo.insert(
    ConversationSessionSchema.parse({
      id: newId('sess'),
      characterId,
      locationId: null,
      mode: 'date',
      summary: '',
      ended: true,
      createdAt: now,
      updatedAt: now,
    }),
  );
  messagesRepo.insert(
    MessageSchema.parse({ id: newId('msg'), sessionId: s.id, role: 'player', text: 'hi', metadata: {}, createdAt: now }),
  );
}

/** The availability hash is deterministic — scan for a real 2-day absence. */
function findTwoDayAbsence(worldId: string, characterId: string): number {
  for (let d = 2; d < 500; d += 1) {
    if (!isCharacterAvailable(worldId, d, characterId) && !isCharacterAvailable(worldId, d - 1, characterId)) return d;
  }
  throw new Error('No 2-day absence found in 500 days.');
}

const postcards = (worldId: string) =>
  emailsRepo.listDeliveredByPlayerAndWorld(DEFAULT_PLAYER_ID, worldId).filter((e) => e.kind === 'postcard');

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('absenceOn (pure absence math)', () => {
  const busyOn = (days: number[]) => (d: number) => days.includes(d);

  it('null when they are around today', () => {
    expect(absenceOn(busyOn([3, 4]), 5)).toBeNull();
  });

  it('measures the unbroken streak and finds the return day', () => {
    expect(absenceOn(busyOn([4, 5, 6]), 6)).toEqual({ since: 4, length: 3, returnDay: 7 });
    expect(absenceOn(busyOn([4, 5, 6]), 4)).toEqual({ since: 4, length: 1, returnDay: 7 });
  });

  it('an earlier separate absence does not extend the current streak', () => {
    expect(absenceOn(busyOn([1, 2, 5, 6]), 6)).toEqual({ since: 5, length: 2, returnDay: 7 });
  });

  it('a return beyond the scan window reads as unknown', () => {
    const always = () => true;
    const a = absenceOn(always, 10, { lookback: 5, scanAhead: 3 });
    expect(a?.returnDay).toBeNull();
    expect(a?.length).toBe(6); // bounded by the lookback backstop
  });
});

describe('neutralizeAbsenceReason (prompt-poison guard)', () => {
  it('drops day-scoped reasons that would contradict the computed return day', () => {
    expect(neutralizeAbsenceReason('is out of town until tomorrow')).toBeNull();
    expect(neutralizeAbsenceReason('has a packed schedule today')).toBeNull();
    expect(neutralizeAbsenceReason('is tied up with family business')).toBe('is tied up with family business');
    expect(neutralizeAbsenceReason(null)).toBeNull();
  });
});

describe('generatePostcardsForDay', () => {
  it('sends ONE postcard per absence, idempotently, with the character as sender', async () => {
    const { world, character } = seedWorldAndCharacter();
    // A second character keeps the availability guard from force-freeing the first.
    createCharacter({ worldId: world.id, name: 'Second Person', age: 30 });
    markDated(character.id);
    const day = findTwoDayAbsence(world.id, character.id);
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ body: 'Wish you were here. The sea is loud.' })]));

    await generatePostcardsForDay(world.id, day);
    let cards = postcards(world.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.senderName).toBe(character.name);
    expect(cards[0]!.kind).toBe('postcard');
    expect(cards[0]!.body).toContain('The sea is loud');
    expect(getRelationship(character.id).flags['postcard:sentSince']).toBe(day - 1);

    await generatePostcardsForDay(world.id, day); // re-fire (dev route / overlap)
    cards = postcards(world.id);
    expect(cards).toHaveLength(1); // still one per absence
  });

  it('falls back to a templated card when the model is unreachable', async () => {
    const { world, character } = seedWorldAndCharacter();
    createCharacter({ worldId: world.id, name: 'Second Person', age: 30 });
    markDated(character.id);
    const day = findTwoDayAbsence(world.id, character.id);
    setAdapterOverride(new ScriptedAdapter(['not json at all']));

    await generatePostcardsForDay(world.id, day);
    const cards = postcards(world.id);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.body).toContain('Away for a stretch');
  });

  it('sends nothing for someone the player has not dated, and nothing after a breakup', async () => {
    const { world, character } = seedWorldAndCharacter();
    createCharacter({ worldId: world.id, name: 'Second Person', age: 30 });
    const day = findTwoDayAbsence(world.id, character.id);
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ body: 'hello' })]));

    await generatePostcardsForDay(world.id, day); // never dated → silence
    expect(postcards(world.id)).toHaveLength(0);

    markDated(character.id);
    setRelationshipFlag(character.id, 'state:brokenUp', true, { source: 'test' });
    await generatePostcardsForDay(world.id, day); // broken up → a quiet absence
    expect(postcards(world.id)).toHaveLength(0);
  });
});
