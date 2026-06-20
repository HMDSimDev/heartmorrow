import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { recordEvent } from './event-service';
import { addManualMemory } from './memory-service';
import { getMoments } from './moments-service';

beforeEach(() => resetDb());

describe('moments timeline', () => {
  it('assembles cards from this character\'s events + keepsake memories, newest first', () => {
    const { character } = seedWorldAndCharacter();
    recordEvent('session_eval', { characterId: character.id, mood: 'happy', summaryLine: 'A lovely first date.', day: 1 });
    recordEvent('milestone_reached', { characterId: character.id, band: 'getting-close', label: 'getting close', day: 2 });
    recordEvent('daily_texts_generated', { characterId: character.id }); // not a "moment" → filtered out
    recordEvent('session_eval', { characterId: 'someone-else', summaryLine: 'unrelated' }); // other character → excluded by query
    addManualMemory(character.id, { text: 'They love sunflowers.', importance: 5, tags: [] });

    const moments = getMoments(character.id);
    const kinds = moments.map((m) => m.kind);
    expect(kinds).toContain('date');
    expect(kinds).toContain('milestone');
    expect(kinds).toContain('memory');
    // Only this character's mappable events + the keepsake memory (3 total).
    expect(moments).toHaveLength(3);
    expect(moments.every((m) => m.body !== 'unrelated')).toBe(true);
    // Sorted newest-first.
    for (let i = 1; i < moments.length; i++) {
      expect(moments[i - 1]!.createdAt >= moments[i]!.createdAt).toBe(true);
    }
  });
});
