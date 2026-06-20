import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CharacterSchema, WorldSchema, DEFAULT_DATING_STATS } from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { simulateWorldDay } from './world-sim-service';
import { ensureWorldState } from './world-clock-service';
import { ensureRelationship } from './relationship-service';
import { charactersRepo, worldsRepo, npcEdgesRepo } from '../db/repositories';

const WID = 'w-color';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

/** Two authored friends, no jobs → exactly one possible meeting (ref b0), no worked beats. */
function setup(): void {
  worldsRepo.insert(WorldSchema.parse({ id: WID, name: 'T', createdAt: 1, updatedAt: 1 }));
  ensureWorldState(WID);
  for (const [id, name, otherId] of [
    ['c-a', 'Ava', 'c-b'],
    ['c-b', 'Bo', 'c-a'],
  ] as const) {
    charactersRepo.insert(
      CharacterSchema.parse({
        id,
        worldId: WID,
        name,
        age: 27,
        datingStats: DEFAULT_DATING_STATS,
        links: [{ targetId: otherId, kind: 'friend' }],
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    ensureRelationship(id);
  }
}

const lines = (o: object) => new ScriptedAdapter([JSON.stringify(o)]);

describe('world-sim LLM color pass (Phase 5)', () => {
  it('replaces a beat summary with the LLM line keyed by its ref', async () => {
    setup();
    setAdapterOverride(lines({ lines: [{ ref: 'b0', summary: 'Ava and Bo grabbed coffee and lost track of time.' }] }));

    const r = await simulateWorldDay(WID, 3, () => 0); // forces the single meeting

    expect(r.beats.length).toBe(1);
    expect(r.beats[0]?.kind).toBe('met');
    expect(r.beats[0]?.summary).toBe('Ava and Bo grabbed coffee and lost track of time.');
  });

  it('keeps the templated summary for an unknown ref (the model cannot inject new beats)', async () => {
    setup();
    setAdapterOverride(lines({ lines: [{ ref: 'zzz', summary: 'invented nonsense' }] }));

    const r = await simulateWorldDay(WID, 3, () => 0);

    expect(r.beats.length).toBe(1);
    expect(r.beats[0]?.summary).toContain('ran into'); // unmatched ref → templated fallback
    expect(r.beats[0]?.summary).not.toContain('invented');
  });

  it('falls back to templated beats when the color call returns bad JSON — and still mutates', async () => {
    setup();
    setAdapterOverride(new ScriptedAdapter(['not json at all']));

    const r = await simulateWorldDay(WID, 3, () => 0);

    expect(r.beats.length).toBe(1);
    expect(r.beats[0]?.summary).toContain('ran into'); // templated fallback
    expect(npcEdgesRepo.get(WID, 'c-a', 'c-b')).toBeTruthy(); // the deterministic meeting still happened
  });
});
