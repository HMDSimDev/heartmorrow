import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MinigameRewardSchema } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { getRelationship } from './relationship-service';
import { applyRelationshipChange } from './stat-service';
import { listMemories } from './memory-service';
import { getChronicle } from './chronicle-service';
import { createCharacter } from './character-service';
import { startMinigame, finishMinigame, _resetRuns } from './minigame-service';
import { scaleReward } from '../minigames/registry';
import { sweetAndSourModule } from '../minigames/sweet-and-sour';
import { twoTruthsModule } from '../minigames/two-truths-a-lie';
import { rhythmSerenadeModule } from '../minigames/rhythm-serenade';

beforeEach(() => {
  resetDb();
  _resetRuns();
});
afterEach(() => setAdapterOverride(null));

// --- Scoring units (resolve is pure; no run/LLM needed) ---------------------

describe('sweet_and_sour scoring', () => {
  const state = { answerKey: { a: 'adore', b: 'avoid', c: 'meh', d: 'adore' }, total: 4 };

  it('a confident, fully-correct sort scores 100', () => {
    const res = sweetAndSourModule.resolve(
      {
        placements: [
          { cardId: 'a', tray: 'adore', confidence: 1, swipeMs: 500 },
          { cardId: 'b', tray: 'avoid', confidence: 1, swipeMs: 500 },
          { cardId: 'c', tray: 'meh', confidence: 1, swipeMs: 500 },
          { cardId: 'd', tray: 'adore', confidence: 1, swipeMs: 500 },
        ],
      },
      state,
    );
    expect(res.score).toBe(100);
    expect(res.grade).toBe('S');
  });

  it('drops phantom cards, dedupes, and penalizes confident wrong guesses', () => {
    const res = sweetAndSourModule.resolve(
      {
        placements: [
          { cardId: 'a', tray: 'adore', confidence: 1, swipeMs: 0 }, // correct
          { cardId: 'a', tray: 'avoid', confidence: 1, swipeMs: 0 }, // dup → ignored
          { cardId: 'b', tray: 'adore', confidence: 1, swipeMs: 0 }, // confident-wrong
          { cardId: 'zzz', tray: 'adore', confidence: 1, swipeMs: 0 }, // phantom → ignored
        ],
      },
      state,
    );
    // denominator is the server's fixed total (4), so partial play can't hit 100
    expect(res.score).toBeLessThan(100);
    expect(res.score).toBeGreaterThanOrEqual(0);
  });
});

describe('two_truths_a_lie scoring', () => {
  const state = {
    lieKey: { r1: 's1b', r2: 's2c' },
    statements: { r1: ['s1a', 's1b', 's1c'], r2: ['s2a', 's2b', 's2c'] },
  };

  it('reading both lies on a high wager scores 100 and adds no tension', () => {
    const res = twoTruthsModule.resolve(
      {
        rounds: [
          { roundId: 'r1', accusedStatementId: 's1b', confidence: 'high' },
          { roundId: 'r2', accusedStatementId: 's2c', confidence: 'high' },
        ],
      },
      state,
    );
    expect(res.score).toBe(100);
    expect(res.reward.relationship.tension ?? 0).toBe(0);
  });

  it('being fooled on a high wager tanks the score and raises tension', () => {
    const res = twoTruthsModule.resolve(
      {
        rounds: [
          { roundId: 'r1', accusedStatementId: 's1a', confidence: 'high' },
          { roundId: 'r2', accusedStatementId: 's2a', confidence: 'high' },
        ],
      },
      state,
    );
    expect(res.score).toBe(0);
    expect(res.reward.relationship.tension ?? 0).toBeGreaterThan(0);
  });

  it('ignores phantom rounds and accusations outside the round', () => {
    const res = twoTruthsModule.resolve(
      {
        rounds: [
          { roundId: 'nope', accusedStatementId: 'x', confidence: 'high' },
          { roundId: 'r1', accusedStatementId: 'not-in-round', confidence: 'low' },
        ],
      },
      state,
    );
    expect(res.score).toBe(0);
  });
});

describe('rhythm_serenade scoring', () => {
  const state = {
    beatSlots: [0, 1, 3],
    restSlots: [2],
    hitWindowMs: 180,
    perfectMs: 45,
    comboStep: 0.08,
    maxComboMult: 1.5,
    beatCount: 4,
  };

  it('perfect taps on beats, resting on rests, scores 100', () => {
    const res = rhythmSerenadeModule.resolve(
      { taps: [{ slotIndex: 0, offsetMs: 0 }, { slotIndex: 1, offsetMs: 0 }, { slotIndex: 3, offsetMs: 0 }], totalMs: 3000 },
      state,
    );
    expect(res.score).toBe(100);
  });

  it('tapping a rest slot costs and breaks the combo', () => {
    const res = rhythmSerenadeModule.resolve(
      {
        taps: [
          { slotIndex: 0, offsetMs: 0 },
          { slotIndex: 1, offsetMs: 0 },
          { slotIndex: 2, offsetMs: 0 }, // rest — penalty
          { slotIndex: 3, offsetMs: 0 },
        ],
        totalMs: 3000,
      },
      state,
    );
    expect(res.score).toBeLessThan(100);
  });

  it('clamps duplicate / out-of-range / non-finite taps to a sane 0..100', () => {
    const res = rhythmSerenadeModule.resolve(
      {
        taps: [
          { slotIndex: 0, offsetMs: 0 },
          { slotIndex: 0, offsetMs: 0 }, // dup
          { slotIndex: 99, offsetMs: 0 }, // out of range
          { slotIndex: 1, offsetMs: Number.POSITIVE_INFINITY }, // coerced
        ],
        totalMs: 1000,
      },
      state,
    );
    expect(res.score).toBeGreaterThanOrEqual(0);
    expect(res.score).toBeLessThanOrEqual(100);
  });
});

