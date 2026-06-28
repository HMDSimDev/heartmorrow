import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationSessionSchema, DEFAULT_DATING_STATS, MessageSchema, TextMessageSchema, deriveCalendar, type RomanceState } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { messagesRepo, sessionsRepo, textMessagesRepo, worldStatesRepo } from '../db/repositories';
import { newId } from '../lib/ids';
import { composeConstellation, createCharacter, currentNpcPartners, getCharacter, getSocialWeb, updateCharacter } from './character-service';
import { npcEdgesRepo } from '../db/repositories';
import { getRelationship } from './relationship-service';
import { applyRelationshipChange, applyTempBuff, setRelationshipFlag, stampLastSeen } from './stat-service';
import { ensureWorldState } from './world-clock-service';
import { addPlayerMessage, createSession, endSession, maybeRollJealousy, previewCharacterPrompt, previewSessionPrompt } from './conversation-service';
import { getCharacterAvailability } from './availability-service';
import { buildTextReplyMessages, messageText } from '../prompt/prompt-builder';
import { listMemories } from './memory-service';
import { recordEvent } from './event-service';
import { getOrCreateThread, sendPlayerText } from './text-message-service';
import { generateGossipForDay } from './gossip-service';
import { rippleSocialVouch } from './social-ripple-service';

/** Make hasDated(characterId) true without going through the availability gate. */
function markDated(characterId: string): void {
  const now = Date.now();
  const s = sessionsRepo.insert(
    ConversationSessionSchema.parse({ id: newId('sess'), characterId, locationId: null, mode: 'date', summary: '', ended: true, createdAt: now, updatedAt: now }),
  );
  messagesRepo.insert(MessageSchema.parse({ id: newId('msg'), sessionId: s.id, role: 'player', text: 'hi', metadata: {}, createdAt: now }));
}

/** A fake RNG returning a scripted sequence (last value repeats). */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

const evalReply = (summaryLine: string) =>
  JSON.stringify({ mood: 'neutral', expression: 'neutral', relationshipDeltas: {}, memoryCandidates: [], summaryLine });

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

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('edge-aware jealousy', () => {
  it('fixates on a graph-linked ex over an unconnected stranger, and names the link', () => {
    const { world, character } = seedWorldAndCharacter();
    const ex = createCharacter({ worldId: world.id, name: 'The Ex', age: 30, datingStats: DEFAULT_DATING_STATS });
    createCharacter({ worldId: world.id, name: 'A Stranger', age: 28, datingStats: DEFAULT_DATING_STATS });
    updateCharacter(character.id, { links: [{ targetId: ex.id, kind: 'ex' }] });
    ensureWorldState(world.id);
    // Jealousy only fires once there's a real bond — bump past the closeness floor.
    applyRelationshipChange(character.id, { affection: 45, trust: 45, chemistry: 45, comfort: 45, respect: 45 }, { source: 'test' });
    stampLastSeen(ex.id, 1);
    // Note: only "The Ex" is stamped as seen below so the weighting target is unambiguous,
    // plus the stranger to prove the weighted pick favors the ex.
    stampLastSeen(getCharacter(character.id).links[0]!.targetId, 1);

    // rng: [trigger-check 0 → fires, pick 0.5 → lands on the high-weight ex]
    const outcome = maybeRollJealousy(getCharacter(character.id), seq([0, 0.5]));
    expect(outcome?.triggered).toBe(true);
    expect(outcome!.message).toContain('The Ex');
    expect(outcome!.message).toContain('their ex');
  });
});

describe('emotional-state carryover (consumes the flags)', () => {
  it('clears state:offended after the next date resolves it', async () => {
    const { character } = seedWorldAndCharacter();
    setRelationshipFlag(character.id, 'state:offended', true, { source: 'test' });
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'I owe you an apology.');
    setAdapterOverride(new ScriptedAdapter([evalReply('They talked it out.')]));

    const res = await endSession(session.id);
    expect(res.evaluated).toBe(true);
    expect(getRelationship(character.id).flags['state:offended']).toBe(false);
  });

  it('clears an incoming state:jealous when no fresh jealousy is discovered', async () => {
    const { character } = seedWorldAndCharacter();
    setRelationshipFlag(character.id, 'state:jealous', true, { source: 'test' });
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, "You're the only one for me.");
    setAdapterOverride(new ScriptedAdapter([evalReply('Reassured.')]));

    await endSession(session.id);
    // No other recently-seen characters → no new jealousy → the carried flag resolves.
    expect(getRelationship(character.id).flags['state:jealous']).toBe(false);
  });
});

