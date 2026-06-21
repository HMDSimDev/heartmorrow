import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_DATING_STATS } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { createCharacter } from './character-service';
import { getWorldAvailability } from './availability-service';
import { performActivity } from './activity-service';
import { ensureWorldState } from './world-clock-service';
import { getOrCreatePlayer } from './player-service';
import { getRelationship } from './relationship-service';
import { applyRelationshipChange } from './stat-service';
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

describe('activities (work / together)', () => {
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

  it('time together improves a relationship stat and requires a character', () => {
    const { world, character } = seedWorldAndCharacter();
    // tg_in (a quiet night in) is the zero-risk option, so it always lands.
    expect(() => performActivity({ activityId: 'tg_in', worldId: world.id, characterId: null })).toThrow();
    const beforeComfort = getRelationship(character.id).comfort;
    const res = performActivity({ activityId: 'tg_in', worldId: world.id, characterId: character.id });
    expect(res.kind).toBe('together');
    expect(res.together).toBeTruthy();
    expect(getRelationship(character.id).comfort).toBeGreaterThan(beforeComfort);
  });

  it('a per-person daily cap makes repeats fizzle, then crowd', () => {
    const { world, character } = seedWorldAndCharacter();
    const c0 = getRelationship(character.id).comfort;
    performActivity({ activityId: 'tg_in', worldId: world.id, characterId: character.id });
    const c1 = getRelationship(character.id).comfort;
    performActivity({ activityId: 'tg_in', worldId: world.id, characterId: character.id });
    const c2 = getRelationship(character.id).comfort;
    // The second outing the same day gives strictly less than the first.
    expect(c1 - c0).toBeGreaterThan(0);
    expect(c2 - c1).toBeLessThan(c1 - c0);
    // A third outing the same day crowds them: no warmth, and it grates.
    const t2 = getRelationship(character.id).tension;
    const res3 = performActivity({ activityId: 'tg_in', worldId: world.id, characterId: character.id });
    expect(res3.together!.outcome).toBe('crowded');
    expect(getRelationship(character.id).comfort).toBe(c2);
    expect(getRelationship(character.id).tension).toBeGreaterThan(t2);
  });

  it('casual time stalls at the soft ceiling — only a real date goes deeper', () => {
    const { world, character } = seedWorldAndCharacter();
    // Nudge comfort to the brink of the getting-close band (45).
    applyRelationshipChange(character.id, { comfort: 39 }, { source: 'test' });
    const atCeiling = getRelationship(character.id).comfort;
    const res = performActivity({ activityId: 'tg_in', worldId: world.id, characterId: character.id });
    expect(res.together!.outcome).toBe('flat');
    expect(getRelationship(character.id).comfort).toBe(atCeiling); // easy time can't push past it
  });

  it('rejects an unknown activity', () => {
    const { world } = seedWorldAndCharacter();
    expect(() => performActivity({ activityId: 'nope', worldId: world.id, characterId: null })).toThrow();
  });
});

describe('work jobs: stamina cost + variable pay', () => {
  it('a heavy shift spends two actions and is refused when the day cannot afford it', () => {
    const { world } = seedWorldAndCharacter();
    const before = ensureWorldState(world.id).stamina; // 3 on a fresh weekday
    const res = performActivity({ activityId: 'job_weatherwork', worldId: world.id, characterId: null });
    expect(res.money).toBeGreaterThan(0);
    expect(ensureWorldState(world.id).stamina).toBe(before - 2);
    // Only one action left — a 2-action shift must be refused, not silently clamped.
    expect(() => performActivity({ activityId: 'job_weatherwork', worldId: world.id, characterId: null })).toThrow();
    // ...and the refusal didn't quietly spend the remaining action.
    expect(ensureWorldState(world.id).stamina).toBe(before - 2);
  });

  it('a gig pays an uneven cut, always within its variance band', () => {
    const { world } = seedWorldAndCharacter();
    const lo = Math.round(68 * (1 - 0.6)); // floor can dip below a steady shift
    const hi = Math.round(68 * (1 + 0.6)); // ceiling beats it
    for (let i = 0; i < 3; i += 1) {
      const pay = performActivity({ activityId: 'odd_jobs', worldId: world.id, characterId: null }).money;
      expect(pay).toBeGreaterThanOrEqual(lo);
      expect(pay).toBeLessThanOrEqual(hi);
    }
  });
});
