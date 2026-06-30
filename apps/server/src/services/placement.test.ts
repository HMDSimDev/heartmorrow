import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_DATING_STATS } from '@dsim/shared';
import { resetDb } from '../test/helpers';
import { createWorld } from './world-service';
import { createCharacter, updateCharacter } from './character-service';
import { updateLlmSettings } from './settings-service';
import { clusterOccupants, composeLocationScene, getLocationOccupancy, getPlacements } from './placement-service';

beforeEach(() => {
  resetDb();
  updateLlmSettings({ discoveryMode: true }); // Around Town + discovery active for these tests
});

const DS = DEFAULT_DATING_STATS;
const townWorld = () =>
  createWorld({
    name: 'Town',
    locations: [
      { id: 'cafe', name: 'Cafe', kind: 'cafe' },
      { id: 'park', name: 'Park', kind: 'park' },
    ],
  });

describe('placement engine (Phase 2)', () => {
  it('is deterministic and single-pass consistent (a person is in at most one place)', () => {
    const w = townWorld();
    for (let i = 0; i < 8; i += 1) createCharacter({ worldId: w.id, name: `C${i}`, age: 25, datingStats: DS });

    const a = getPlacements(w.id, 3, 'morning');
    const b = getPlacements(w.id, 3, 'morning');
    expect([...a.entries()]).toEqual([...b.entries()]);

    const atCafe = getLocationOccupancy(w.id, 3, 'morning', 'cafe');
    for (const id of atCafe) expect(a.get(id)?.locationId).toBe('cafe');
  });

  it('places a worker at their venue on shift (zero randomness, before the unavailable roll)', () => {
    const w = townWorld();
    const c = createCharacter({ worldId: w.id, name: 'Barista', age: 30, datingStats: DS });
    updateCharacter(c.id, {
      employment: { title: 'Barista', place: 'Cafe', locationId: 'cafe', shiftPhases: ['morning'], workdays: [0, 1, 2, 3, 4, 5, 6] },
    });

    expect(getPlacements(w.id, 1, 'morning').get(c.id)).toEqual({ locationId: 'cafe', atWork: true });
    expect(getPlacements(w.id, 1, 'evening').get(c.id)?.atWork).toBe(false); // off shift
  });

  it('night sends everyone home when no venue opts into nightlife', () => {
    const w = townWorld();
    for (let i = 0; i < 5; i += 1) createCharacter({ worldId: w.id, name: `C${i}`, age: 25, datingStats: DS });
    for (const p of getPlacements(w.id, 1, 'night').values()) expect(p.locationId).toBeNull();
  });

  it('clusters are deterministic; untied co-present people never cluster', () => {
    const w = townWorld();
    const a = createCharacter({ worldId: w.id, name: 'A', age: 25, datingStats: DS });
    const b = createCharacter({ worldId: w.id, name: 'B', age: 26, datingStats: DS });

    expect(clusterOccupants(w.id, 1, 'cafe', [a.id, b.id])).toEqual([]); // no tie → no cluster

    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'friend' }] });
    expect(clusterOccupants(w.id, 1, 'cafe', [a.id, b.id])).toEqual(clusterOccupants(w.id, 1, 'cafe', [a.id, b.id]));
  });

  it('composeLocationScene gives each occupant a templated activity', () => {
    const w = townWorld();
    const c = createCharacter({ worldId: w.id, name: 'Barista', age: 30, datingStats: DS });
    updateCharacter(c.id, {
      employment: { title: 'Barista', place: 'Cafe', locationId: 'cafe', shiftPhases: ['morning'], workdays: [0, 1, 2, 3, 4, 5, 6] },
    });

    const scene = composeLocationScene(w.id, 1, 'morning', 'cafe');
    const occ = scene.occupants.find((o) => o.characterId === c.id);
    expect(occ).toBeTruthy();
    expect(occ!.activity.length).toBeGreaterThan(0);
    expect(occ!.atWork).toBe(true);
  });
});
