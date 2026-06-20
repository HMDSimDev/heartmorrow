import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_DATING_STATS } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { createCharacter } from './character-service';
import { getWorldAvailability } from './availability-service';
import { performActivity } from './activity-service';
import { ensureWorldState } from './world-clock-service';
import { getOrCreatePlayer } from './player-service';
import { getRelationship } from './relationship-service';
import { playerIdForWorld } from '../lib/ids';

beforeEach(() => resetDb());

describe('availability (Do Not Disturb)', () => {
  it('always leaves at least one character available (guard)', () => {
    const { world } = seedWorldAndCharacter();
    createCharacter({ worldId: world.id, name: 'Second', age: 25, datingStats: DEFAULT_DATING_STATS });
    createCharacter({ worldId: world.id, name: 'Third', age: 30, datingStats: DEFAULT_DATING_STATS });
    for (let day = 1; day <= 60; day += 1) {
      const av = getWorldAvailability(world.id, day);
      expect(av.length).toBe(3);
      expect(av.some((a) => a.available)).toBe(true);
    }
  });

  it('is deterministic for a given (world, day)', () => {
    const { world } = seedWorldAndCharacter();
    createCharacter({ worldId: world.id, name: 'Second', age: 25, datingStats: DEFAULT_DATING_STATS });
    expect(getWorldAvailability(world.id, 9)).toEqual(getWorldAvailability(world.id, 9));
  });

  it('unavailable entries carry a reason', () => {
    const { world } = seedWorldAndCharacter();
    createCharacter({ worldId: world.id, name: 'Second', age: 25, datingStats: DEFAULT_DATING_STATS });
    let foundUnavailable = false;
    for (let day = 1; day <= 60 && !foundUnavailable; day += 1) {
      for (const a of getWorldAvailability(world.id, day)) {
        if (!a.available) {
          expect(typeof a.reason).toBe('string');
          foundUnavailable = true;
        }
      }
    }
    expect(foundUnavailable).toBe(true);
  });
});

describe('activities (work / training)', () => {
  it('work earns money into the per-world wallet and spends one stamina', () => {
    const { world } = seedWorldAndCharacter();
    const playerId = playerIdForWorld(world.id);
    const beforeMoney = getOrCreatePlayer(playerId).money;
    const beforeStamina = ensureWorldState(world.id).stamina;
    const res = performActivity({ activityId: 'work_shift', worldId: world.id, characterId: null });
    expect(res.money).toBeGreaterThan(0);
    expect(getOrCreatePlayer(playerId).money).toBe(beforeMoney + res.money);
    expect(ensureWorldState(world.id).stamina).toBe(beforeStamina - 1);
  });

  it('training improves a relationship stat and requires a character', () => {
    const { world, character } = seedWorldAndCharacter();
    expect(() => performActivity({ activityId: 'bond_talk', worldId: world.id, characterId: null })).toThrow();
    const beforeTrust = getRelationship(character.id).trust;
    performActivity({ activityId: 'bond_talk', worldId: world.id, characterId: character.id });
    expect(getRelationship(character.id).trust).toBeGreaterThan(beforeTrust);
  });

  it('rejects an unknown activity', () => {
    const { world } = seedWorldAndCharacter();
    expect(() => performActivity({ activityId: 'nope', worldId: world.id, characterId: null })).toThrow();
  });
});