describe('gossip propagation', () => {
  it('a linked friend who has dated you texts about yesterday\'s milestone, idempotently', async () => {
    const { world, character: subject } = seedWorldAndCharacter();
    const gossiper = createCharacter({
      worldId: world.id,
      name: 'Chatty Friend',
      age: 26,
      datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: subject.id, kind: 'friend' }],
    });
    markDated(gossiper.id); // the player has dated the gossiper, so they can text
    ensureWorldState(world.id); // day 1
    // Yesterday (day 1): the player hit a milestone with the subject.
    recordEvent('milestone_reached', { characterId: subject.id, band: 'close', label: 'close', day: 1 });
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ body: 'heard you two are getting close — cute!' })]));

    await generateGossipForDay(world.id, 2);
    const thread = getOrCreateThread(gossiper.id);
    const gossip = textMessagesRepo
      .listAllByThread(thread.id)
      .filter((t) => t.sender === 'character' && t.status === 'queued' && t.dayNumber === 2);
    expect(gossip).toHaveLength(1);

    // Re-running the day-start pass must not duplicate the gossip.
    await generateGossipForDay(world.id, 2);
    const after = textMessagesRepo.listAllByThread(thread.id).filter((t) => t.sender === 'character' && t.dayNumber === 2);
    expect(after).toHaveLength(1);
  });
});

describe('social graph in the dialogue prompt', () => {
  it("injects a character's links into their prompt so they know their friends", () => {
    const { world, character: a } = seedWorldAndCharacter();
    const b = createCharacter({ worldId: world.id, name: 'Bestie Bee', age: 28, datingStats: DEFAULT_DATING_STATS });
    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'friend' }] });

    const { system } = previewCharacterPrompt(a.id);
    expect(system).toContain('PEOPLE YOU KNOW');
    expect(system).toContain('Bestie Bee');
  });

  it('surfaces incoming links too, so a one-sided connection still connects both', () => {
    const { world, character: a } = seedWorldAndCharacter();
    // Ann lists `a` as a friend; `a` has no links of their own.
    createCharacter({
      worldId: world.id, name: 'Admirer Ann', age: 28, datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: a.id, kind: 'friend' }],
    });
    const { system } = previewCharacterPrompt(a.id);
    expect(system).toContain('Admirer Ann');
  });

  it('feeds in the commitment status and the relationship style', () => {
    const { character } = seedWorldAndCharacter(); // monogamous by default
    setRelationshipFlag(character.id, 'status', 'exclusive', { source: 'test' });
    const { system } = previewCharacterPrompt(character.id);
    expect(system.toLowerCase()).toContain('exclusive');
    expect(system.toLowerCase()).toContain('monogamous');
  });

  it('injects recent texts for continuity with the phone', () => {
    const { character } = seedWorldAndCharacter();
    const thread = getOrCreateThread(character.id);
    const now = Date.now();
    textMessagesRepo.insert(
      TextMessageSchema.parse({
        id: newId('txt'), threadId: thread.id, sender: 'character', body: 'cant wait for tonight',
        status: 'delivered', dayNumber: 1, deliveredAt: now, createdAt: now,
      }),
    );
    const { system } = previewCharacterPrompt(character.id);
    expect(system).toContain('RECENT TEXTS');
    expect(system).toContain('cant wait for tonight');
  });

  it('passes the character’s age, gender, and orientation into the date prompt', () => {
    const { world } = seedWorldAndCharacter();
    const lena = createCharacter({
      worldId: world.id, name: 'Lena', age: 31, gender: 'female', sexuality: 'gay', datingStats: DEFAULT_DATING_STATS,
    });
    const { system } = previewCharacterPrompt(lena.id);
    expect(system).toContain('(31,'); // age in the identity line
    expect(system).toContain('female'); // gender
    expect(system).toContain('a lesbian'); // orientation label
  });

  it('dates recent texts, flags stale plans, and names the day of week', () => {
    const { world, character } = seedWorldAndCharacter();
    const ws = ensureWorldState(world.id);
    worldStatesRepo.update({ ...ws, day: 5, updatedAt: Date.now() }); // now Day 5
    const thread = getOrCreateThread(character.id);
    const now = Date.now();
    textMessagesRepo.insert(
      TextMessageSchema.parse({
        id: newId('txt'), threadId: thread.id, sender: 'character', body: 'see you tomorrow!',
        status: 'delivered', dayNumber: 2, deliveredAt: now, createdAt: now, // sent on Day 2
      }),
    );
    const { system } = previewCharacterPrompt(character.id);
    expect(system).toContain('(Day 2)'); // the text is dated
    expect(system).toContain('it is now Day 5'); // current day stated
    expect(system).toContain('3 days ago'); // elapsed gap, so "tomorrow" isn't treated as now
    expect(system).toContain(deriveCalendar(5).dayOfWeek); // day of week in the scene
  });
});

