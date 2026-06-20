import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CHRONICLE_FOLD_EVERY } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { appendSessionToChronicle, getChronicle, foldChronicle } from './chronicle-service';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('chronicle', () => {
  it('accumulates date highlights as recent lines', () => {
    const { character } = seedWorldAndCharacter();
    appendSessionToChronicle(character.id, 'A lovely first walk by the river.', 'date', 1);
    appendSessionToChronicle(character.id, 'Shared coffee and old stories.', 'date', 2);
    const c = getChronicle(character.id);
    expect(c.sessionCount).toBe(2);
    expect(c.recentLines.length).toBe(2);
    expect(c.recentLines[0]!.line).toMatch(/river/);
  });

  it('folds recent lines into the narrative and clears the buffer', async () => {
    const { character } = seedWorldAndCharacter();
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ chronicle: 'A warm history of growing closer over several dates.', highlights: [] })]));
    for (let i = 1; i <= CHRONICLE_FOLD_EVERY; i += 1) {
      appendSessionToChronicle(character.id, `Date number ${i} went well.`, 'date', i);
    }
    // The append at the threshold kicks off a background fold; run it deterministically too.
    await foldChronicle(character.id);
    const c = getChronicle(character.id);
    expect(c.chronicle).toMatch(/history/i);
    expect(c.recentLines.length).toBe(0);
    expect(c.sessionCount).toBe(CHRONICLE_FOLD_EVERY);
  });
});
