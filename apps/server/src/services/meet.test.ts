import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_DATING_STATS } from '@dsim/shared';
import { resetDb } from '../test/helpers';
import { createWorld } from './world-service';
import { createCharacter, updateCharacter } from './character-service';
import { updateLlmSettings } from './settings-service';
import { addPlayerMessage, createSession, endSession, getActiveDateForWorld } from './conversation-service';
import { isDiscovered } from './discovery-service';
import { listMemories } from './memory-service';

beforeEach(() => {
  resetDb();
  updateLlmSettings({ discoveryMode: true }); // the Meet only matters when discovery is active
});
const DS = DEFAULT_DATING_STATS;

/** A discovery world whose named characters all work the cafe on the morning shift, so
 *  placement deterministically puts them at 'cafe' in the default (morning) time-block. */
function worldWithRegulars(names: string[]) {
  const w = createWorld({
    name: 'Town',
    locations: [{ id: 'cafe', name: 'The Glasshouse', kind: 'cafe' }],
  });
  const chars = names.map((n) => createCharacter({ worldId: w.id, name: n, age: 28, datingStats: DS }));
  for (const c of chars) {
    updateCharacter(c.id, {
      employment: { title: 'Regular', place: 'cafe', locationId: 'cafe', shiftPhases: ['morning'], workdays: [0, 1, 2, 3, 4, 5, 6] },
    });
  }
  return { w, chars };
}

describe('the Meet (Phase 3)', () => {
  it('is presence-gated — only startable where the character actually is', () => {
    const { chars } = worldWithRegulars(['Mara']);
    const c = chars[0]!;
    expect(() => createSession({ characterId: c.id, mode: 'meet', locationId: 'park' })).toThrow(/here/i);
    expect(createSession({ characterId: c.id, mode: 'meet', locationId: 'cafe' }).mode).toBe('meet');
  });

  it('counts as an active session and cannot be stacked on another', () => {
    const { w, chars } = worldWithRegulars(['Mara', 'Bo']);
    createSession({ characterId: chars[0]!.id, mode: 'meet', locationId: 'cafe' });
    expect(getActiveDateForWorld(w.id)?.mode).toBe('meet');
    expect(() => createSession({ characterId: chars[1]!.id, mode: 'meet', locationId: 'cafe' })).toThrow(/wrap up/i);
  });

  it('unlocks the character + writes a memory, with no evaluator', async () => {
    const { chars } = worldWithRegulars(['Mara']);
    const c = chars[0]!;
    const s = createSession({ characterId: c.id, mode: 'meet', locationId: 'cafe' });
    addPlayerMessage(s.id, "Hi — I'm new around here.");
    const res = await endSession(s.id);

    expect(res.evaluated).toBe(false); // evaluator-less
    expect(isDiscovered(c.id)).toBe(true); // revealed + dateable
    expect(listMemories(c.id).length).toBeGreaterThan(0); // rolled into memory
  });

  it('does not unlock if you never speak (the empty meet is discarded)', async () => {
    const { chars } = worldWithRegulars(['Mara']);
    const c = chars[0]!;
    const s = createSession({ characterId: c.id, mode: 'meet', locationId: 'cafe' });
    await endSession(s.id);
    expect(isDiscovered(c.id)).toBe(false);
  });
});
