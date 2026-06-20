import { describe, it, expect, beforeEach } from 'vitest';
import { warmthOf, incompatibleWarmthCap, type Gender, type Sexuality } from '@dsim/shared';
import { resetDb } from '../test/helpers';
import { createWorld } from './world-service';
import { createCharacter } from './character-service';
import { updatePlayer } from './player-service';
import { applyRelationshipChange } from './stat-service';
import { getRelationship } from './relationship-service';
import { playerIdForWorld } from '../lib/ids';

beforeEach(() => resetDb());

const STATS = { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 };

/** Create a world, set the player's orientation, and add a character with one. */
function setup(
  player: { gender: Gender; sexuality: Sexuality },
  character: { gender: Gender; sexuality: Sexuality },
) {
  const world = createWorld({ name: 'W' });
  updatePlayer(player, playerIdForWorld(world.id));
  const c = createCharacter({ worldId: world.id, name: 'C', age: 27, datingStats: STATS, ...character });
  return { world, c };
}

/** Pile on warmth so the gate (if any) is forced to bite. */
function pourWarmth(characterId: string, times = 6) {
  for (let i = 0; i < times; i += 1) {
    applyRelationshipChange(
      characterId,
      { affection: 20, trust: 20, chemistry: 20, comfort: 20, respect: 20 },
      { source: 'test' },
    );
  }
}

describe('orientation compatibility gate', () => {
  it('caps warmth for an incompatible pair (straight man + lesbian) — never romantic', () => {
    const { c } = setup({ gender: 'male', sexuality: 'straight' }, { gender: 'female', sexuality: 'gay' });
    pourWarmth(c.id);
    expect(warmthOf(getRelationship(c.id))).toBeLessThanOrEqual(incompatibleWarmthCap());
  });

  it('lets a compatible pair grow warm past the romantic threshold', () => {
    const { c } = setup({ gender: 'male', sexuality: 'straight' }, { gender: 'female', sexuality: 'straight' });
    pourWarmth(c.id);
    expect(warmthOf(getRelationship(c.id))).toBeGreaterThan(incompatibleWarmthCap());
  });

  it('does not gate when either side is unspecified (opt-in)', () => {
    const { c } = setup({ gender: 'unspecified', sexuality: 'unspecified' }, { gender: 'female', sexuality: 'gay' });
    pourWarmth(c.id);
    expect(warmthOf(getRelationship(c.id))).toBeGreaterThan(incompatibleWarmthCap());
  });

  it('a bisexual partner is into the player regardless (straight man + bi woman)', () => {
    const { c } = setup({ gender: 'male', sexuality: 'straight' }, { gender: 'female', sexuality: 'bisexual' });
    pourWarmth(c.id);
    expect(warmthOf(getRelationship(c.id))).toBeGreaterThan(incompatibleWarmthCap());
  });
});

describe('orientation reveal', () => {
  it('the character reveals their orientation + queues a beat when SHE is not into the player', () => {
    const { c } = setup({ gender: 'male', sexuality: 'straight' }, { gender: 'female', sexuality: 'gay' });
    pourWarmth(c.id);
    const rel = getRelationship(c.id);
    expect(rel.flags['state:orientationRevealed']).toBe(true);
    expect(rel.flags['beat:pending']).toBe('orientation');
  });

  it('does NOT reveal when the PLAYER is the incompatible one (gay man + a woman into him)', () => {
    // The character (straight woman) IS attracted to the male player; the player just
    // isn't into her. It still caps, but there's no character reveal to make.
    const { c } = setup({ gender: 'male', sexuality: 'gay' }, { gender: 'female', sexuality: 'straight' });
    pourWarmth(c.id);
    const rel = getRelationship(c.id);
    expect(warmthOf(rel)).toBeLessThanOrEqual(incompatibleWarmthCap());
    expect(rel.flags['state:orientationRevealed']).toBeUndefined();
  });
});
