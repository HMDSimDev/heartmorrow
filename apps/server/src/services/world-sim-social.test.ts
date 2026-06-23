import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CharacterSchema,
  WorldSchema,
  NpcEdgeSchema,
  NpcKnowledgeSchema,
  NPC_FRICTION,
  NPC_ROMANCE,
  DEFAULT_DATING_STATS,
  PLAYER_GOSSIP,
  type Character,
  type RelationshipStyle,
} from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { simulateWorldDay } from './world-sim-service';
import { getSocialWeb } from './character-service';
import { ensureWorldState } from './world-clock-service';
import { ensureRelationship, getRelationship } from './relationship-service';
import { applyRelationshipChange, setRelationshipFlag } from './stat-service';
import { listMemories } from './memory-service';
import { charactersRepo, worldsRepo, npcEdgesRepo, npcKnowledgeRepo } from '../db/repositories';
import { playerIdForWorldOrDefault } from '../lib/ids';

const WID = 'w-social';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

function seedWorld(): void {
  worldsRepo.insert(WorldSchema.parse({ id: WID, name: 'Sim Town', createdAt: 1, updatedAt: 1 }));
  ensureWorldState(WID);
}

function char(
  id: string,
  name: string,
  opts: {
    links?: Character['links'];
    style?: RelationshipStyle;
    employment?: Character['employment'];
    likes?: string[];
    dislikes?: string[];
  } = {},
): Character {
  const c = CharacterSchema.parse({
    id,
    worldId: WID,
    name,
    age: 27,
    datingStats: DEFAULT_DATING_STATS,
    links: opts.links ?? [],
    relationshipStyle: opts.style ?? 'monogamous',
    employment: opts.employment ?? null,
    likes: opts.likes ?? [],
    dislikes: opts.dislikes ?? [],
    createdAt: 1,
    updatedAt: 1,
  });
  charactersRepo.insert(c);
  ensureRelationship(c.id);
  return c;
}

/** Same workplace, every day — two such characters are guaranteed coworker run-ins. */
const ALWAYS_AT: (place: string) => NonNullable<Character['employment']> = (place) => ({
  title: 'Staff',
  place,
  workdays: [0, 1, 2, 3, 4, 5, 6],
  shiftPhase: 'morning',
});

describe('world-sim conversation substance', () => {
  it('folds the scene gist into BOTH parties\' linked memories', async () => {
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({ lines: [{ ref: 'b0', summary: 'Ada and Bea caught up over coffee.', gist: 'talked about the street fair' }] }),
      ]),
    );
    seedWorld();
    char('c-ada', 'Ada', { links: [{ targetId: 'c-bea', kind: 'friend' }] });
    char('c-bea', 'Bea', { links: [{ targetId: 'c-ada', kind: 'friend' }] });

    const r = await simulateWorldDay(WID, 3, () => 0); // friends meet (link prob 0.30 > 0)

    // The feed beat is the colored summary, and each party's memory carries the gist.
    expect(r.beats.find((b) => b.kind === 'met')?.summary).toBe('Ada and Bea caught up over coffee.');
    const adaMem = listMemories('c-ada').find((m) => m.text.includes('Bea'));
    const beaMem = listMemories('c-bea').find((m) => m.text.includes('Ada'));
    expect(adaMem?.text).toBe('Caught up with Bea — talked about the street fair.');
    expect(beaMem?.text).toBe('Caught up with Ada — talked about the street fair.');
  });

  it('keeps the templated memory when the scene call returns no gist (fail-safe)', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })])); // LLM gives nothing
    seedWorld();
    char('c-ada', 'Ada', { links: [{ targetId: 'c-bea', kind: 'friend' }] });
    char('c-bea', 'Bea', { links: [{ targetId: 'c-ada', kind: 'friend' }] });

    await simulateWorldDay(WID, 3, () => 0);
    expect(listMemories('c-ada').find((m) => m.text.includes('Bea'))?.text).toBe('Caught up with Bea.');
  });
});

