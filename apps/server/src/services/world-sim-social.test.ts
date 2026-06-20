import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CharacterSchema,
  WorldSchema,
  NpcKnowledgeSchema,
  DEFAULT_DATING_STATS,
  PLAYER_GOSSIP,
  type Character,
} from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { simulateWorldDay } from './world-sim-service';
import { ensureWorldState } from './world-clock-service';
import { ensureRelationship } from './relationship-service';
import { listMemories } from './memory-service';
import { charactersRepo, worldsRepo, npcKnowledgeRepo } from '../db/repositories';
import { playerIdForWorldOrDefault } from '../lib/ids';

const WID = 'w-social';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

function seedWorld(): void {
  worldsRepo.insert(WorldSchema.parse({ id: WID, name: 'Sim Town', createdAt: 1, updatedAt: 1 }));
  ensureWorldState(WID);
}

function char(id: string, name: string, opts: { links?: Character['links'] } = {}): Character {
  const c = CharacterSchema.parse({
    id,
    worldId: WID,
    name,
    age: 27,
    datingStats: DEFAULT_DATING_STATS,
    links: opts.links ?? [],
    createdAt: 1,
    updatedAt: 1,
  });
  charactersRepo.insert(c);
  ensureRelationship(c.id);
  return c;
}

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