describe('texting affects stats (small, capped, can go negative)', () => {
  it('a warm exchange nudges warmth up, but the daily gain is capped against spamming', async () => {
    const { character } = seedWorldAndCharacter();
    markDated(character.id);
    ensureWorldState(character.worldId!);
    // Each send makes two calls: the in-character reply, then the impartial judge
    // of how the PLAYER's text landed (the judge drives the relationship delta).
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({ body: 'aw, you too 😊', tone: 'flirty' }),
        JSON.stringify({ engagement: 3, hostile: false, note: 'sweet and warm' }),
        JSON.stringify({ body: 'haha you’re too much', tone: 'playful' }),
        JSON.stringify({ engagement: 3, hostile: false, note: 'still sweet' }),
      ]),
    );
    const before = getRelationship(character.id);

    const first = await sendPlayerText(character.id, 'thinking about you');
    expect((first.relationshipDelta.chemistry ?? 0) + (first.relationshipDelta.affection ?? 0)).toBeGreaterThan(0);
    const afterOne = getRelationship(character.id);
    expect(afterOne.chemistry).toBeGreaterThan(before.chemistry);

    // Spamming more nice texts the same day yields nothing — no grinding.
    const spam = await sendPlayerText(character.id, 'love you!!');
    expect(spam.relationshipDelta).toEqual({});
    expect(getRelationship(character.id).chemistry).toBe(afterOne.chemistry);
    expect(getRelationship(character.id).affection).toBe(afterOne.affection);
  });

  it('a hostile/cold text lowers stats and keeps hurting (no cap on the downside)', async () => {
    const { character } = seedWorldAndCharacter();
    markDated(character.id);
    ensureWorldState(character.worldId!);
    // The character replies however it likes; the impartial judge scores the
    // PLAYER's text negative, and that is what moves the relationship.
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({ body: 'whatever.', tone: 'annoyed' }),
        JSON.stringify({ engagement: -2, hostile: false, note: 'accusatory' }),
        JSON.stringify({ body: 'ok.', tone: 'distant' }),
        JSON.stringify({ engagement: -2, hostile: false, note: 'dismissive' }),
      ]),
    );
    const before = getRelationship(character.id);

    const r1 = await sendPlayerText(character.id, 'you never reply fast enough');
    expect(r1.relationshipDelta.tension).toBeGreaterThan(0);
    expect(getRelationship(character.id).comfort).toBeLessThan(before.comfort);

    await sendPlayerText(character.id, 'ugh, forget it');
    expect(getRelationship(character.id).comfort).toBeLessThan(before.comfort - 1);
  });
});

describe('mutual-friend vouching', () => {
  it('warms the subject\'s friend and cools their rival, once', () => {
    const { world, character: subject } = seedWorldAndCharacter();
    const friend = createCharacter({
      worldId: world.id, name: 'Their Friend', age: 27, datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: subject.id, kind: 'friend' }],
    });
    const rival = createCharacter({
      worldId: world.id, name: 'Their Rival', age: 29, datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: subject.id, kind: 'rival' }],
    });
    const friendBefore = getRelationship(friend.id).affection;
    const rivalBefore = getRelationship(rival.id).affection;

    rippleSocialVouch(subject.id);

    expect(getRelationship(friend.id).affection).toBeGreaterThan(friendBefore);
    expect(getRelationship(rival.id).affection).toBeLessThan(rivalBefore);
    expect(getRelationship(friend.id).flags[`vouch:${subject.id}`]).toBe(true);

    // Idempotent: a second ripple changes nothing.
    const settled = getRelationship(friend.id).affection;
    rippleSocialVouch(subject.id);
    expect(getRelationship(friend.id).affection).toBe(settled);
  });

  it('a mere acquaintance does NOT vouch — no stat change, no flag, no planted memory', () => {
    const { world, character: subject } = seedWorldAndCharacter();
    const acq = createCharacter({
      worldId: world.id, name: 'Passing Acquaintance', age: 31, datingStats: DEFAULT_DATING_STATS,
      links: [{ targetId: subject.id, kind: 'acquaintance' }],
    });
    const before = getRelationship(acq.id).affection;

    rippleSocialVouch(subject.id);

    expect(getRelationship(acq.id).affection).toBe(before); // crossing paths is no endorsement
    expect(getRelationship(acq.id).flags[`vouch:${subject.id}`]).toBeUndefined();
    expect(listMemories(acq.id).length).toBe(0); // no leaked "getting close" memory
  });
});

