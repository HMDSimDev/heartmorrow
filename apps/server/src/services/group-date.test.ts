import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_DATING_STATS, isBrokenUp, type ShopItemCreate } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, seedGroupWorld, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import {
  addPlayerMessage,
  buildDialogueRequest,
  confirmPlayerBreakup,
  createSession,
  endSession,
  estimateNextTurnContext,
  generateReply,
  getRecordedGroupSpeakerIds,
  getActiveDateForWorld,
  getSessionWithMessages,
  judgeTurn,
  maybeLeaveForLostInterest,
  openConversation,
  persistStreamedReply,
  recordTurnReaction,
  recordGroupSpeakerPlan,
  attemptPlayerFarewell,
} from './conversation-service';
import { requireFeature, featureEnabled } from './world-feature-service';
import { createWorld, updateWorld } from './world-service';
import { createCharacter, updateCharacter } from './character-service';
import { getWorldAvailability } from './availability-service';
import { ensureWorldState } from './world-clock-service';
import { exportAll, importAll } from './data-service';
import { sessionParticipantsRepo, sessionsRepo, worldStatesRepo } from '../db/repositories';
import { buildApp } from '../app';
import { getRelationship } from './relationship-service';
import { applyRelationshipChange, setRelationshipFlag } from './stat-service';
import { attemptDtr } from './dtr-service';
import { giveGiftOnDate } from './gift-service';
import { createShopItem, grantItem } from './shop-service';
import { listMemories } from './memory-service';
import { playerIdForWorld } from '../lib/ids';
import { updatePlayer } from './player-service';
import { updateLlmSettings } from './settings-service';
import type { ChatRequest, ChatResult, LlmModelInfo } from '../llm/types';

class CapturingScriptedAdapter extends ScriptedAdapter {
  readonly requests: ChatRequest[] = [];

  override async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    return super.chat(req);
  }
}

class ContextReportingAdapter extends ScriptedAdapter {
  override async listModels(): Promise<LlmModelInfo[]> {
    return [{ id: 'test-model', loaded: true, contextLength: 32_000 }];
  }
}

function makeWarm(characterId: string, to = 50): void {
  applyRelationshipChange(
    characterId,
    { affection: to - 5, trust: to - 5, chemistry: to - 5, comfort: to - 5, respect: to - 5 },
    { source: 'test' },
  );
}

function giftItem(name: string): ShopItemCreate {
  return {
    name,
    description: '',
    price: 0,
    category: 'gift',
    rarity: 'common',
    effects: [],
    infiniteStock: true,
    stock: 0,
    assetId: null,
  };
}

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

function setAvailabilityDay(
  worldId: string,
  predicate: (availableIds: Set<string>) => boolean,
): void {
  const state = ensureWorldState(worldId);
  for (let day = 1; day <= 500; day += 1) {
    const availableIds = new Set(
      getWorldAvailability(worldId, day)
        .filter((entry) => entry.available)
        .map((entry) => entry.characterId),
    );
    if (predicate(availableIds)) {
      worldStatesRepo.update({ ...state, day });
      return;
    }
  }
  throw new Error('Could not find a deterministic availability day for this test.');
}

function startGroupDate() {
  const { world, a, b } = seedGroupWorld();
  setAvailabilityDay(world.id, (available) => available.has(a.id) && available.has(b.id));
  const session = createSession({
    characterId: a.id,
    participantIds: [b.id],
    mode: 'date',
    locationId: null,
  });
  return { world, a, b, session };
}

function startGroupHangout() {
  const { world, a, b } = seedGroupWorld();
  setAvailabilityDay(world.id, (available) => available.has(a.id) && available.has(b.id));
  const session = createSession({
    characterId: a.id,
    participantIds: [b.id],
    mode: 'hangout',
    locationId: null,
  });
  return { world, a, b, session };
}

describe('group-date data spine (Phase 0)', () => {
  it('seeds a single seat-0 host participant row for a new date session', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });

    const rows = sessionParticipantsRepo.listBySession(session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: session.id,
      characterId: character.id,
      seat: 0,
      role: 'romance',
      state: 'present',
      rapport: null, // unseeded until the first judged turn
    });
  });

  it('seeds the roster for a plain chat session too (additive, mode-agnostic)', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'chat', locationId: null });
    expect(sessionParticipantsRepo.listBySession(session.id)).toHaveLength(1);
  });

  it('cascade-deletes participant rows when the session is removed', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'chat', locationId: null });
    expect(sessionParticipantsRepo.listBySession(session.id)).toHaveLength(1);

    sessionsRepo.delete(session.id);
    expect(sessionParticipantsRepo.listBySession(session.id)).toHaveLength(0);
  });

  it('setRapport auto-creates a seat-0 row for a session that has none (legacy fallback)', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    sessionParticipantsRepo.deleteBySession(session.id); // simulate a pre-Phase-0 session

    sessionParticipantsRepo.setRapport(session.id, character.id, 73, Date.now());
    const row = sessionParticipantsRepo.get(session.id, character.id);
    expect(row).toMatchObject({ seat: 0, role: 'romance', state: 'present', rapport: 73 });
  });
});