// --- scaleReward: grade is load-bearing, negatives are kept -----------------

describe('scaleReward', () => {
  const base = MinigameRewardSchema.parse({ dating: { charm: 5 }, relationship: { trust: 5, tension: -3 }, money: 40 });

  it('an F earns no positive rewards or money', () => {
    const f = scaleReward(base, 'F');
    expect(f.dating.charm ?? 0).toBe(0);
    expect(f.money).toBe(0);
  });
  it('keeps negative consequences regardless of grade', () => {
    expect(scaleReward(base, 'F').relationship.tension).toBe(-3);
    expect(scaleReward(base, 'S').relationship.tension).toBe(-3);
  });
  it('an S keeps the full positive reward', () => {
    expect(scaleReward(base, 'S').dating.charm).toBe(5);
  });
});

// --- "Mattering": memory, chronicle, reaction, flop, milestone, favorite ----

describe('minigames matter', () => {
  it('a good play with someone leaves a reaction, a memory, and a chronicle line', async () => {
    const { character } = seedWorldAndCharacter();
    const start = await startMinigame({ minigameId: 'memory_match', characterId: character.id, worldId: null });
    const cfg = start.config as { totalPairs: number };
    const res = finishMinigame({
      runId: start.runId,
      submission: { minigameId: 'memory_match', submission: { pairsMatched: cfg.totalPairs, moves: cfg.totalPairs, timeMs: 3000 } },
    });

    expect(['S', 'A', 'B']).toContain(res.result.grade);
    expect(res.reaction).not.toBeNull();
    expect(['delighted', 'warm']).toContain(res.reaction!.tone);
    expect(listMemories(character.id).some((m) => m.tags.includes('minigame'))).toBe(true);
    expect(getChronicle(character.id).recentLines.some((l) => l.mode === 'minigame')).toBe(true);
  });

  it('a flop stings (comfort down, tension up), reacts disappointed, and writes no memory', async () => {
    const { character } = seedWorldAndCharacter();
    applyRelationshipChange(character.id, { comfort: 30, tension: 10 }, { source: 'test' });
    const before = getRelationship(character.id);
    const start = await startMinigame({ minigameId: 'memory_match', characterId: character.id, worldId: null });
    const res = finishMinigame({
      runId: start.runId,
      submission: { minigameId: 'memory_match', submission: { pairsMatched: 0, moves: 0, timeMs: 0 } },
    });
    const after = getRelationship(character.id);
    expect(res.result.grade).toBe('F');
    expect(res.reaction!.tone).toBe('disappointed');
    expect(after.comfort).toBeLessThan(before.comfort);
    expect(after.tension).toBeGreaterThan(before.tension);
    expect(listMemories(character.id).some((m) => m.tags.includes('minigame'))).toBe(false);
  });

  it('a solo play has no character reaction', async () => {
    const start = await startMinigame({ minigameId: 'memory_match', characterId: null, worldId: null });
    const res = finishMinigame({
      runId: start.runId,
      submission: { minigameId: 'memory_match', submission: { pairsMatched: 0, moves: 0, timeMs: 0 } },
    });
    expect(res.reaction).toBeNull();
    expect(res.relationship).toBeNull();
  });

  it('a great game night can tip a relationship milestone', async () => {
    const { character } = seedWorldAndCharacter();
    const r = getRelationship(character.id);
    // Sit just below the "getting-close" band (warmth 45) on all five warmth stats.
    applyRelationshipChange(
      character.id,
      { affection: 44 - r.affection, trust: 44 - r.trust, chemistry: 44 - r.chemistry, comfort: 44 - r.comfort, respect: 44 - r.respect },
      { source: 'test' },
    );
    const start = await startMinigame({ minigameId: 'memory_match', characterId: character.id, worldId: null });
    const cfg = start.config as { totalPairs: number };
    const res = finishMinigame({
      runId: start.runId,
      submission: { minigameId: 'memory_match', submission: { pairsMatched: cfg.totalPairs, moves: cfg.totalPairs, timeMs: 3000 } },
    });
    expect(res.milestone).not.toBeNull();
    expect(res.milestone!.band).toBe('getting-close');
  });

  it('flags when you play their favorite kind of game', async () => {
    const { world } = seedWorldAndCharacter();
    const fav = createCharacter({
      worldId: world.id,
      name: 'Stylist',
      age: 26,
      datingStats: { charm: 10, empathy: 10, humor: 10, confidence: 10, intellect: 10, style: 90 },
    });
    const start = await startMinigame({ minigameId: 'memory_match', characterId: fav.id, worldId: null });
    const cfg = start.config as { totalPairs: number };
    const res = finishMinigame({
      runId: start.runId,
      submission: { minigameId: 'memory_match', submission: { pairsMatched: cfg.totalPairs, moves: cfg.totalPairs, timeMs: 3000 } },
    });
    expect(res.playedFavorite).toBe(true);
  });
});
