import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { getRelationship } from './relationship-service';
import { applyRelationshipChange, setRelationshipFlag } from './stat-service';
import { maybeReachEnding, getEnding } from './ending-service';

/** Put a relationship at its committed peak (cohabiting + sweethearts + calm). */
function makePeak(characterId: string): void {
  setRelationshipFlag(characterId, 'status', 'cohabiting', { source: 'test' });
  applyRelationshipChange(
    characterId,
    { affection: 80, trust: 80, chemistry: 80, comfort: 80, respect: 80 }, // warmth ~85 → sweethearts
    { source: 'test' },
  );
}

const epilogue = (title: string) =>
  new ScriptedAdapter([JSON.stringify({ title, epilogue: 'You and them settled into a warm, easy life — and there is plenty of road still ahead.' })]);

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('happy endings', () => {
  it('reaches a one-time ending at the committed peak, then never re-generates', async () => {
    const { character } = seedWorldAndCharacter();
    makePeak(character.id);
    const adapter = epilogue('A Life in the Glasshouse');
    setAdapterOverride(adapter);

    const reached = await maybeReachEnding(character.id, { day: 5, mode: 'date' });
    expect(reached).not.toBeNull();
    expect(reached!.title).toBe('A Life in the Glasshouse');
    expect(getEnding(character.id)?.epilogue).toContain('ahead'); // persisted

    const callsAfterFirst = adapter.calls;
    const again = await maybeReachEnding(character.id, { day: 6, mode: 'date' });
    expect(again).toBeNull(); // already reached
    expect(adapter.calls).toBe(callsAfterFirst); // no second LLM call
  });

  it('does not fire (or call the LLM) when the peak is not met', async () => {
    const { character } = seedWorldAndCharacter(); // status none, low warmth
    const adapter = epilogue('Nope');
    setAdapterOverride(adapter);
    expect(await maybeReachEnding(character.id, { day: 2, mode: 'date' })).toBeNull();
    expect(adapter.calls).toBe(0);
    expect(getEnding(character.id)).toBeUndefined();
  });

  it('does not fire while things are tense, even at the top of the ladder', async () => {
    const { character } = seedWorldAndCharacter();
    makePeak(character.id);
    applyRelationshipChange(character.id, { tension: 70 }, { source: 'test' }); // strained
    setAdapterOverride(epilogue('Should not happen'));
    expect(await maybeReachEnding(character.id, { day: 5, mode: 'date' })).toBeNull();
    expect(getEnding(character.id)).toBeUndefined();
  });
});