describe('groupDates feature flag (Phase 0)', () => {
  it('defaults to false on a freshly created world', () => {
    const world = createWorld({ name: 'Plain' });
    expect(world.featureFlags.groupDates).toBe(false);
    expect(featureEnabled(world.id, 'groupDates')).toBe(false);
  });

  it('requireFeature throws 403 when off and passes when on', () => {
    const off = createWorld({ name: 'Off' });
    expect(() => requireFeature(off.id, 'groupDates')).toThrow(/group outings are not enabled/i);

    const { world } = seedGroupWorld();
    expect(featureEnabled(world.id, 'groupDates')).toBe(true);
    expect(() => requireFeature(world.id, 'groupDates')).not.toThrow();
  });
});

describe('group-date session roster (Phase 1)', () => {
  it('creates, reads, and resumes an ordered two-person roster', () => {
    const { world, a, b } = seedGroupWorld();
    setAvailabilityDay(world.id, (available) => available.has(a.id) && available.has(b.id));

    const session = createSession({
      characterId: a.id,
      participantIds: [b.id],
      mode: 'date',
      locationId: null,
    });

    expect(sessionParticipantsRepo.listBySession(session.id)).toMatchObject([
      { characterId: a.id, seat: 0, role: 'romance', state: 'present' },
      { characterId: b.id, seat: 1, role: 'romance', state: 'present' },
    ]);
    expect(getSessionWithMessages(session.id).participants).toEqual([
      {
        characterId: a.id, characterName: a.name, seat: 0, role: 'romance', state: 'present',
        rapport: null, vibe: null, expression: null, judged: false,
      },
      {
        characterId: b.id, characterName: b.name, seat: 1, role: 'romance', state: 'present',
        rapport: null, vibe: null, expression: null, judged: false,
      },
    ]);

    const active = getActiveDateForWorld(world.id);
    expect(active?.characterId).toBe(a.id); // legacy singular host remains stable
    expect(active?.participants.map((participant) => participant.characterName)).toEqual([a.name, b.name]);
  });

  it('creates and resumes the same ordered roster for a group hangout', () => {
    const { world, a, b, session } = startGroupHangout();

    expect(session.mode).toBe('hangout');
    expect(sessionParticipantsRepo.listBySession(session.id)).toMatchObject([
      { characterId: a.id, seat: 0, state: 'present', rapport: null },
      { characterId: b.id, seat: 1, state: 'present', rapport: null },
    ]);
    expect(getActiveDateForWorld(world.id)).toMatchObject({
      sessionId: session.id,
      mode: 'hangout',
      rapport: null,
      vibe: null,
    });
  });

  it('keeps solo session reads backward-compatible with a one-person roster', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'chat', locationId: null });

    expect(getSessionWithMessages(session.id).participants).toEqual([
      {
        characterId: character.id,
        characterName: character.name,
        seat: 0,
        role: 'romance',
        state: 'present',
        rapport: null,
        vibe: null,
        expression: null,
        judged: false,
      },
    ]);
  });

  it('requires the world feature flag for an additional attendee', () => {
    const { world, a, b } = seedGroupWorld();
    updateWorld(world.id, { featureFlags: { ...world.featureFlags, groupDates: false } });

    expect(() =>
      createSession({ characterId: a.id, participantIds: [b.id], mode: 'date', locationId: null }),
    ).toThrow(/group outings are not enabled/i);
    expect(sessionsRepo.list()).toHaveLength(0);
  });

  it('rejects duplicate, non-meeting, and cross-world rosters before persistence', () => {
    const { a, b } = seedGroupWorld();
    const { character: outsider } = seedWorldAndCharacter();

    expect(() =>
      createSession({ characterId: a.id, participantIds: [a.id], mode: 'date', locationId: null }),
    ).toThrow(/different character/i);
    expect(() =>
      createSession({ characterId: a.id, participantIds: [b.id], mode: 'chat', locationId: null }),
    ).toThrow(/only on dates and hangouts/i);
    expect(() =>
      createSession({ characterId: a.id, participantIds: [outsider.id], mode: 'date', locationId: null }),
    ).toThrow(/same world/i);
    expect(sessionsRepo.list()).toHaveLength(0);
  });

  it('requires every attendee to be available that day', () => {
    const { world, a, b } = seedGroupWorld();
    setAvailabilityDay(world.id, (available) => available.has(a.id) && !available.has(b.id));

    expect(() =>
      createSession({ characterId: a.id, participantIds: [b.id], mode: 'date', locationId: null }),
    ).toThrow(new RegExp(b.name, 'i'));
    expect(sessionsRepo.list()).toHaveLength(0);
  });

  it('round-trips group rosters through savegame export/import', () => {
    const { world, a, b } = seedGroupWorld();
    setAvailabilityDay(world.id, (available) => available.has(a.id) && available.has(b.id));
    const session = createSession({
      characterId: a.id,
      participantIds: [b.id],
      mode: 'date',
      locationId: null,
    });

    const bundle = exportAll();
    expect(bundle.sessionParticipants.filter((participant) => participant.sessionId === session.id)).toHaveLength(2);

    importAll(bundle);
    expect(sessionParticipantsRepo.listBySession(session.id).map((participant) => participant.characterId)).toEqual([
      a.id,
      b.id,
    ]);
    expect(getSessionWithMessages(session.id).participants.map((participant) => participant.characterName)).toEqual([
      a.name,
      b.name,
    ]);
  });

  it('rejects more than one invitee even for direct service callers', () => {
    const { a, b, world } = seedGroupWorld();
    const c = createCharacter({
      worldId: world.id,
      name: 'Casey',
      age: 30,
      datingStats: DEFAULT_DATING_STATS,
    });

    expect(() =>
      createSession({ characterId: a.id, participantIds: [b.id, c.id], mode: 'date', locationId: null }),
    ).toThrow(/one additional attendee/i);
    expect(sessionsRepo.list()).toHaveLength(0);
  });
});

