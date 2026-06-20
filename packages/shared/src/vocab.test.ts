import { describe, it, expect } from 'vitest';
import {
  toExpression,
  MemoryTagArraySchema,
  isStoryFlag,
  SessionEvaluationSchema,
  TurnReactionSchema,
  MemoryCandidateSchema,
  CharacterMemorySchema,
} from './index';

describe('expressions are canonical', () => {
  it('coerces off-list values to neutral, keeps valid ones', () => {
    expect(toExpression('happy')).toBe('happy');
    expect(toExpression('ecstatic')).toBe('neutral'); // off-list
    expect(toExpression(undefined)).toBe('neutral');
  });

  it('the session evaluator coerces a stray expression to neutral (never fails the eval)', () => {
    const ok = SessionEvaluationSchema.parse({ mood: 'warm', expression: 'happy', summaryLine: 'a good night' });
    expect(ok.expression).toBe('happy');
    const stray = SessionEvaluationSchema.parse({ mood: 'wistful', expression: 'wistful', summaryLine: 'hm' });
    expect(stray.expression).toBe('neutral');
  });

  it('the per-turn judge coerces a stray expression to neutral', () => {
    expect(TurnReactionSchema.parse({ engagement: 2, expression: 'smug' }).expression).toBe('neutral');
    expect(TurnReactionSchema.parse({ engagement: 2, expression: 'shy' }).expression).toBe('shy');
  });
});

describe('memory tags are canonical', () => {
  it('drops off-list tags and keeps canonical ones', () => {
    expect(MemoryTagArraySchema.parse(['milestone', 'xyzzy', 'npc_life'])).toEqual(['milestone', 'npc_life']);
    expect(MemoryTagArraySchema.parse([])).toEqual([]);
  });

  it('the LLM memory candidate only keeps canonical tags', () => {
    const c = MemoryCandidateSchema.parse({ text: 'we laughed a lot', importance: 3, tags: ['sweet', 'garbage', 'funny'] });
    expect(c.tags).toEqual(['sweet', 'funny']);
  });

  it('a stored memory drops legacy/off-list tags on read', () => {
    const m = CharacterMemorySchema.parse({
      id: 'm1', characterId: 'c1', text: 'played a game', tags: ['minigame', 'timing_meter', 'date'], createdAt: 1,
    });
    expect(m.tags).toEqual(['minigame', 'date']); // 'timing_meter' (a game id) dropped
  });
});

describe('story flags are canonical', () => {
  it('recognizes canonical flags and rejects free-form / internal ones', () => {
    expect(isStoryFlag('firstKiss')).toBe(true);
    expect(isStoryFlag('engaged')).toBe(true);
    expect(isStoryFlag('wentDancing')).toBe(false);
    expect(isStoryFlag('state:offended')).toBe(false);
  });
});
