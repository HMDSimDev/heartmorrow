import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ConversationSessionSchema,
  MessageSchema,
  DEFAULT_PLAYER_ID,
  LAST_DATE_FLAG,
  SEASON_LENGTH,
  anniversaryAnchorFlag,
} from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import {
  eventsRepo,
  messagesRepo,
  sessionsRepo,
  textMessagesRepo,
  threadsRepo,
  worldStatesRepo,
} from '../db/repositories';
import { getRelationship } from './relationship-service';
import { applyRelationshipChange, setRelationshipFlag, stampLastDate } from './stat-service';
import { getCharacterAvailability } from './availability-service';
import { ensureWorldState } from './world-clock-service';
import { generateAnniversaryTextsForDay, generateDailyTextsForDay } from './text-generation-service';
import { addPlayerMessage, createSession, endSession } from './conversation-service';
import { attemptDtr } from './dtr-service';
import { getWorldCalendar } from './day-record-service';
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

/** A day (past the first season, so an anchor ≥ 1 fits) the character is free on. */
function availableAnniversaryDay(worldId: string, characterId: string): number {
  for (let day = SEASON_LENGTH + 1; day < SEASON_LENGTH + 61; day += 1) {
    if (getCharacterAvailability(worldId, day, characterId).available) return day;
  }
  throw new Error('No available anniversary day found.');
}

function queuedCharTexts(characterId: string) {
  const thread = threadsRepo.getByCharacter(characterId, DEFAULT_PLAYER_ID);
  if (!thread) return [];
  return textMessagesRepo.listAllByThread(thread.id).filter((m) => m.sender === 'character');
}

const beatReply = (body: string) => new ScriptedAdapter([JSON.stringify({ body })]);
const evalReply = () =>
  new ScriptedAdapter([
    JSON.stringify({ mood: 'warm', expression: 'smiling', relationshipDeltas: {}, memoryCandidates: [], summaryLine: 'Nice.' }),
  ]);

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('anniversary anchors', () => {
  it('stampLastDate anchors the FIRST concluded date once, and never moves it', () => {
    const { character } = seedWorldAndCharacter();
    stampLastDate(character.id, 4);
    expect(getRelationship(character.id).flags[anniversaryAnchorFlag('firstDate')]).toBe(4);
    stampLastDate(character.id, 9);
    expect(getRelationship(character.id).flags[anniversaryAnchorFlag('firstDate')]).toBe(4);
  });

  it('a legacy save (lastDate already stamped, no anchor) is never retro-anchored', () => {
    const { character } = seedWorldAndCharacter();
    setRelationshipFlag(character.id, LAST_DATE_FLAG, 3, { source: 'test' }); // pre-feature shape
    stampLastDate(character.id, 9);
    expect(getRelationship(character.id).flags[anniversaryAnchorFlag('firstDate')]).toBeUndefined();
  });

  it('a DTR acceptance anchors the commitment anniversary', async () => {
    const { character } = seedWorldAndCharacter();
    applyRelationshipChange(
      character.id,
      { affection: 45, trust: 45, chemistry: 45, comfort: 45, respect: 45 },
      { source: 'test' },
    );
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'Be mine?');
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ decision: 'accept', line: 'Yes!', reason: 'ready' })]));

    const res = await attemptDtr(session.id);
    expect(res.decision).toBe('accept');
    expect(getRelationship(character.id).flags[anniversaryAnchorFlag('dating')]).toBe(1);
  });
});