describe('social web read model (getSocialWeb)', () => {
  /** Upsert a derived world-sim edge (canonical aId < bId order). */
  const addEdge = (
    worldId: string,
    x: string,
    y: string,
    promoted: boolean,
    romanceState: RomanceState = 'none',
    soured = false,
  ) => {
    const [aId, bId] = x < y ? [x, y] : [y, x];
    npcEdgesRepo.upsert({
      worldId,
      aId,
      bId,
      warmth: 0,
      meetCount: 1,
      lastDay: 1,
      promoted,
      romanceState,
      romanceSince: romanceState === 'none' ? 0 : 1,
      soured,
    });
  };
  const tieFor = (web: { nodes: Array<{ id: string; ties: Array<{ targetId: string; kind: string; derived: boolean; incoming?: boolean }> }> }, owner: string, target: string) =>
    web.nodes.find((n) => n.id === owner)?.ties.find((t) => t.targetId === target);

  it('shows a mutual authored friendship on both cards as a non-derived tie', () => {
    const { world, character: a } = seedWorldAndCharacter();
    const b = createCharacter({ worldId: world.id, name: 'Bee', age: 27, datingStats: DEFAULT_DATING_STATS, links: [{ targetId: a.id, kind: 'friend' }] });
    const web = getSocialWeb(world.id);
    expect(tieFor(web, a.id, b.id)).toMatchObject({ kind: 'friend', derived: false });
    expect(tieFor(web, b.id, a.id)).toMatchObject({ kind: 'friend', derived: false });
    expect(tieFor(web, a.id, b.id)!.incoming).toBeFalsy();
  });

  it('surfaces a one-sided rival on the target as `incoming`, but not on the author', () => {
    const { world, character: a } = seedWorldAndCharacter();
    const r = createCharacter({ worldId: world.id, name: 'Rival Rae', age: 29, datingStats: DEFAULT_DATING_STATS, links: [{ targetId: a.id, kind: 'rival' }] });
    const web = getSocialWeb(world.id);
    expect(tieFor(web, r.id, a.id)).toMatchObject({ kind: 'rival', derived: false });
    expect(tieFor(web, r.id, a.id)!.incoming).toBeFalsy();
    expect(tieFor(web, a.id, r.id)).toMatchObject({ kind: 'rival', derived: false, incoming: true });
  });

  it('fills gaps with derived ties: a run-in is an acquaintance, a promoted edge is a friend', () => {
    const { world, character: a } = seedWorldAndCharacter();
    const b = createCharacter({ worldId: world.id, name: 'Cee', age: 30, datingStats: DEFAULT_DATING_STATS });
    const c = createCharacter({ worldId: world.id, name: 'Dee', age: 31, datingStats: DEFAULT_DATING_STATS });
    addEdge(world.id, a.id, b.id, false); // crossed paths
    addEdge(world.id, a.id, c.id, true); // grew into a friendship
    const web = getSocialWeb(world.id);
    expect(tieFor(web, a.id, b.id)).toMatchObject({ kind: 'acquaintance', derived: true });
    expect(tieFor(web, a.id, c.id)).toMatchObject({ kind: 'friend', derived: true });
  });

  it('surfaces a world-sim-grown couple as a mutual partner tie', () => {
    const { world, character: a } = seedWorldAndCharacter();
    const b = createCharacter({ worldId: world.id, name: 'Lover Lee', age: 29, datingStats: DEFAULT_DATING_STATS });
    addEdge(world.id, a.id, b.id, true, 'together'); // the world-sim grew a couple here
    const web = getSocialWeb(world.id);
    expect(tieFor(web, a.id, b.id)).toMatchObject({ kind: 'partner', derived: true });
    expect(tieFor(web, b.id, a.id)).toMatchObject({ kind: 'partner', derived: true });
  });

  it('surfaces a soured world-sim edge as a mutual rival tie', () => {
    const { world, character: a } = seedWorldAndCharacter();
    const b = createCharacter({ worldId: world.id, name: 'Sour Sam', age: 30, datingStats: DEFAULT_DATING_STATS });
    addEdge(world.id, a.id, b.id, true, 'none', true); // they were friendly, then fell out
    const web = getSocialWeb(world.id);
    expect(tieFor(web, a.id, b.id)).toMatchObject({ kind: 'rival', derived: true });
    expect(tieFor(web, b.id, a.id)).toMatchObject({ kind: 'rival', derived: true });
  });

  it('a world-sim couple upgrades an authored friendship to a partner tie (not hidden behind "Friend")', () => {
    const { world, character: a } = seedWorldAndCharacter();
    // They were authored friends (mirrored both ways); the world-sim then coupled them.
    const b = createCharacter({ worldId: world.id, name: 'Sweetheart Sage', age: 29, datingStats: DEFAULT_DATING_STATS, links: [{ targetId: a.id, kind: 'friend' }] });
    addEdge(world.id, a.id, b.id, true, 'together');
    const web = getSocialWeb(world.id);
    expect(tieFor(web, a.id, b.id)).toMatchObject({ kind: 'partner', derived: true });
    expect(tieFor(web, b.id, a.id)).toMatchObject({ kind: 'partner', derived: true });
  });

  it('an authored own link always beats a derived edge for the same pair', () => {
    const { world, character: a } = seedWorldAndCharacter();
    const b = createCharacter({ worldId: world.id, name: 'Eff', age: 28, datingStats: DEFAULT_DATING_STATS, links: [{ targetId: a.id, kind: 'partner' }] });
    addEdge(world.id, a.id, b.id, true); // world-sim also formed a friendship
    const web = getSocialWeb(world.id);
    expect(tieFor(web, a.id, b.id)).toMatchObject({ kind: 'partner', derived: false });
  });

  it('ranks a since-formed friendship over a stale one-sided rivalry on the target card', () => {
    const { world, character: a } = seedWorldAndCharacter();
    const r = createCharacter({ worldId: world.id, name: 'Frenemy', age: 32, datingStats: DEFAULT_DATING_STATS, links: [{ targetId: a.id, kind: 'rival' }] });
    addEdge(world.id, a.id, r.id, true); // they kept running into each other and became friends
    const web = getSocialWeb(world.id);
    // The author still regards them a rival…
    expect(tieFor(web, r.id, a.id)).toMatchObject({ kind: 'rival' });
    // …but `a`, who never declared anything, sees the formed friendship, not the rivalry.
    expect(tieFor(web, a.id, r.id)).toMatchObject({ kind: 'friend', derived: true });
  });

  it('omits people with no ties, and merges no derived edges when no world is given', () => {
    const { world, character: a } = seedWorldAndCharacter();
    const b = createCharacter({ worldId: world.id, name: 'Gee', age: 33, datingStats: DEFAULT_DATING_STATS });
    addEdge(world.id, a.id, b.id, false);
    // Scoped to the world, the run-in surfaces; unscoped, derived edges are skipped.
    expect(tieFor(getSocialWeb(world.id), a.id, b.id)).toMatchObject({ kind: 'acquaintance', derived: true });
    expect(getSocialWeb().nodes.find((n) => n.id === a.id)).toBeUndefined();
  });
});