describe('word about the player ripples through the world-sim', () => {
  // meetings hit (roll 0 < link prob); the topic roll lands in the 'the-player' band.
  const rng = (key: string) => (key.startsWith('topic|') ? 0.6 : 0);

  it('propagates a partner\'s first-hand player knowledge to a friend, attributed + decayed', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    char('c-mara', 'Mara', { links: [{ targetId: 'c-nia', kind: 'friend' }] });
    char('c-nia', 'Nia', { links: [{ targetId: 'c-mara', kind: 'friend' }] });
    const playerId = playerIdForWorldOrDefault(WID);

    // Mara carries a first-hand fact about the player (as if from dating them).
    npcKnowledgeRepo.insert(
      NpcKnowledgeSchema.parse({
        id: 'k-seed',
        worldId: WID,
        knowerId: 'c-mara',
        subjectId: playerId,
        topic: 'job',
        claim: 'Player is a chef',
        fidelity: 100,
        hops: 0,
        sourceKnowerId: null,
        day: 1,
        createdAt: 1,
      }),
    );

    await simulateWorldDay(WID, 3, rng); // Mara ↔ Nia meet, talk about the player

    const niaHeard = npcKnowledgeRepo.listByKnower('c-nia').find((k) => k.subjectId === playerId);
    expect(niaHeard).toBeTruthy();
    expect(niaHeard?.claim).toBe('Player is a chef');
    expect(niaHeard?.sourceKnowerId).toBe('c-mara'); // attributed to the teller
    expect(niaHeard?.hops).toBe(1);
    expect(niaHeard?.fidelity).toBe(100 - PLAYER_GOSSIP.fidelityDecay);

    // Mara remembers having brought the player up — a linked memory toward Nia.
    const mentioned = listMemories('c-mara').find((m) => /Mentioned .* to Nia/.test(m.text));
    expect(mentioned).toBeTruthy();
    expect(mentioned?.relatedCharacterId).toBe('c-nia');
  });

  it('lets word ripple a second hop and stops once it garbles below the floor', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    char('c-mara', 'Mara', { links: [{ targetId: 'c-nia', kind: 'friend' }] });
    char('c-nia', 'Nia', { links: [{ targetId: 'c-mara', kind: 'friend' }, { targetId: 'c-ola', kind: 'friend' }] });
    char('c-ola', 'Ola', { links: [{ targetId: 'c-nia', kind: 'friend' }] });
    const playerId = playerIdForWorldOrDefault(WID);
    npcKnowledgeRepo.insert(
      NpcKnowledgeSchema.parse({
        id: 'k-seed',
        worldId: WID,
        knowerId: 'c-mara',
        subjectId: playerId,
        topic: 'job',
        claim: 'Player is a chef',
        fidelity: 100,
        hops: 0,
        sourceKnowerId: null,
        day: 1,
        createdAt: 1,
      }),
    );

    await simulateWorldDay(WID, 3, rng); // Mara → Nia (hop 1)
    await simulateWorldDay(WID, 4, rng); // Nia → Ola (hop 2), re-sharing what she heard

    const olaHeard = npcKnowledgeRepo.listByKnower('c-ola').find((k) => k.subjectId === playerId);
    expect(olaHeard).toBeTruthy();
    expect(olaHeard?.hops).toBe(2);
    expect(olaHeard?.sourceKnowerId).toBe('c-nia'); // attributed to whoever told THEM
    expect(olaHeard?.fidelity).toBe(100 - 2 * PLAYER_GOSSIP.fidelityDecay);
  });
});

