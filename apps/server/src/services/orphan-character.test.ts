import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../test/helpers';
import { createWorld } from './world-service';
import { createCharacter, updateCharacter, listCharacters } from './character-service';

beforeEach(() => resetDb());

const STATS = { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 };

describe('world-less ("unassigned") characters are recoverable', () => {
  it('a character created with no world is hidden from a world roster but still findable, and can be re-homed', () => {
    const world = createWorld({ name: 'Quarter' });
    const orphan = createCharacter({ worldId: null, name: 'Nobody', age: 25, datingStats: STATS });

    expect(orphan.worldId).toBeNull();
    // It does NOT appear in the world's scoped roster…
    expect(listCharacters(world.id).some((c) => c.id === orphan.id)).toBe(false);
    // …but the unscoped list (what the People page fetches) still has it, so it's not lost.
    expect(listCharacters().some((c) => c.id === orphan.id)).toBe(true);

    // Recovery: placing it into a world makes it part of that roster.
    const placed = updateCharacter(orphan.id, { worldId: world.id });
    expect(placed.worldId).toBe(world.id);
    expect(listCharacters(world.id).some((c) => c.id === orphan.id)).toBe(true);
  });
});