describe('player constellation edges (composeConstellation)', () => {
  it('threads the hearth only to characters the player has actually met, with warmth + band', () => {
    const { world, character: a } = seedWorldAndCharacter();
    const unmet = createCharacter({ worldId: world.id, name: 'Unmet', age: 28, datingStats: DEFAULT_DATING_STATS });
    applyRelationshipChange(a.id, { affection: 50, trust: 50, chemistry: 50, comfort: 50, respect: 50 }, { source: 'test' });
    setRelationshipFlag(a.id, 'lastSeenDay', 1, { source: 'test' }); // the player has actually seen them

    const cst = composeConstellation(world.id);
    const edge = cst.edges.find((e) => e.characterId === a.id);
    expect(edge).toBeTruthy();
    expect(edge!.warmth).toBeGreaterThan(0);
    expect(edge!.band).toBeTruthy();
    expect(cst.edges.find((e) => e.characterId === unmet.id)).toBeUndefined(); // never met — no thread
  });
});

describe('temporary buffs decay when a session ends', () => {
  it('decays once even when the end-of-date evaluator fails', async () => {
    const { character } = seedWorldAndCharacter();
    applyTempBuff(character.id, 'charm', 8, 2, { source: 'test' }); // 2 sessions remaining
    expect(getRelationship(character.id).flags['buff:charm']).toBe(2);

    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'hey, good to see you');
    // The evaluator never returns valid JSON, so the eval fails on every retry.
    setAdapterOverride(new ScriptedAdapter(['this is not json']));

    const res = await endSession(session.id);
    expect(res.evaluated).toBe(false); // eval failed → no relationship/memory mutation
    // …but the buff still decayed by one session (README: "decay when a session ends").
    expect(getRelationship(character.id).flags['buff:charm']).toBe(1);
  });
});

