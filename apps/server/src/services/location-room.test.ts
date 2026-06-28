import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_DATING_STATS } from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { createWorld } from './world-service';
import { createCharacter, updateCharacter } from './character-service';
import { enterRoom, roomSay } from './room-service';
import { isDiscovered } from './discovery-service';
import { ensureWorldState } from './world-clock-service';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));
const DS = DEFAULT_DATING_STATS;
const scriptRoom = (reply: string, introduced: string[] = []) =>
  setAdapterOverride(new ScriptedAdapter([JSON.stringify({ reply, introduced })]));

/** A discovery world whose named regulars work the cafe on the MORNING shift, so the
 *  default (morning) block deterministically places them at 'cafe' — and the AFTERNOON
 *  block does not (they're off shift). */
function worldWithRegulars(names: string[]) {
  const w = createWorld({
    name: 'Town',
    featureFlags: { discovery: true },
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

describe('location room chat (discovery)', () => {
  it('entering a location costs one action and reports who is present', async () => {
    const { w, chars } = worldWithRegulars(['Mara']);
    scriptRoom('You step into the cafe.');
    const before = ensureWorldState(w.id).stamina;
    const res = await enterRoom(w.id, 'cafe');
    expect(res.occupants.some((o) => o.characterId === chars[0]!.id)).toBe(true);
    expect(ensureWorldState(w.id).stamina).toBe(before - 1);
  });

  it('PINS the room to the block you entered on, even though entering advances the clock', async () => {
    const { w, chars } = worldWithRegulars(['Mara']); // Mara is a morning regular only
    scriptRoom('You step in.');
    expect(ensureWorldState(w.id).phase).toBe('morning');

    const res = await enterRoom(w.id, 'cafe');
    expect(res.phase).toBe('morning'); // room pinned to the moment you walked in
    expect(res.occupants.some((o) => o.characterId === chars[0]!.id)).toBe(true); // Mara is here
    expect(ensureWorldState(w.id).phase).not.toBe('morning'); // the action advanced the clock
  });

  it('unlocks a character the model flags as introduced, and remembers the meeting', async () => {
    const { w, chars } = worldWithRegulars(['Mara']);
    const mara = chars[0]!;
    scriptRoom('She looks up. "Oh — I\'m Mara."', [mara.id]);

    const res = await roomSay(w.id, 'cafe', 1, 'morning', [], "Hi, I'm Sam — mind if I join you?");
    expect(res.introduced).toContain(mara.id);
    expect(isDiscovered(mara.id)).toBe(true);
  });

  it('scrubs an unmet character\'s name from the room prose (never leak identity)', async () => {
    const { w, chars } = worldWithRegulars(['Mara']);
    const mara = chars[0]!;
    scriptRoom('Mara keeps reading, not looking up.', []);

    const res = await roomSay(w.id, 'cafe', 1, 'morning', [], 'who is that by the window?');
    expect(res.reply).not.toContain('Mara');
    expect(isDiscovered(mara.id)).toBe(false);
  });

  it('ignores introduced ids for people who are not actually present', async () => {
    const { w } = worldWithRegulars(['Mara']);
    scriptRoom('No one by that name is here.', ['ghost-id']);

    const res = await roomSay(w.id, 'cafe', 1, 'morning', [], 'is Devi here?');
    expect(res.introduced).toEqual([]);
  });
});