describe('group-date live turn loop (Phase 2)', () => {
  it('estimates the largest next-reply prompt across everyone still present', async () => {
    const { a, session } = startGroupDate();
    setAdapterOverride(new ContextReportingAdapter(['']));
    const before = await estimateNextTurnContext(session.id);

    expect(before).toMatchObject({
      participantCount: 2,
      method: 'estimated',
      contextWindowTokens: 32_000,
      contextWindowSource: 'model',
    });
    expect(before.estimatedPromptTokens).toBeGreaterThan(0);

    addPlayerMessage(session.id, 'Tell me what both of you think about this place.');
    persistStreamedReply(session.id, `Avery considers the question. ${'A detailed answer. '.repeat(40)}`, a.id);
    const after = await estimateNextTurnContext(session.id);
    expect(after.estimatedPromptTokens).toBeGreaterThan(before.estimatedPromptTokens);
  });

  it('leaves the context window unknown when the adapter does not report one', async () => {
    const { session } = startGroupDate();
    updateLlmSettings({ model: 'model-without-context-metadata' });
    setAdapterOverride(new ScriptedAdapter(['']));

    await expect(estimateNextTurnContext(session.id)).resolves.toMatchObject({
      estimatedPromptTokens: expect.any(Number),
      contextWindowTokens: null,
      contextWindowSource: 'unavailable',
    });
  });

  it('opens with one line from each attendee in seat order', async () => {
    const { a, b, session } = startGroupDate();
    const adapter = new CapturingScriptedAdapter(['Avery breaks the ice.', 'Bo picks up the thread.']);
    setAdapterOverride(adapter);

    await openConversation(session.id);

    expect(getSessionWithMessages(session.id).messages).toMatchObject([
      { role: 'character', characterId: a.id, text: 'Avery breaks the ice.', metadata: { opener: true } },
      { role: 'character', characterId: b.id, text: 'Bo picks up the thread.', metadata: { opener: true } },
    ]);
    expect(adapter.requests[1]?.messages).toContainEqual({
      role: 'system',
      content: '[OTHER ATTENDEE — speaker: Avery; not the player (Player)]\nAvery says: Avery breaks the ice.',
    });
    const secondOpenerDirection = adapter.requests[1]?.messages.at(-1)?.content;
    expect(secondOpenerDirection).toContain('the player is Player, and the player has not spoken yet');
    expect(secondOpenerDirection).toContain("if another attendee says Player's name, they are speaking to the player (Player), not to you");
    expect(secondOpenerDirection).toContain('do not answer their greeting with "you too," "me too," or similar wording');
  });

  it('turns a date with two monogamous partners into an immediate, remembered confrontation', async () => {
    const { a, b, session } = startGroupDate();
    makeWarm(a.id);
    makeWarm(b.id);
    setRelationshipFlag(a.id, 'status', 'dating', { source: 'test' });
    setRelationshipFlag(b.id, 'status', 'dating', { source: 'test' });
    const beforeA = getRelationship(a.id);
    const beforeB = getRelationship(b.id);
    const adapter = new CapturingScriptedAdapter([
      'Are you serious? You brought us both here without telling either of us?',
      'Wait—Avery, you were told this was a date too?',
    ]);
    setAdapterOverride(adapter);

    await openConversation(session.id);

    const afterA = getRelationship(a.id);
    const afterB = getRelationship(b.id);
    for (const [before, after] of [[beforeA, afterA], [beforeB, afterB]] as const) {
      expect(after.affection).toBe(before.affection - 6);
      expect(after.trust).toBe(before.trust - 8);
      expect(after.comfort).toBe(before.comfort - 5);
      expect(after.tension).toBe(before.tension + 10);
      expect(after.flags).toMatchObject({
        'state:jealous': true,
        'state:offended': true,
        'jealousy:groupCollisionSessionId': session.id,
      });
    }
    expect(listMemories(a.id)).toContainEqual(expect.objectContaining({
      text: expect.stringContaining('officially dating both of us'),
      tags: expect.arrayContaining(['jealousy', 'conflict', 'date']),
      sourceMode: 'date',
    }));
    expect(listMemories(b.id)).toContainEqual(expect.objectContaining({
      text: expect.stringContaining('officially dating both of us'),
      tags: expect.arrayContaining(['jealousy', 'conflict', 'date']),
      sourceMode: 'date',
    }));

    const aPrompt = adapter.requests[0]!.messages.map((message) => message.content).join('\n');
    const bPrompt = adapter.requests[1]!.messages.map((message) => message.content).join('\n');
    expect(aPrompt).toContain('MONOGAMOUS GROUP-DATE COLLISION');
    expect(aPrompt).toContain('Bo and Player are also officially dating');
    expect(aPrompt).toContain('Skip the pleasantries');
    expect(bPrompt).toContain('Avery and Player are also officially dating');
    expect(bPrompt).toContain('[OTHER ATTENDEE — speaker: Avery; not the player (Player)]');
    expect(bPrompt).toContain('Avery says: Are you serious?');

    const afterFirstOpen = getRelationship(a.id);
    expect(await openConversation(session.id)).toBeNull();
    expect(getRelationship(a.id)).toEqual(afterFirstOpen);
    expect(listMemories(a.id).filter((memory) => memory.tags.includes('conflict'))).toHaveLength(1);
  });

  it('blows up when a monogamous partner is brought alongside a compatible new romantic prospect', async () => {
    const { a, b, session } = startGroupDate();
    makeWarm(a.id);
    setRelationshipFlag(a.id, 'status', 'dating', { source: 'test' });
    const beforeA = getRelationship(a.id);
    const beforeB = getRelationship(b.id);
    const adapter = new CapturingScriptedAdapter([
      'You are dating me, and you thought bringing someone else as a date was acceptable?',
      'I did not agree to be dragged into this. What were you thinking?',
    ]);
    setAdapterOverride(adapter);

    await openConversation(session.id);

    expect(getRelationship(a.id)).toMatchObject({
      affection: beforeA.affection - 6,
      trust: beforeA.trust - 8,
      comfort: beforeA.comfort - 5,
      tension: beforeA.tension + 10,
      flags: expect.objectContaining({ 'state:jealous': true, 'state:offended': true }),
    });
    expect(getRelationship(b.id)).toMatchObject({
      trust: beforeB.trust - 4,
      comfort: beforeB.comfort - 3,
      respect: Math.max(0, beforeB.respect - 5),
      tension: beforeB.tension + 7,
      flags: expect.objectContaining({ 'state:offended': true }),
    });
    expect(getRelationship(b.id).flags['state:jealous']).toBeUndefined();
    expect(listMemories(a.id)[0]?.text).toContain('as another romantic date while officially dating me');
    expect(listMemories(b.id)[0]?.text).toContain('dragged into their relationship conflict');

    const aPrompt = adapter.requests[0]!.messages.map((message) => message.content).join('\n');
    const bPrompt = adapter.requests[1]!.messages.map((message) => message.content).join('\n');
    expect(aPrompt).toContain('MONOGAMOUS GROUP-DATE COLLISION');
    expect(aPrompt).toContain('Player is also treating this as a romantic date with Bo');
    expect(aPrompt).toContain('date role: a plausible new romantic prospect');
    expect(bPrompt).toContain('CAUGHT IN A GROUP-DATE AMBUSH');
    expect(bPrompt).toContain('brought you here as another date alongside Avery');
  });

  it('keeps a fundamentally orientation-incompatible co-attendee platonic', async () => {
    const { world, a, b, session } = startGroupDate();
    updatePlayer({ gender: 'male', sexuality: 'straight' }, playerIdForWorld(world.id));
    updateCharacter(a.id, { gender: 'female', sexuality: 'straight' });
    updateCharacter(b.id, { gender: 'male', sexuality: 'gay' });
    makeWarm(a.id);
    setRelationshipFlag(a.id, 'status', 'dating', { source: 'test' });
    const beforeA = getRelationship(a.id);
    const beforeB = getRelationship(b.id);
    const adapter = new CapturingScriptedAdapter(['Good to see you both.', 'Glad to hang out.']);
    setAdapterOverride(adapter);

    await openConversation(session.id);

    expect(getRelationship(a.id)).toEqual(beforeA);
    expect(getRelationship(b.id)).toEqual(beforeB);
    const aPrompt = adapter.requests[0]!.messages.map((message) => message.content).join('\n');
    const bPrompt = adapter.requests[1]!.messages.map((message) => message.content).join('\n');
    expect(aPrompt).toContain('fundamentally orientation-incompatible, not romantic');
    expect(aPrompt).not.toContain('MONOGAMOUS GROUP-DATE COLLISION');
    expect(bPrompt).not.toContain('CAUGHT IN A GROUP-DATE AMBUSH');
  });

  it('does not treat two existing partners at a group hangout as a relationship ambush', async () => {
    const { a, b, session } = startGroupHangout();
    makeWarm(a.id);
    makeWarm(b.id);
    setRelationshipFlag(a.id, 'status', 'dating', { source: 'test' });
    setRelationshipFlag(b.id, 'status', 'dating', { source: 'test' });
    const beforeA = getRelationship(a.id);
    const beforeB = getRelationship(b.id);
    const adapter = new CapturingScriptedAdapter(['Avery waves hello.', 'Bo joins the greeting.']);
    setAdapterOverride(adapter);

    await openConversation(session.id);

    expect(getRelationship(a.id)).toEqual(beforeA);
    expect(getRelationship(b.id)).toEqual(beforeB);
    const prompt = adapter.requests[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).not.toContain('MONOGAMOUS GROUP-DATE COLLISION');
    expect(prompt).not.toContain('relationship with Player: officially dating');
  });

  it('treats ambushing an exclusive partner as the more severe committed betrayal', async () => {
    const { a, b, session } = startGroupDate();
    makeWarm(a.id);
    makeWarm(b.id);
    setRelationshipFlag(a.id, 'status', 'exclusive', { source: 'test' });
    setRelationshipFlag(b.id, 'status', 'dating', { source: 'test' });
    const beforeA = getRelationship(a.id);
    const beforeB = getRelationship(b.id);
    setAdapterOverride(new ScriptedAdapter(['Absolutely not.', 'You told her you were exclusive?']));

    await openConversation(session.id);

    expect(getRelationship(a.id)).toMatchObject({
      affection: beforeA.affection - 12,
      trust: beforeA.trust - 15,
      comfort: beforeA.comfort - 8,
      tension: beforeA.tension + 18,
    });
    expect(getRelationship(b.id)).toMatchObject({
      affection: beforeB.affection - 6,
      trust: beforeB.trust - 8,
      comfort: beforeB.comfort - 5,
      tension: beforeB.tension + 10,
    });
    expect(listMemories(a.id)[0]).toMatchObject({ importance: 5 });
    expect(listMemories(b.id)[0]).toMatchObject({ importance: 4 });
  });

  it('opens and replies as a shared hangout, with both attendees hearing the room in order', async () => {
    const { a, b, session } = startGroupHangout();
    const openerAdapter = new CapturingScriptedAdapter(['Avery waves hello.', 'Bo joins the greeting.']);
    setAdapterOverride(openerAdapter);

    await openConversation(session.id);

    expect(getSessionWithMessages(session.id).messages).toMatchObject([
      { role: 'character', characterId: a.id, text: 'Avery waves hello.' },
      { role: 'character', characterId: b.id, text: 'Bo joins the greeting.' },
    ]);
    expect(openerAdapter.requests[0]?.messages.at(-1)?.content).toContain('this group hangout is just beginning');
    expect(openerAdapter.requests[1]?.messages).toContainEqual({
      role: 'system',
      content: '[OTHER ATTENDEE — speaker: Avery; not the player (Player)]\nAvery says: Avery waves hello.',
    });

    addPlayerMessage(session.id, 'What should we all do?');
    const replyAdapter = new ScriptedAdapter(['Avery suggests a walk.', 'Bo agrees and picks a route.']);
    setAdapterOverride(replyAdapter);
    expect(await judgeTurn(session.id, undefined, a.id)).toBeNull();
    expect(await judgeTurn(session.id, undefined, b.id)).toBeNull();
    await generateReply(session.id, a.id);
    await generateReply(session.id, b.id);

    expect(replyAdapter.calls).toBe(2);
    expect(getSessionWithMessages(session.id).messages.slice(-2)).toMatchObject([
      { role: 'character', characterId: a.id, text: 'Avery suggests a walk.' },
      { role: 'character', characterId: b.id, text: 'Bo agrees and picks a route.' },
    ]);
  });

  it('streams both replies in seat order and marks only the final reply complete', async () => {
    const { a, b, session } = startGroupDate();
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({ engagement: 1, expression: 'smiling', note: 'pleasant' }),
        JSON.stringify({ engagement: 2, expression: 'happy', note: 'warm' }),
        JSON.stringify({ speakerSeats: [0, 1], reason: 'Both were asked and have distinct answers.' }),
        'Avery takes the first turn.',
        'Bo follows up.',
      ]),
    );
    const app = await buildApp({ logger: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/conversations/${session.id}/stream`,
        payload: { text: 'How is everyone doing?' },
      });
      expect(response.statusCode).toBe(200);
      const events = response.body
        .trim()
        .split('\n\n')
        .map((block) => {
          const event = block.match(/^event: (.+)$/m)?.[1];
          const raw = block.match(/^data: (.+)$/m)?.[1];
          return { event, data: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
        });
      expect(events.filter((entry) => entry.event === 'speaker').map((entry) => entry.data.characterId)).toEqual([
        a.id,
        b.id,
      ]);
      const done = events.filter((entry) => entry.event === 'done');
      expect(done.map((entry) => (entry.data.message as { characterId: string }).characterId)).toEqual([a.id, b.id]);
      expect(done.map((entry) => entry.data.complete)).toEqual([false, true]);
    } finally {
      await app.close();
    }
  });

  it('uses a context-rich director to let only the addressed attendee speak', async () => {
    const { a, b, session } = startGroupHangout();
    persistStreamedReply(session.id, 'I was thinking we could wander through the market.', a.id);
    persistStreamedReply(session.id, 'As long as nobody rushes me.', b.id);
    applyRelationshipChange(b.id, { tension: 35 }, { source: 'test' });
    setRelationshipFlag(b.id, 'state:jealous', true, { source: 'test' });
    const adapter = new CapturingScriptedAdapter([
      JSON.stringify({ speakerSeats: [1], reason: 'The player directly asked Bo; Avery has no distinct interjection.' }),
      'I would rather find somewhere quiet, honestly.',
    ]);
    setAdapterOverride(adapter);
    const app = await buildApp({ logger: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/conversations/${session.id}/stream`,
        payload: { text: 'Bo, what would you rather do?' },
      });
      expect(response.statusCode).toBe(200);
      const events = response.body
        .trim()
        .split('\n\n')
        .map((block) => {
          const event = block.match(/^event: (.+)$/m)?.[1];
          const raw = block.match(/^data: (.+)$/m)?.[1];
          return { event, data: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
        });

      expect(events.filter((entry) => entry.event === 'speaker').map((entry) => entry.data.characterId)).toEqual([b.id]);
      expect(events.filter((entry) => entry.event === 'done')).toHaveLength(1);
      expect((events.find((entry) => entry.event === 'done')?.data.message as { characterId: string }).characterId).toBe(b.id);
      expect(events.find((entry) => entry.event === 'done')?.data.complete).toBe(true);
      expect(adapter.calls).toBe(2); // one short director call + one spoken reply

      const directorPrompt = adapter.requests[0]!.messages
        .map((message) => (typeof message.content === 'string' ? message.content : ''))
        .join('\n');
      expect(directorPrompt).toContain('Jealous now: YES');
      expect(directorPrompt).toContain('tension level: 35/100');
      expect(directorPrompt).toContain('Avery: I was thinking we could wander through the market.');
      expect(directorPrompt).toContain('Bo: As long as nobody rushes me.');
      expect(directorPrompt).toContain('Player: Bo, what would you rather do?');

      const playerMessage = getSessionWithMessages(session.id).messages.findLast((message) => message.role === 'player')!;
      expect(getRecordedGroupSpeakerIds(playerMessage)).toEqual([b.id]);
    } finally {
      await app.close();
    }
  });

  it('retries only the missing attendee after a partial group turn', async () => {
    const { a, b, session } = startGroupDate();
    addPlayerMessage(session.id, 'Tell me one thing each.');
    persistStreamedReply(session.id, 'Avery already answered.', a.id);
    const adapter = new ScriptedAdapter(['Bo resumes the turn.']);
    setAdapterOverride(adapter);
    const app = await buildApp({ logger: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/conversations/${session.id}/retry-stream`,
      });
      const events = response.body
        .trim()
        .split('\n\n')
        .map((block) => {
          const event = block.match(/^event: (.+)$/m)?.[1];
          const raw = block.match(/^data: (.+)$/m)?.[1];
          return { event, data: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
        });
      const done = events.filter((entry) => entry.event === 'done');
      expect(done.map((entry) => (entry.data.message as { characterId: string }).characterId)).toEqual([a.id, b.id]);
      expect(done.map((entry) => entry.data.complete)).toEqual([false, true]);
      expect(events.filter((entry) => entry.event === 'speaker').map((entry) => entry.data.characterId)).toEqual([b.id]);
      expect(adapter.calls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('preserves a one-speaker director plan when retrying a dropped stream', async () => {
    const { a, b, session } = startGroupDate();
    const playerMessage = addPlayerMessage(session.id, 'Bo, can you finish that thought?');
    recordGroupSpeakerPlan(playerMessage.id, {
      characterIds: [b.id],
      reason: 'Bo was directly addressed.',
      fallback: false,
    });
    const adapter = new ScriptedAdapter(['Bo finishes the thought.']);
    setAdapterOverride(adapter);
    const app = await buildApp({ logger: false });
    try {
      const response = await app.inject({ method: 'POST', url: `/api/conversations/${session.id}/retry-stream` });
      const events = response.body
        .trim()
        .split('\n\n')
        .map((block) => {
          const event = block.match(/^event: (.+)$/m)?.[1];
          const raw = block.match(/^data: (.+)$/m)?.[1];
          return { event, data: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
        });
      expect(events.filter((entry) => entry.event === 'speaker').map((entry) => entry.data.characterId)).toEqual([b.id]);
      expect(events.filter((entry) => entry.event === 'done').map((entry) => (entry.data.message as { characterId: string }).characterId)).toEqual([b.id]);
      expect(adapter.calls).toBe(1);
      expect(getSessionWithMessages(session.id).messages.some((message) => message.role === 'character' && message.characterId === a.id)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('persists speaker identity and gives each attendee an isolated dialogue prompt', async () => {
    const { a, b, session } = startGroupDate();
    addPlayerMessage(session.id, 'What brought both of you out tonight?');
    setAdapterOverride(new ScriptedAdapter(['Avery answers first.', 'Bo answers second.']));

    const aReply = await generateReply(session.id, a.id);
    const bPrompt = buildDialogueRequest(session.id, null, b.id);
    const bSystem = bPrompt[0]!.content;
    expect(bSystem).toContain('You are ONLY Bo');
    expect(bSystem).toContain('Avery');
    expect(bPrompt).toContainEqual({
      role: 'system',
      content: '[OTHER ATTENDEE — speaker: Avery; not the player (Player)]\nAvery says: Avery answers first.',
    });

    const bReply = await generateReply(session.id, b.id);
    expect(aReply.characterId).toBe(a.id);
    expect(bReply.characterId).toBe(b.id);
    expect(getSessionWithMessages(session.id).messages.filter((message) => message.role === 'character')).toMatchObject([
      { characterId: a.id, text: 'Avery answers first.' },
      { characterId: b.id, text: 'Bo answers second.' },
    ]);
  });

  it('judges the same player turn independently for every attendee', async () => {
    const { world, a, b, session } = startGroupDate();
    addPlayerMessage(session.id, 'I remembered what each of you told me.');
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({ engagement: 3, expression: 'excited', note: 'felt seen' }),
        JSON.stringify({ engagement: -2, expression: 'annoyed', note: 'did not land' }),
      ]),
    );

    const aRead = await judgeTurn(session.id, undefined, a.id);
    const bRead = await judgeTurn(session.id, undefined, b.id);
    expect(aRead).toMatchObject({ characterId: a.id, engagement: 3, expression: 'excited' });
    expect(bRead).toMatchObject({ characterId: b.id, engagement: -2, expression: 'annoyed' });
    expect(aRead!.rapport).toBeGreaterThan(bRead!.rapport);

    const active = getActiveDateForWorld(world.id)!;
    expect(active.participants).toMatchObject([
      { characterId: a.id, rapport: aRead!.rapport, expression: 'excited', judged: true },
      { characterId: b.id, rapport: bRead!.rapport, expression: 'annoyed', judged: true },
    ]);
  });

  it('lets one attendee leave without ending the other attendee\'s turn', async () => {
    const { a, b, session } = startGroupDate();
    sessionParticipantsRepo.setRapport(session.id, b.id, 0, Date.now(), true);
    setAdapterOverride(new ScriptedAdapter([`I think I'm going to call it a night.`]));

    const left = await maybeLeaveForLostInterest(session.id, undefined, b.id);
    expect(left).toMatchObject({ characterId: b.id, reason: 'lost_interest' });
    expect(left!.message).toMatchObject({ characterId: b.id, metadata: { left: true } });
    expect(sessionParticipantsRepo.get(session.id, a.id)?.state).toBe('present');
    expect(sessionParticipantsRepo.get(session.id, b.id)?.state).toBe('left_early');
    expect(await maybeLeaveForLostInterest(session.id, undefined, b.id)).toBeNull();
  });
});