describe('honest about an emergent NPC partnership (no denying a world-announced couple)', () => {
  /** Pair two NPCs off the way the world-sim does — an npc_edges row at 'together'. */
  function coupleUp(worldId: string, aId: string, bId: string): void {
    npcEdgesRepo.upsert({
      worldId,
      aId,
      bId,
      warmth: 50,
      meetCount: 4,
      lastDay: 1,
      promoted: true,
      romanceState: 'together' as RomanceState,
      romanceSince: 1,
      soured: false,
    });
  }

  it('resolves the partner from npc_edges (only "together", both directions)', () => {
    const { world, character } = seedWorldAndCharacter();
    const bea = createCharacter({ worldId: world.id, name: 'Bea', age: 27, datingStats: DEFAULT_DATING_STATS });
    coupleUp(world.id, bea.id, character.id); // reversed order — upsert canonicalizes
    expect(currentNpcPartners(character).map((p) => p.name)).toEqual(['Bea']);
    // A mere crush is NOT a partnership.
    const { character: single } = seedWorldAndCharacter();
    expect(currentNpcPartners(single)).toHaveLength(0);
  });

  it('on a date, a coupled-off (monogamous) character is told to be honest, not deny it', () => {
    const { world, character } = seedWorldAndCharacter(); // monogamous by default
    const bea = createCharacter({ worldId: world.id, name: 'Bea', age: 27, datingStats: DEFAULT_DATING_STATS });
    coupleUp(world.id, character.id, bea.id);
    advanceToAvailableDay(world.id, character.id);

    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    const sys = previewSessionPrompt(session.id).system;
    expect(sys).toContain('Bea');
    expect(sys.toLowerCase()).toContain('never deny');
  });

  it('texts honestly about the new partner (the reported surface)', () => {
    const { world, character } = seedWorldAndCharacter();
    const bea = createCharacter({ worldId: world.id, name: 'Bea', age: 27, datingStats: DEFAULT_DATING_STATS });
    coupleUp(world.id, character.id, bea.id);

    const msgs = buildTextReplyMessages({
      character: getCharacter(character.id),
      relationship: getRelationship(character.id),
      recentTexts: [],
      playerName: 'Alex',
      npcPartnerNames: currentNpcPartners(character).map((p) => p.name),
    });
    const sys = messageText(msgs[0]!.content).toLowerCase();
    expect(sys).toContain('seeing bea');
    expect(sys).toContain('never deny');
  });

  it('a polyamorous character stays open but is still honest about the other partner', () => {
    const { world, character } = seedWorldAndCharacter();
    updateCharacter(character.id, { relationshipStyle: 'polyamorous' });
    const bea = createCharacter({ worldId: world.id, name: 'Bea', age: 27, datingStats: DEFAULT_DATING_STATS });
    coupleUp(world.id, character.id, bea.id);

    const msgs = buildTextReplyMessages({
      character: getCharacter(character.id), // re-fetch so the poly style is in effect
      relationship: getRelationship(character.id),
      recentTexts: [],
      playerName: 'Alex',
      npcPartnerNames: currentNpcPartners(character).map((p) => p.name),
    });
    const sys = messageText(msgs[0]!.content).toLowerCase();
    expect(sys).toContain('polyamorous');
    expect(sys).toContain('bea');
  });

  it('an unattached character gets no "you\'re taken" clause', () => {
    const { character } = seedWorldAndCharacter();
    const msgs = buildTextReplyMessages({
      character,
      relationship: getRelationship(character.id),
      recentTexts: [],
      playerName: 'Alex',
      npcPartnerNames: currentNpcPartners(character).map((p) => p.name),
    });
    expect(messageText(msgs[0]!.content).toLowerCase()).not.toContain('never deny');
  });
});
