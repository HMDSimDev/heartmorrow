import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CharacterSchema, WorldSchema, DEFAULT_DATING_STATS, type Character } from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { simulateWorldDay, WORLD_SIM } from './world-sim-service';
import { ensureWorldState } from './world-clock-service';
import { ensureRelationship } from './relationship-service';
import { charactersRepo, worldsRepo, npcEdgesRepo, npcKnowledgeRepo } from '../db/repositories';

// These tests assert the DETERMINISTIC mutations; stub the LLM color call with
// empty lines so beats stay templated (and no network is touched).
beforeEach(() => {
  resetDb();
  setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })]));
});
afterEach(() => setAdapterOverride(null));

const WID = 'w-sim';

/** Insert a world + its clock with FIXED ids so hashFloat seeds are stable across runs. */
function seedWorld(): void {
  worldsRepo.insert(WorldSchema.parse({ id: WID, name: 'Sim Town', createdAt: 1, updatedAt: 1 }));
  ensureWorldState(WID);
}

type Job = { title: string; place: string; workdays: number[]; shiftPhase: 'morning' | 'afternoon' | 'evening' };
function char(id: string, name: string, opts: { job?: Job; links?: Character['links'] } = {}): Character {
  const c = CharacterSchema.parse({
    id,
    worldId: WID,
    name,
    age: 27,
    datingStats: DEFAULT_DATING_STATS,
    employment: opts.job ?? null,
    links: opts.links ?? [],
    createdAt: 1,
    updatedAt: 1,
  });
  charactersRepo.insert(c);
  ensureRelationship(c.id);
  return c;
}

const cafe = (days = [0, 1, 2, 3, 4]): Job => ({ title: 'Barista', place: 'Café Lumen', workdays: days, shiftPhase: 'morning' });

/** A trio of café coworkers + a linked pair — enough for meetings + worked beats. */
function seedTrio(): void {
  seedWorld();
  char('c-a', 'Ava', { job: cafe() });
  char('c-b', 'Bo', { job: cafe() });
  char('c-c', 'Cy', { job: cafe() });
  char('c-d', 'Dee', { links: [{ targetId: 'c-e', kind: 'friend' }] });
  char('c-e', 'Eli');
}

const edgeShape = (e: { aId: string; bId: string; warmth: number; meetCount: number; promoted: boolean }) =>
  `${e.aId}|${e.bId}:${e.warmth}:${e.meetCount}:${e.promoted}`;
const knowShape = (k: { knowerId: string; subjectId: string | null; claim: string; fidelity: number; hops: number }) =>
  `${k.knowerId}|${k.subjectId}|${k.claim}:${k.fidelity}:${k.hops}`;

describe('world-sim core (Phase 3)', () => {
  it('is deterministic — identical starting state + seeds yield identical mutations', async () => {
    seedTrio();
    const r1 = await simulateWorldDay(WID, 3);
    const edges1 = npcEdgesRepo.list().map(edgeShape).sort();
    const know1 = npcKnowledgeRepo.list().map(knowShape).sort();

    resetDb(); // the adapter override is a separate singleton — survives the DB reset
    seedTrio();
    const r2 = await simulateWorldDay(WID, 3);
    const edges2 = npcEdgesRepo.list().map(edgeShape).sort();
    const know2 = npcKnowledgeRepo.list().map(knowShape).sort();

    expect(r2).toEqual(r1);
    expect(edges2).toEqual(edges1);
    expect(know2).toEqual(know1);
    expect(r1.beats.length).toBeGreaterThan(0); // workers always yield worked beats — non-trivial
  });

  it('is idempotent per (world, day) — re-running a simulated day mutates nothing', async () => {
    seedTrio();
    await simulateWorldDay(WID, 3);
    const edgesBefore = npcEdgesRepo.list().map(edgeShape).sort();
    const knowBefore = npcKnowledgeRepo.list().length;

    const again = await simulateWorldDay(WID, 3); // same day again
    expect(again.beats).toEqual([]);
    expect(again.newLinks).toEqual([]);
    expect(npcEdgesRepo.list().map(edgeShape).sort()).toEqual(edgesBefore); // no doubled warmth, no new rows
    expect(npcKnowledgeRepo.list().length).toBe(knowBefore);
  });

  it('never emits more than MAX_MEETINGS_PER_DAY meetings', async () => {
    seedWorld();
    // Four coworkers at one place = six candidate pairs; a roll of 0 makes them all hit.
    char('c-1', 'One', { job: cafe() });
    char('c-2', 'Two', { job: cafe() });
    char('c-3', 'Three', { job: cafe() });
    char('c-4', 'Four', { job: cafe() });

    const r = await simulateWorldDay(WID, 3, () => 0); // everything hits → cap must bite
    const met = r.beats.filter((b) => b.kind === 'met');
    expect(met.length).toBe(WORLD_SIM.maxMeetingsPerDay);
    expect(npcEdgesRepo.list().length).toBe(WORLD_SIM.maxMeetingsPerDay); // first day: one edge per meeting
  });

  it('weights coworkers above mere links — at a middling roll, coworkers meet and friends do not', async () => {
    seedWorld();
    char('c-a', 'Ava', { job: cafe() }); // Ava + Bo are coworkers (prob 0.55)
    char('c-b', 'Bo', { job: cafe() });
    char('c-x', 'Xan', { links: [{ targetId: 'c-y', kind: 'friend' }] }); // Xan + Yu are only friends (prob 0.30)
    char('c-y', 'Yu', { links: [{ targetId: 'c-x', kind: 'friend' }] });

    await simulateWorldDay(WID, 3, () => 0.4); // 0.30 < 0.4 < 0.55

    expect(npcEdgesRepo.get(WID, 'c-a', 'c-b')).toBeTruthy(); // coworkers met
    expect(npcEdgesRepo.get(WID, 'c-x', 'c-y')).toBeUndefined(); // friends did not (this time)
  });

  it('propagates news over days — a secondhand fact arrives with +1 hop and decayed fidelity', async () => {
    seedWorld();
    char('c-a', 'Ava', { job: cafe() }); // Ava & Bo are coworkers; Bo learns Ava's job
    char('c-b', 'Bo', { job: cafe() });
    char('c-c', 'Cy', { links: [{ targetId: 'c-b', kind: 'friend' }] }); // Cy is friends with Bo (candidate both ways)

    await simulateWorldDay(WID, 3, () => 0); // Ava↔Bo meet (Bo learns Ava's job, day 3)
    await simulateWorldDay(WID, 4, () => 0); // Bo↔Cy meet (Cy hears about Ava, secondhand)

    const cyKnowsAboutAva = npcKnowledgeRepo.listByKnower('c-c').find((k) => k.subjectId === 'c-a');
    expect(cyKnowsAboutAva).toBeTruthy();
    expect(cyKnowsAboutAva?.hops).toBe(1);
    expect(cyKnowsAboutAva?.fidelity).toBe(100 - WORLD_SIM.fidelityDecay);
    expect(cyKnowsAboutAva?.sourceKnowerId).toBe('c-b'); // attributed to Bo, who told Cy
  });
});