describe('anniversary remembrance texts', () => {
  it('queues ONE morning text on the day, idempotently, and the daily pass defers to it', async () => {
    const { world, character } = seedWorldAndCharacter();
    markDated(character.id);
    const day = availableAnniversaryDay(world.id, character.id);
    setRelationshipFlag(character.id, anniversaryAnchorFlag('firstDate'), day - SEASON_LENGTH, { source: 'test' });
    setAdapterOverride(beatReply('a whole season since the pier. still my favorite night.'));

    await generateAnniversaryTextsForDay(world.id, day);
    let texts = queuedCharTexts(character.id);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.scheduledPhase).toBe('morning');
    expect(texts[0]!.body).toContain('favorite night');

    await generateAnniversaryTextsForDay(world.id, day); // re-fire (dev route / overlap)
    expect(queuedCharTexts(character.id)).toHaveLength(1);

    // The daily cadence pass shares the one-text-per-day slot and defers.
    await generateDailyTextsForDay(world.id, day, DEFAULT_PLAYER_ID, () => 0); // rng 0 → cadence roll passes
    texts = queuedCharTexts(character.id);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.body).toContain('favorite night');
  });

  it('falls back to a TEMPLATED line when the model is unreachable', async () => {
    const { world, character } = seedWorldAndCharacter();
    markDated(character.id);
    const day = availableAnniversaryDay(world.id, character.id);
    setRelationshipFlag(character.id, anniversaryAnchorFlag('firstDate'), day - SEASON_LENGTH, { source: 'test' });
    setAdapterOverride(new ScriptedAdapter(['not json at all']));

    await generateAnniversaryTextsForDay(world.id, day);
    const texts = queuedCharTexts(character.id);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.body).toContain('a whole season since our first date');
  });

  it('a pending relationship beat (crisis) outranks the celebration', async () => {
    const { world, character } = seedWorldAndCharacter();
    markDated(character.id);
    const day = availableAnniversaryDay(world.id, character.id);
    setRelationshipFlag(character.id, anniversaryAnchorFlag('firstDate'), day - SEASON_LENGTH, { source: 'test' });
    setRelationshipFlag(character.id, 'beat:pending', 'rocks', { source: 'test' });
    setAdapterOverride(beatReply('should not be sent'));

    await generateAnniversaryTextsForDay(world.id, day);
    expect(queuedCharTexts(character.id)).toHaveLength(0);
  });

  it('a broken-up bond celebrates nothing', async () => {
    const { world, character } = seedWorldAndCharacter();
    markDated(character.id);
    const day = availableAnniversaryDay(world.id, character.id);
    setRelationshipFlag(character.id, anniversaryAnchorFlag('firstDate'), day - SEASON_LENGTH, { source: 'test' });
    setRelationshipFlag(character.id, 'state:brokenUp', true, { source: 'test' });
    setAdapterOverride(beatReply('should not be sent'));

    await generateAnniversaryTextsForDay(world.id, day);
    expect(queuedCharTexts(character.id)).toHaveLength(0);
  });
});

describe('anniversary date bonus', () => {
  it('a date concluded ON the day records the anniversary_date event (and off-days do not)', async () => {
    const { world, character } = seedWorldAndCharacter();
    const day = availableAnniversaryDay(world.id, character.id);
    worldStatesRepo.update({ ...ensureWorldState(world.id), day, updatedAt: Date.now() });
    setRelationshipFlag(character.id, anniversaryAnchorFlag('firstDate'), day - SEASON_LENGTH, { source: 'test' });

    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'Happy anniversary to us.');
    setAdapterOverride(evalReply());
    const res = await endSession(session.id);
    expect(res.evaluated).toBe(true);

    const events = eventsRepo.list(100).filter((e) => e.type === 'anniversary_date');
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ characterId: character.id, day, kind: 'firstDate', seasons: 1 });
  });

  it('GRADED: a cohabiting anniversary applies the biggest bonus, a first date the smallest', async () => {
    const { world, character } = seedWorldAndCharacter();
    applyRelationshipChange(
      character.id,
      { affection: 60, trust: 60, chemistry: 60, comfort: 60, respect: 60 },
      { source: 'test' },
    );
    setRelationshipFlag(character.id, 'status', 'cohabiting', { source: 'test' });
    const day = availableAnniversaryDay(world.id, character.id);
    worldStatesRepo.update({ ...ensureWorldState(world.id), day, updatedAt: Date.now() });
    setRelationshipFlag(character.id, anniversaryAnchorFlag('cohabiting'), day - SEASON_LENGTH, { source: 'test' });

    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'A season in our place already.');
    setAdapterOverride(evalReply());
    await endSession(session.id);

    const bonus = eventsRepo
      .list(200)
      .find((e) => e.type === 'relationship_change' && (e.payload as Record<string, unknown>).source === 'anniversary');
    expect(bonus).toBeTruthy();
    // The cohabiting tier (see shared ANNIVERSARY_DATE_BONUS), not the flat +2/+1.
    expect((bonus!.payload as { deltas: Record<string, number> }).deltas).toEqual({ affection: 4, comfort: 2 });
    expect(
      eventsRepo.list(200).some((e) => e.type === 'anniversary_date' && (e.payload as Record<string, unknown>).kind === 'cohabiting'),
    ).toBe(true);
  });
});

describe('anniversary calendar surfacing', () => {
  it('marks today/future anniversaries in the almanac, never past days', () => {
    const { world, character } = seedWorldAndCharacter();
    // Season 2 (day 30) so an anchor of day 2 fits inside the rendered grid.
    worldStatesRepo.update({ ...ensureWorldState(world.id), day: 30, updatedAt: Date.now() });
    setRelationshipFlag(character.id, anniversaryAnchorFlag('firstDate'), 2, { source: 'test' });

    const entry = getWorldCalendar(world.id).entries.find((e) => e.day === 2 + SEASON_LENGTH)!;
    expect(entry.anniversaries).toEqual([
      { characterId: character.id, characterName: character.name, kind: 'firstDate', seasons: 1 },
    ]);

    // Once the day has PASSED it is no longer decorated (no retro-fitting).
    worldStatesRepo.update({ ...ensureWorldState(world.id), day: 40, updatedAt: Date.now() });
    expect(getWorldCalendar(world.id).entries.find((e) => e.day === 2 + SEASON_LENGTH)!.anniversaries).toEqual([]);
  });
});