describe('group-date outcomes and targeted actions (Phase 3)', () => {
  it('evaluates and persists a separate result for each attendee', async () => {
    const { a, b, session } = startGroupDate();
    makeWarm(a.id);
    makeWarm(b.id);
    const playerLine = addPlayerMessage(session.id, 'Avery, I admire your nerve. Bo, your kindness stays with me.');
    recordTurnReaction(playerLine.id, 3, a.id);
    recordTurnReaction(playerLine.id, -2, b.id);
    sessionParticipantsRepo.setRapport(session.id, a.id, 82, Date.now(), true);
    sessionParticipantsRepo.setRapport(session.id, b.id, 42, Date.now(), true);
    const beforeA = getRelationship(a.id);
    const beforeB = getRelationship(b.id);
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({
          mood: 'enchanted',
          expression: 'blushing',
          relationshipDeltas: { affection: 6 },
          memoryCandidates: [{ text: 'They admired my nerve.', importance: 4, tags: ['date'] }],
          summaryLine: 'Avery felt chosen and understood.',
        }),
        JSON.stringify({
          mood: 'uncertain',
          expression: 'thoughtful',
          relationshipDeltas: { trust: 4 },
          memoryCandidates: [{ text: 'They noticed my kindness.', importance: 3, tags: ['date'] }],
          summaryLine: 'Bo appreciated the words, but noticed where the attention went.',
        }),
      ]),
    );

    const result = await endSession(session.id);

    expect(result.session.ended).toBe(true);
    expect(result.evaluated).toBe(true);
    expect(result.participantResults).toHaveLength(2);
    expect(result.participantResults.map((entry) => entry.characterId)).toEqual([a.id, b.id]);
    expect(result.participantResults[0]).toMatchObject({
      characterName: a.name,
      mood: 'enchanted',
      expression: 'blushing',
      summaryLine: 'Avery felt chosen and understood.',
      memoriesWritten: 1,
      bestLine: { engagement: 3 },
    });
    expect(result.participantResults[1]).toMatchObject({
      characterName: b.name,
      mood: 'uncertain',
      expression: 'thoughtful',
      memoriesWritten: 1,
      bestLine: { engagement: -2 },
      jealousy: { triggered: true },
    });
    expect(getRelationship(a.id).affection).toBeGreaterThan(beforeA.affection);
    expect(getRelationship(b.id).trust).toBeGreaterThan(beforeB.trust);
    expect(getRelationship(b.id).flags['state:jealous']).toBe(true);
  });

  it('keeps a manual group-date end open and mutation-free if one evaluation fails', async () => {
    const { a, b, session } = startGroupDate();
    addPlayerMessage(session.id, 'How did tonight feel?');
    const beforeA = getRelationship(a.id);
    const beforeB = getRelationship(b.id);
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({
          mood: 'warm',
          expression: 'smiling',
          relationshipDeltas: { affection: 5 },
          memoryCandidates: [],
          summaryLine: 'Avery had a lovely time.',
        }),
        'not valid json',
      ]),
    );

    const result = await endSession(session.id);

    expect(result.session.ended).toBe(false);
    expect(result.evaluated).toBe(false);
    expect(result.participantResults).toHaveLength(2);
    expect(result.participantResults.every((entry) => !entry.evaluated)).toBe(true);
    expect(getRelationship(a.id)).toEqual(beforeA);
    expect(getRelationship(b.id)).toEqual(beforeB);
  });

  it('targets a DTR and gift at only the selected attendee', async () => {
    const { world, a, b, session } = startGroupDate();
    makeWarm(a.id);
    makeWarm(b.id);
    addPlayerMessage(session.id, 'Bo, I want to ask you something important.');
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({ decision: 'accept', line: "Yes, let's try this.", reason: 'ready' }),
      ]),
    );

    const dtr = await attemptDtr(session.id, undefined, b.id);
    expect(dtr).toMatchObject({ characterId: b.id, decision: 'accept', status: 'dating', ended: false });
    expect(getRelationship(a.id).flags['status']).toBeUndefined();
    expect(getRelationship(b.id).flags['status']).toBe('dating');

    const gift = createShopItem(giftItem('Pressed Flower'));
    const inventory = grantItem(gift.id, 1, playerIdForWorld(world.id)).inventoryItem;
    const beforeA = getRelationship(a.id).affection;
    const beforeB = getRelationship(b.id).affection;
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({
          expression: 'touched',
          line: 'You remembered.',
          relationshipDeltas: { affection: 5 },
          memory: null,
        }),
      ]),
    );

    const reaction = await giveGiftOnDate(session.id, inventory.id, undefined, b.id);
    expect(reaction.characterId).toBe(b.id);
    expect(reaction.message.characterId).toBe(b.id);
    expect(getRelationship(a.id).affection).toBe(beforeA);
    expect(getRelationship(b.id).affection).toBe(beforeB + 5);

    // Avery witnessed both highly personal moves. Even without a rapport gap,
    // that visible concentration of attention is carried into the recap as jealousy.
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({
          mood: 'uneasy', expression: 'annoyed', relationshipDeltas: {}, memoryCandidates: [],
          summaryLine: 'Avery felt sidelined.',
        }),
        JSON.stringify({
          mood: 'radiant', expression: 'happy', relationshipDeltas: {}, memoryCandidates: [],
          summaryLine: 'Bo felt unmistakably chosen.',
        }),
      ]),
    );
    const ending = await endSession(session.id);
    expect(ending.participantResults.find((entry) => entry.characterId === a.id)?.jealousy).toMatchObject({
      triggered: true,
    });
  });

  it('lets one attendee say goodnight while the other remains', async () => {
    const { a, b, session } = startGroupDate();
    addPlayerMessage(session.id, 'Bo, I should get going. Good night.');
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({ ending: true, expression: 'tender', farewellLine: 'Good night. Get home safe.' }),
      ]),
    );

    const farewell = await attemptPlayerFarewell(session.id, 'Bo, I should get going. Good night.', undefined, b.id);
    expect(farewell).toMatchObject({ characterId: b.id, expression: 'tender', terminal: false });
    expect(farewell?.message.characterId).toBe(b.id);
    expect(sessionParticipantsRepo.get(session.id, a.id)?.state).toBe('present');
    expect(sessionParticipantsRepo.get(session.id, b.id)?.state).toBe('departed');
    expect(sessionsRepo.get(session.id)?.ended).toBe(false);
  });

  it('breaks up with only the selected attendee and keeps the shared date open', () => {
    const { a, b, session } = startGroupDate();
    setRelationshipFlag(b.id, 'status', 'exclusive', { source: 'test' });
    addPlayerMessage(session.id, 'Bo, we are over.');

    const result = confirmPlayerBreakup(session.id, b.id);

    expect(result).toMatchObject({ characterId: b.id, fromStatus: 'exclusive', ended: false });
    expect(isBrokenUp(getRelationship(b.id))).toBe(true);
    expect(isBrokenUp(getRelationship(a.id))).toBe(false);
    expect(sessionParticipantsRepo.get(session.id, a.id)?.state).toBe('present');
    expect(sessionParticipantsRepo.get(session.id, b.id)?.state).toBe('departed');
    expect(sessionsRepo.get(session.id)?.ended).toBe(false);
  });
});