describe('emergent NPC romance (Spark)', () => {
  // Meetings hit (0 < link prob 0.30) and the seeded romance roll lands (0 < threshold).
  const rng = () => 0;

  it('sparks a crush between two warm, mutually-attracted, unattached friends', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    char('c-ada', 'Ada', { links: [{ targetId: 'c-bea', kind: 'friend' }] });
    char('c-bea', 'Bea', { links: [{ targetId: 'c-ada', kind: 'friend' }] });
    // Pre-warm the edge to just below the crush threshold so one meeting (+4) crosses it.
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({ worldId: WID, aId: 'c-ada', bId: 'c-bea', warmth: NPC_ROMANCE.crushWarmth - 4, meetCount: 4, lastDay: 1 }),
    );

    await simulateWorldDay(WID, 3, rng);

    const edge = npcEdgesRepo.get(WID, 'c-ada', 'c-bea');
    expect(edge?.romanceState).toBe('crush');
    expect(edge?.romanceSince).toBe(3);
    // A crush stays private (no public couple beat yet) — but each remembers it.
    expect(listMemories('c-ada').some((m) => /feelings for Bea/i.test(m.text))).toBe(true);
  });

  it('matures a sustained crush into a couple, surfaced as a recap beat', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    char('c-ada', 'Ada', { links: [{ targetId: 'c-bea', kind: 'friend' }] });
    char('c-bea', 'Bea', { links: [{ targetId: 'c-ada', kind: 'friend' }] });
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({
        worldId: WID,
        aId: 'c-ada',
        bId: 'c-bea',
        warmth: NPC_ROMANCE.togetherWarmth - 4,
        meetCount: 10,
        lastDay: 1,
        romanceState: 'crush',
        romanceSince: 1,
      }),
    );

    const r = await simulateWorldDay(WID, 5, rng);

    expect(npcEdgesRepo.get(WID, 'c-ada', 'c-bea')?.romanceState).toBe('together');
    expect(r.beats.some((b) => b.kind === 'linked' && /seeing each other/i.test(b.summary))).toBe(true);
  });

  it('does NOT couple a pair the player is committed to', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    char('c-ada', 'Ada', { links: [{ targetId: 'c-bea', kind: 'friend' }] });
    char('c-bea', 'Bea', { links: [{ targetId: 'c-ada', kind: 'friend' }] });
    // The player is exclusive with Ada → she can't start a crush with another NPC.
    setRelationshipFlag('c-ada', 'status', 'exclusive', { source: 'test' });
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({ worldId: WID, aId: 'c-ada', bId: 'c-bea', warmth: NPC_ROMANCE.crushWarmth - 4, meetCount: 4, lastDay: 1 }),
    );

    await simulateWorldDay(WID, 3, rng);

    expect(npcEdgesRepo.get(WID, 'c-ada', 'c-bea')?.romanceState).toBe('none');
  });

  it('poaches a neglected, pre-commitment player love-interest when they pair off (hard loss)', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    char('c-ada', 'Ada', { links: [{ targetId: 'c-bea', kind: 'friend' }] });
    char('c-bea', 'Bea', { links: [{ targetId: 'c-ada', kind: 'friend' }] });
    // The player had grown close to Ada (getting-close band) but hasn't seen her in ages.
    applyRelationshipChange(
      'c-ada',
      { affection: 60, trust: 60, chemistry: 60, comfort: 60, respect: 60 },
      { source: 'test' },
    );
    setRelationshipFlag('c-ada', 'lastSeenDay', 1, { source: 'test' });
    // Ada & Bea are on the verge of coupling.
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({
        worldId: WID,
        aId: 'c-ada',
        bId: 'c-bea',
        warmth: NPC_ROMANCE.togetherWarmth - 4,
        meetCount: 10,
        lastDay: 1,
        romanceState: 'crush',
        romanceSince: 1,
      }),
    );

    // Far enough past lastSeenDay (1) to clear the neglect grace window.
    await simulateWorldDay(WID, 1 + NPC_ROMANCE.poachNeglectDays, rng);

    const rel = getRelationship('c-ada');
    expect(rel.flags['state:seeingOther']).toBe('Bea'); // she's taken now
    expect(rel.affection).toBeLessThan(60); // and it stung the player's bond
  });

  it('does NOT mature a second crush into a couple once one member is already partnered', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    char('c-ada', 'Ada', { links: [{ targetId: 'c-bea', kind: 'friend' }] });
    char('c-bea', 'Bea', { links: [{ targetId: 'c-ada', kind: 'friend' }] });
    char('c-cee', 'Cee'); // Ada is already a couple with Cee
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({ worldId: WID, aId: 'c-ada', bId: 'c-cee', warmth: 50, meetCount: 12, lastDay: 1, romanceState: 'together', romanceSince: 1 }),
    );
    // Ada also still holds a near-mature crush with Bea from before she paired off.
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({ worldId: WID, aId: 'c-ada', bId: 'c-bea', warmth: NPC_ROMANCE.togetherWarmth - 4, meetCount: 10, lastDay: 1, romanceState: 'crush', romanceSince: 1 }),
    );

    await simulateWorldDay(WID, 5, rng);

    // Ada is taken — the lingering Bea crush must NOT mature into a second couple.
    expect(npcEdgesRepo.get(WID, 'c-ada', 'c-bea')?.romanceState).toBe('crush');
  });

  it('clears a poached DATING bond to a coherent state (no dating + seeingOther contradiction)', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    char('c-ada', 'Ada', { links: [{ targetId: 'c-bea', kind: 'friend' }] });
    char('c-bea', 'Bea', { links: [{ targetId: 'c-ada', kind: 'friend' }] });
    applyRelationshipChange(
      'c-ada',
      { affection: 60, trust: 60, chemistry: 60, comfort: 60, respect: 60 },
      { source: 'test' },
    );
    setRelationshipFlag('c-ada', 'status', 'dating', { source: 'test' }); // casually dating, then neglected
    setRelationshipFlag('c-ada', 'lastSeenDay', 1, { source: 'test' });
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({
        worldId: WID,
        aId: 'c-ada',
        bId: 'c-bea',
        warmth: NPC_ROMANCE.togetherWarmth - 4,
        meetCount: 10,
        lastDay: 1,
        romanceState: 'crush',
        romanceSince: 1,
      }),
    );

    await simulateWorldDay(WID, 1 + NPC_ROMANCE.poachNeglectDays, rng);

    const rel = getRelationship('c-ada');
    expect(rel.flags['state:seeingOther']).toBe('Bea');
    expect(rel.flags['status']).toBe('none'); // the dating status was cleared — no half-state
  });

  it('does NOT poach a polyamorous love-interest who pairs off (they keep you both)', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    char('c-ada', 'Ada', { links: [{ targetId: 'c-bea', kind: 'friend' }], style: 'polyamorous' });
    char('c-bea', 'Bea', { links: [{ targetId: 'c-ada', kind: 'friend' }] });
    applyRelationshipChange(
      'c-ada',
      { affection: 60, trust: 60, chemistry: 60, comfort: 60, respect: 60 },
      { source: 'test' },
    );
    setRelationshipFlag('c-ada', 'lastSeenDay', 1, { source: 'test' }); // neglected, but poly
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({
        worldId: WID,
        aId: 'c-ada',
        bId: 'c-bea',
        warmth: NPC_ROMANCE.togetherWarmth - 4,
        meetCount: 10,
        lastDay: 1,
        romanceState: 'crush',
        romanceSince: 1,
      }),
    );

    await simulateWorldDay(WID, 1 + NPC_ROMANCE.poachNeglectDays, rng);

    // Ada did pair off with Bea, but she's poly — your route stays open (no loss).
    expect(npcEdgesRepo.get(WID, 'c-ada', 'c-bea')?.romanceState).toBe('together');
    expect(getRelationship('c-ada').flags['state:seeingOther']).toBeUndefined();
  });

  it('lets a polyamorous NPC take an additional partner when their existing partner is also poly', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    char('c-ada', 'Ada', { links: [{ targetId: 'c-bea', kind: 'friend' }], style: 'polyamorous' });
    char('c-bea', 'Bea', { links: [{ targetId: 'c-ada', kind: 'friend' }], style: 'polyamorous' });
    char('c-cee', 'Cee', { style: 'polyamorous' });
    // Ada is already a (poly) couple with poly Cee, and holds a near-mature crush with poly Bea.
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({ worldId: WID, aId: 'c-ada', bId: 'c-cee', warmth: 50, meetCount: 12, lastDay: 1, romanceState: 'together', romanceSince: 1 }),
    );
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({ worldId: WID, aId: 'c-ada', bId: 'c-bea', warmth: NPC_ROMANCE.togetherWarmth - 4, meetCount: 10, lastDay: 1, romanceState: 'crush', romanceSince: 1 }),
    );

    await simulateWorldDay(WID, 5, rng);

    // A fully-poly web: Ada can take poly Bea as a second partner.
    expect(npcEdgesRepo.get(WID, 'c-ada', 'c-bea')?.romanceState).toBe('together');
  });

  it('does NOT pull a monogamous single into a polyamorous person\'s web', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    char('c-ada', 'Ada', { links: [{ targetId: 'c-bea', kind: 'friend' }], style: 'polyamorous' });
    char('c-bea', 'Bea', { links: [{ targetId: 'c-ada', kind: 'friend' }] }); // monogamous (default)
    char('c-cee', 'Cee', { style: 'polyamorous' });
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({ worldId: WID, aId: 'c-ada', bId: 'c-cee', warmth: 50, meetCount: 12, lastDay: 1, romanceState: 'together', romanceSince: 1 }),
    );
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({ worldId: WID, aId: 'c-ada', bId: 'c-bea', warmth: NPC_ROMANCE.togetherWarmth - 4, meetCount: 10, lastDay: 1, romanceState: 'crush', romanceSince: 1 }),
    );

    await simulateWorldDay(WID, 5, rng);

    // Ada is poly+partnered, but Bea is monogamous — she won't become a blindsided 2nd partner.
    expect(npcEdgesRepo.get(WID, 'c-ada', 'c-bea')?.romanceState).toBe('crush');
  });
});

