import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { addPlayerMessage, createSession, endSession, listSessions } from './conversation-service';
import { attemptDtr } from './dtr-service';
import { hasDated } from './text-message-service';
import { ensureWorldState } from './world-clock-service';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('an empty date does not count', () => {
  it('discards a date the player never spoke in — no stamina, not dated, no session row', async () => {
    const { world, character } = seedWorldAndCharacter();
    const before = ensureWorldState(world.id).stamina;
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });

    const res = await endSession(session.id); // no player messages → returns before any LLM call
    expect(res.evaluated).toBe(false);
    expect(ensureWorldState(world.id).stamina).toBe(before); // no daily action spent
    expect(hasDated(character.id)).toBe(false); // never became a contact → can't text you
    expect(listSessions().length).toBe(0); // phantom empty session removed
  });

  it('counts a date the player actually spoke in', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'hi there');
    expect(hasDated(character.id)).toBe(true);
  });

  it('refuses to advance the relationship (DTR) in a date with no player turn', async () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    // No player message → DTR must be rejected (else a "deleted" empty date could
    // still permanently climb the commitment ladder).
    await expect(attemptDtr(session.id)).rejects.toThrow(/say something/i);
  });
});
