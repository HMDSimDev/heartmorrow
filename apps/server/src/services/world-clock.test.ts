import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import {
  advanceDay,
  assertCanAct,
  ensureWorldState,
  getWorldState,
  spendStamina,
} from './world-clock-service';
import { createSession } from './conversation-service';
import { getRelationship } from './relationship-service';
import { stampLastSeen } from './stat-service';
import { worldStatesRepo } from '../db/repositories';

beforeEach(() => resetDb());

describe('world clock — stamina', () => {
  it('starts a world at Day 1 with full stamina and morning phase', () => {
    const { world } = seedWorldAndCharacter();
    const state = ensureWorldState(world.id);
    expect(state.day).toBe(1);
    expect(state.stamina).toBe(state.staminaMax);
    expect(state.phase).toBe('morning');
  });

  it('spends stamina and advances the time-of-day phase', () => {
    const { world } = seedWorldAndCharacter();
    expect(spendStamina(world.id).phase).toBe('afternoon');
    expect(spendStamina(world.id).phase).toBe('evening');
    const last = spendStamina(world.id);
    expect(last.stamina).toBe(0);
    expect(last.phase).toBe('night');
  });

  it('blocks a date when out of stamina, then allows it again after sleep', async () => {
    const { world, character } = seedWorldAndCharacter();
    spendStamina(world.id);
    spendStamina(world.id);
    spendStamina(world.id); // stamina now 0
    expect(() => assertCanAct(world.id)).toThrow(/energy/i);
    expect(() => createSession({ characterId: character.id, mode: 'date', locationId: null })).toThrow(/energy/i);

    const sleep = await advanceDay(world.id);
    expect(sleep.state.day).toBe(2);
    expect(sleep.state.stamina).toBe(sleep.state.staminaMax);
    // A date is allowed again on the new day.
    expect(() => createSession({ characterId: character.id, mode: 'date', locationId: null })).not.toThrow();
  });
});

describe('world clock — weekends', () => {
  it('raises the stamina CAP to 4/4 (not 4/3), and the first weekend action still advances the phase', async () => {
    const { world } = seedWorldAndCharacter();
    // Force the clock to Friday (day 5) so the next Sleep lands on Saturday (day 6).
    const s = getWorldState(world.id);
    worldStatesRepo.update({ ...s, day: 5 });
    const sat = await advanceDay(world.id);

    expect(sat.state.day).toBe(6);
    expect(sat.calendar?.isWeekend).toBe(true);
    expect(sat.state.staminaMax).toBe(4); // the CAP is raised, not just the pool…
    expect(sat.state.stamina).toBe(4); // …so stamina never exceeds its own max
    // Because the budget is now 4 (not 3), the FIRST action advances morning→afternoon
    // instead of registering spent=0 and getting stuck on morning.
    expect(spendStamina(world.id).phase).toBe('afternoon');
  });

  it('reverts the cap to 3/3 on the next weekday', async () => {
    const { world } = seedWorldAndCharacter();
    const s = getWorldState(world.id);
    worldStatesRepo.update({ ...s, day: 7 }); // Sunday
    const mon = await advanceDay(world.id); // → day 8 = Monday

    expect(mon.calendar?.isWeekend).toBe(false);
    expect(mon.state.staminaMax).toBe(3);
    expect(mon.state.stamina).toBe(3);
  });
});

describe('world clock — passage of time', () => {
  it('decays neglected relationships after the grace window', async () => {
    const { world, character } = seedWorldAndCharacter();
    // Pretend the character was last seen on day 1, and the clock is at day 15.
    stampLastSeen(character.id, 1);
    const s = getWorldState(world.id);
    worldStatesRepo.update({ ...s, day: 15 });

    const baseline = getRelationship(character.id).affection;
    const sleep = await advanceDay(world.id); // -> day 16, 15 days since seen (>= 14)

    expect(sleep.decayed.some((d) => d.characterId === character.id)).toBe(true);
    expect(getRelationship(character.id).affection).toBe(baseline - 1);
  });

  it('does not decay a character seen recently', async () => {
    const { world, character } = seedWorldAndCharacter();
    stampLastSeen(character.id, 1);
    const baseline = getRelationship(character.id).affection;
    const sleep = await advanceDay(world.id); // day 1 -> 2, only 1 day since seen
    expect(sleep.decayed.length).toBe(0);
    expect(getRelationship(character.id).affection).toBe(baseline);
  });
});