describe('emergent NPC friction (Souring)', () => {
  // Coworkers meet (0 < coworker prob 0.55) and the seeded friction roll lands.
  const rng = () => 0;

  it('cools a clashing, world-sim-formed pair on a frictional meeting (warmth can fall)', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    // Coworkers (so they run into each other) with NO authored tie, who clash on taste.
    char('c-ada', 'Ada', { employment: ALWAYS_AT('Café'), likes: ['loud parties'] });
    char('c-bea', 'Bea', { employment: ALWAYS_AT('Café'), dislikes: ['loud parties'] });
    npcEdgesRepo.upsert(NpcEdgeSchema.parse({ worldId: WID, aId: 'c-ada', bId: 'c-bea', warmth: 20, meetCount: 1, lastDay: 1 }));

    await simulateWorldDay(WID, 3, rng);

    const edge = npcEdgesRepo.get(WID, 'c-ada', 'c-bea');
    expect(edge?.warmth).toBe(20 - NPC_FRICTION.coolStep); // cooled, not warmed
    expect(edge?.soured).toBe(false); // not enough cold run-ins yet to fall out
    // The memory reads as a tense run-in, not a warm catch-up (a place may appear between).
    expect(listMemories('c-ada').some((m) => /Crossed paths with Bea\b.*tense/.test(m.text))).toBe(true);
  });

  it('falls out a cold, oft-met pair into rivals (a recap beat + a rival tie)', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    char('c-ada', 'Ada', { employment: ALWAYS_AT('Café'), likes: ['loud parties'] });
    char('c-bea', 'Bea', { employment: ALWAYS_AT('Café'), dislikes: ['loud parties'] });
    // They've crossed paths enough and warmth is already low — one more cold meeting tips it.
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({ worldId: WID, aId: 'c-ada', bId: 'c-bea', warmth: 10, meetCount: NPC_FRICTION.rivalMeetings - 1, lastDay: 1 }),
    );

    const r = await simulateWorldDay(WID, 3, rng);

    expect(npcEdgesRepo.get(WID, 'c-ada', 'c-bea')?.soured).toBe(true);
    expect(r.beats.some((b) => b.kind === 'soured' && /falling-out/i.test(b.summary))).toBe(true);
    // The fall-out surfaces in the web as a mutual rivalry.
    const web = getSocialWeb(WID);
    expect(web.nodes.find((n) => n.id === 'c-ada')?.ties.find((t) => t.targetId === 'c-bea')?.kind).toBe('rival');
  });

  it('never sours a hand-authored bond (the world-sim does not override authored ties)', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
    seedWorld();
    // Same clash, same workplace — but they are AUTHORED friends, so souring is off the table.
    char('c-ada', 'Ada', { employment: ALWAYS_AT('Café'), likes: ['loud parties'], links: [{ targetId: 'c-bea', kind: 'friend' }] });
    char('c-bea', 'Bea', { employment: ALWAYS_AT('Café'), dislikes: ['loud parties'], links: [{ targetId: 'c-ada', kind: 'friend' }] });
    npcEdgesRepo.upsert(
      NpcEdgeSchema.parse({ worldId: WID, aId: 'c-ada', bId: 'c-bea', warmth: 10, meetCount: NPC_FRICTION.rivalMeetings - 1, lastDay: 1 }),
    );

    await simulateWorldDay(WID, 3, rng);

    const edge = npcEdgesRepo.get(WID, 'c-ada', 'c-bea');
    expect(edge?.soured).toBe(false);
    expect(edge?.warmth).toBe(10 + 4); // warmed normally, not cooled
    // The authored friendship still stands in the web.
    expect(getSocialWeb(WID).nodes.find((n) => n.id === 'c-ada')?.ties.find((t) => t.targetId === 'c-bea')?.kind).toBe('friend');
  });
});
