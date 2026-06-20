import { describe, it, expect, beforeEach } from 'vitest';
import {
  NpcEdgeSchema,
  NpcKnowledgeSchema,
  CanonFactSchema,
  LINK_JEALOUSY_WEIGHT,
  VOUCH_DELTAS,
  CHARACTER_LINK_LABELS,
  CHARACTER_LINK_ICONS,
} from '@dsim/shared';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { createCharacter } from './character-service';
import { exportAll, importAll, resetProgress } from './data-service';
import { ensureWorldState } from './world-clock-service';
import { charactersRepo, worldStatesRepo, npcEdgesRepo, npcKnowledgeRepo, canonFactsRepo } from '../db/repositories';

beforeEach(() => resetDb());

/** A world with two characters, so NPC↔NPC edges have two real endpoints. */
function seedPair() {
  const { world, character } = seedWorldAndCharacter();
  const other = createCharacter({ worldId: world.id, name: 'Other', age: 28 });
  return { world, a: character, b: other };
}

describe('world-sim derived tables (Phase 2)', () => {
  it('canonicalizes the npc_edges pair so (a,b) and (b,a) are the same row', () => {
    const { world, a, b } = seedPair();
    npcEdgesRepo.upsert(NpcEdgeSchema.parse({ worldId: world.id, aId: b.id, bId: a.id, warmth: 3, meetCount: 1, lastDay: 2 }));
    // Reading in the opposite order resolves the same edge…
    expect(npcEdgesRepo.get(world.id, a.id, b.id)?.warmth).toBe(3);
    expect(npcEdgesRepo.get(world.id, b.id, a.id)?.warmth).toBe(3);
    // …and a second upsert updates in place rather than making a mirror row.
    npcEdgesRepo.upsert(NpcEdgeSchema.parse({ worldId: world.id, aId: a.id, bId: b.id, warmth: 8, meetCount: 2, lastDay: 4 }));
    expect(npcEdgesRepo.listByWorld(world.id).length).toBe(1);
    expect(npcEdgesRepo.get(world.id, a.id, b.id)?.warmth).toBe(8);
  });

  it('persists last_world_sim_day on world_states', () => {
    const { world } = seedWorldAndCharacter();
    const s = ensureWorldState(world.id);
    expect(s.lastWorldSimDay).toBe(0);
    worldStatesRepo.update({ ...s, lastWorldSimDay: 5 });
    expect(worldStatesRepo.get(world.id)?.lastWorldSimDay).toBe(5);
  });

  it('rejecting a canon fact is reversible and cascades its gossip residue stale', () => {
    const { world, a, b } = seedPair();
    canonFactsRepo.insert(
      CanonFactSchema.parse({ id: 'cf1', worldId: world.id, subjectId: a.id, category: 'habit', value: 'smokes', day: 1, createdAt: 1 }),
    );
    npcKnowledgeRepo.insert(
      NpcKnowledgeSchema.parse({ id: 'k1', worldId: world.id, knowerId: b.id, subjectId: a.id, topic: 'ex_fact', claim: 'smokes', sourceCanonId: 'cf1', day: 1, createdAt: 1 }),
    );

    canonFactsRepo.reject('cf1');
    npcKnowledgeRepo.markStaleByCanon('cf1');

    expect(canonFactsRepo.listBySubject(a.id, { status: 'active' }).length).toBe(0);
    expect(canonFactsRepo.listBySubject(a.id).find((f) => f.id === 'cf1')?.status).toBe('rejected');
    expect(npcKnowledgeRepo.listByKnower(b.id)[0]?.fidelity).toBe(0); // residue went stale
  });

  it('resetProgress wipes all derived state but keeps the authored character + employment', () => {
    const { world } = seedWorldAndCharacter();
    const worker = createCharacter({
      worldId: world.id,
      name: 'Barista',
      age: 26,
      employment: { title: 'Barista', place: 'Café', workdays: [0, 1, 2], shiftPhase: 'morning' },
    });
    const { a, b } = { a: worker, b: charactersRepo.listByWorld(world.id)[0]! };
    npcEdgesRepo.upsert(NpcEdgeSchema.parse({ worldId: world.id, aId: a.id, bId: b.id, warmth: 5, meetCount: 1, lastDay: 1 }));
    canonFactsRepo.insert(CanonFactSchema.parse({ id: 'cf', worldId: world.id, subjectId: a.id, category: 'hobby', value: 'painting', day: 1, createdAt: 1 }));
    npcKnowledgeRepo.insert(NpcKnowledgeSchema.parse({ id: 'k', worldId: world.id, knowerId: b.id, subjectId: a.id, topic: 'job', claim: 'barista', day: 1, createdAt: 1 }));

    resetProgress();

    expect(npcEdgesRepo.list().length).toBe(0);
    expect(npcKnowledgeRepo.list().length).toBe(0);
    expect(canonFactsRepo.list().length).toBe(0);
    // Authored content (incl. the job) survives a reset untouched.
    expect(charactersRepo.get(worker.id)?.employment?.title).toBe('Barista');
  });

  it('export/import round-trips derived state and prunes orphan rows', () => {
    const { world, a, b } = seedPair();
    npcEdgesRepo.upsert(NpcEdgeSchema.parse({ worldId: world.id, aId: a.id, bId: b.id, warmth: 7, meetCount: 3, lastDay: 2, promoted: true }));
    canonFactsRepo.insert(CanonFactSchema.parse({ id: 'cf', worldId: world.id, subjectId: a.id, category: 'job', value: 'pianist', day: 1, createdAt: 1 }));

    const bundle = exportAll();
    expect(bundle.kind).toBe('savegame');
    expect(bundle.npcEdges.length).toBe(1);
    // Inject an orphan edge whose second endpoint isn't a real character.
    bundle.npcEdges.push(NpcEdgeSchema.parse({ worldId: world.id, aId: a.id, bId: 'ghost', warmth: 99, meetCount: 9, lastDay: 9 }));

    importAll(bundle);

    const edges = npcEdgesRepo.listByWorld(world.id);
    expect(edges.length).toBe(1); // valid kept, orphan dropped
    expect(edges[0]?.warmth).toBe(7);
    expect(edges[0]?.promoted).toBe(true);
    expect(canonFactsRepo.listBySubject(a.id).length).toBe(1);
  });

  it('an authoring export drops derived state so a re-seeded world inherits none of it', () => {
    const { world, a, b } = seedPair();
    npcEdgesRepo.upsert(NpcEdgeSchema.parse({ worldId: world.id, aId: a.id, bId: b.id, warmth: 4, meetCount: 1, lastDay: 1 }));
    canonFactsRepo.insert(CanonFactSchema.parse({ id: 'cf', worldId: world.id, subjectId: a.id, category: 'habit', value: 'smokes', day: 1, createdAt: 1 }));

    const authoring = exportAll({ kind: 'authoring' });
    expect(authoring.kind).toBe('authoring');
    expect(authoring.npcEdges.length).toBe(0);
    expect(authoring.canonFacts.length).toBe(0);
    expect(authoring.npcKnowledge.length).toBe(0);
    // But the characters (authored) are still present.
    expect(authoring.characters.length).toBeGreaterThan(0);
  });

  it('the acquaintance link kind has entries in every exhaustive map', () => {
    expect(CHARACTER_LINK_LABELS.acquaintance).toBeTruthy();
    expect(CHARACTER_LINK_ICONS.acquaintance).toBeTruthy();
    expect(LINK_JEALOUSY_WEIGHT.acquaintance).toBe(1); // low — a chance meeting isn't drama
    expect(VOUCH_DELTAS.acquaintance).toEqual({}); // crossing paths is no endorsement
  });
});