describe('group hangout outcomes', () => {
  it('evaluates both attendees but skips date-only costs and consequences', async () => {
    const { world, a, b, session } = startGroupHangout();
    addPlayerMessage(session.id, 'This was a lovely afternoon together.');
    const staminaBefore = ensureWorldState(world.id).stamina;
    const beforeA = getRelationship(a.id);
    const beforeB = getRelationship(b.id);
    setRelationshipFlag(b.id, 'status', 'exclusive', { source: 'test' });
    sessionParticipantsRepo.setRapport(session.id, a.id, 90, Date.now(), true);
    sessionParticipantsRepo.setRapport(session.id, b.id, 10, Date.now(), true);
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({
          mood: 'relaxed', expression: 'smiling', relationshipDeltas: { comfort: 3 },
          memoryCandidates: [{ text: 'We spent an easy afternoon together.', importance: 3, tags: ['hangout'] }],
          summaryLine: 'Avery enjoyed the easy company.',
        }),
        JSON.stringify({
          mood: 'cheerful', expression: 'happy', relationshipDeltas: { trust: 2 },
          memoryCandidates: [{ text: 'The three of us enjoyed the afternoon.', importance: 3, tags: ['hangout'] }],
          summaryLine: 'Bo felt included and at ease.',
        }),
      ]),
    );

    const result = await endSession(session.id);

    expect(result.session.ended).toBe(true);
    expect(result.participantResults).toHaveLength(2);
    expect(result.participantResults.every((entry) => entry.evaluated)).toBe(true);
    expect(result.participantResults.every((entry) => entry.jealousy == null)).toBe(true);
    expect(result.participantResults.every((entry) => entry.breakup == null && entry.ending == null)).toBe(true);
    expect(getRelationship(a.id).comfort).toBe(beforeA.comfort + 3);
    expect(getRelationship(b.id).trust).toBe(beforeB.trust + 2);
    expect(ensureWorldState(world.id).stamina).toBe(staminaBefore - 1);
    expect(listMemories(a.id)[0]?.sourceMode).toBe('hangout');
    expect(listMemories(b.id)[0]?.sourceMode).toBe('hangout');
  });
});
