import { describe, it, expect, beforeEach } from 'vitest';
import { CharacterEndingSchema, DEFAULT_PLAYER_ID } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { endingsRepo } from '../db/repositories';
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

  it('keeps the whole arc: breakups, reconciliations, anniversaries, and the ending', () => {
    const { character } = seedWorldAndCharacter();
    recordEvent('breakup', { characterId: character.id, fromStatus: 'exclusive', day: 5, initiator: 'character' });
    recordEvent('reconciled', { characterId: character.id, day: 12 });
    recordEvent('anniversary_date', { characterId: character.id, day: 30, kind: 'dating', seasons: 1 });
    // The ending comes from the DURABLE endings table, not the event log.
    endingsRepo.insert(
      CharacterEndingSchema.parse({
        characterId: character.id,
        playerId: DEFAULT_PLAYER_ID,
        title: 'A Life in the Glasshouse',
        epilogue: 'A warm, easy life together.',
        day: 40,
        createdAt: Date.now(),
      }),
    );

    const moments = getMoments(character.id);
    expect(moments.find((m) => m.kind === 'breakup')?.title).toBe('They ended things');
    expect(moments.find((m) => m.kind === 'status' && /way back/.test(m.title))).toBeTruthy();
    expect(moments.find((m) => m.kind === 'anniversary')?.title).toBe('Your first anniversary');
    const ending = moments.find((m) => m.kind === 'ending');
    expect(ending?.title).toContain('A Life in the Glasshouse');
    expect(ending?.day).toBe(40);
    // The epilogue prose itself stays in the Endings gallery, uncopied.
    expect(ending?.body).not.toContain('easy life together');
  });
});
