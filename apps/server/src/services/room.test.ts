import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { ensureRoomDescription, getCharacter } from './character-service';
import { resolveSessionLocation } from './conversation-service';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('character private room', () => {
  it('generates + persists a room description once (idempotent, no re-gen)', async () => {
    const { character } = seedWorldAndCharacter();
    const adapter = new ScriptedAdapter([
      JSON.stringify({ description: 'A sunlit loft crowded with potted ferns and stacked records.' }),
    ]);
    setAdapterOverride(adapter);

    const first = await ensureRoomDescription(character.id);
    expect(first).toContain('loft');
    expect(getCharacter(character.id).roomDescription).toBe(first);

    const callsAfterFirst = adapter.calls;
    const second = await ensureRoomDescription(character.id);
    expect(second).toBe(first);
    expect(adapter.calls).toBe(callsAfterFirst); // cached — no second LLM call
  });

  it("resolves a room:* location to the character's indoor private room", () => {
    const { character } = seedWorldAndCharacter();
    const c = { ...getCharacter(character.id), roomDescription: 'A snug attic studio.' };
    const loc = resolveSessionLocation(`room:${character.id}`, c, null);
    expect(loc).not.toBeNull();
    expect(loc!.indoor).toBe(true);
    expect(loc!.name).toBe(`${character.name}'s Room`);
    expect(loc!.description).toBe('A snug attic studio.');
  });

  it('falls back to a generic description before one is generated', () => {
    const { character } = seedWorldAndCharacter();
    const loc = resolveSessionLocation(`room:${character.id}`, getCharacter(character.id), null);
    expect(loc!.indoor).toBe(true);
    expect(loc!.description.length).toBeGreaterThan(0);
  });

  it('falls safe (empty) if the model can\'t produce a description', async () => {
    const { character } = seedWorldAndCharacter();
    setAdapterOverride(new ScriptedAdapter(['not json at all'])); // structured parse fails
    expect(await ensureRoomDescription(character.id)).toBe('');
    expect(getCharacter(character.id).roomDescription).toBe('');
  });
});
