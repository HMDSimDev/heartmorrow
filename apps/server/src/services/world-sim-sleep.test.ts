import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WorldSimResult } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { advanceDay, registerClockHooks, ensureWorldState } from './world-clock-service';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

const recap = (o: object) => new ScriptedAdapter([JSON.stringify(o)]);
const RECAP_OK = { headline: 'Day done', narrative: 'A day passed.', highlights: [] };

describe('synchronous Sleep pass (Phase 4)', () => {
  it('awaits the world-sim once and surfaces its beats in the Sleep response', async () => {
    const { world } = seedWorldAndCharacter();
    ensureWorldState(world.id);
    let calls = 0;
    let seenDay = 0;
    registerClockHooks({
      onWorldSim: (_wid, day): WorldSimResult => {
        calls += 1;
        seenDay = day;
        return { day, beats: [{ kind: 'met', summary: 'Ava ran into Bo.' }], newLinks: [] };
      },
    });
    const adapter = recap(RECAP_OK); // beats route the recap through the (stubbed) LLM
    setAdapterOverride(adapter);

    const res = await advanceDay(world.id);

    expect(calls).toBe(1); // exactly one world-sim call per Sleep
    expect(seenDay).toBe(1); // simulated the day that ENDED (day 1), not the new day
    expect(res.state.day).toBe(2);
    expect(res.worldSim?.beats[0]?.summary).toBe('Ava ran into Bo.');
    // Budget tripwire: the synchronous Sleep path makes ONE LLM call (the recap).
    // The per-actor gossip/feed/text generators must stay OFF this path.
    expect(adapter.calls).toBe(1);
  });

  it('runs the world-sim for each ended day across a multi-day skip', async () => {
    const { world } = seedWorldAndCharacter();
    ensureWorldState(world.id);
    const days: number[] = [];
    // Empty beats + no player events → quiet-day recap, so no LLM is needed here.
    registerClockHooks({
      onWorldSim: (_w, day): WorldSimResult => {
        days.push(day);
        return { day, beats: [], newLinks: [] };
      },
    });

    await advanceDay(world.id); // ends day 1
    await advanceDay(world.id); // ends day 2
    await advanceDay(world.id); // ends day 3

    expect(days).toEqual([1, 2, 3]);
  });

  it('still advances the day when the world-sim throws (best-effort)', async () => {
    const { world } = seedWorldAndCharacter();
    ensureWorldState(world.id);
    registerClockHooks({
      onWorldSim: () => {
        throw new Error('boom');
      },
    });

    const res = await advanceDay(world.id); // no beats → quiet day → no LLM
    expect(res.state.day).toBe(2);
    expect(res.worldSim).toBeNull();
  });
});
