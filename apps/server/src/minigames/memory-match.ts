import {
  MemoryMatchConfigSchema,
  MemoryMatchSubmissionSchema,
  MinigameRewardSchema,
  warmthBand,
  bandIndex,
  type MinigameInfo,
} from '@dsim/shared';
import { newId } from '../lib/ids';
import {
  clamp01,
  scaleReward,
  scoreToGrade,
  type BuiltMinigame,
  type MinigameBuildContext,
  type MinigameModule,
  type ResolveResult,
} from './registry';

const INFO: MinigameInfo = {
  id: 'memory_match',
  title: 'Memory Match',
  description: 'Flip cards to pair each clue with the truth about your date. The closer you are, the more there is to remember.',
  targetStats: ['trust', 'curiosity', 'affection'],
  rewardsCharacter: true,
};

const FALLBACK_TERMS = ['Coffee', 'Music', 'Sunset', 'Books', 'Rain', 'Stars', 'Travel', 'Cooking', 'The sea', 'Old films'];

type Category = 'like' | 'dislike' | 'goal' | 'location' | 'note' | 'generic';
interface Fact {
  cue: string;
  reveal: string;
  category: Category;
  /** Human one-liner for the result reaction / chronicle. */
  summary: string;
}

interface MatchState {
  totalPairs: number;
  difficulty: 'cozy' | 'spark' | 'deep';
  facts: Array<{ pairKey: string; category: Category; summary: string }>;
}

function clip(s: string): string {
  return s.trim();
}

/** Build categorized (cue -> reveal) facts from real character/world data. */
function gatherFacts(ctx: MinigameBuildContext): Fact[] {
  const facts: Fact[] = [];
  const seen = new Set<string>();
  const add = (cue: string, reveal: string, category: Category, summary: string) => {
    const r = clip(reveal);
    if (r.length < 2 || r.length > 24) return;
    const key = r.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    facts.push({ cue, reveal: r, category, summary });
  };
  const c = ctx.character;
  if (c) {
    c.likes.forEach((l) => add('Loves', l, 'like', `loves ${l.toLowerCase()}`));
    c.dislikes.forEach((d) => add("Can't stand", d, 'dislike', `can't stand ${d.toLowerCase()}`));
    c.goals.forEach((g) => add('Dreams of', g, 'goal', `dreams of ${g.toLowerCase()}`));
  }
  ctx.world?.locations.forEach((l) => add('Their spot', l.name, 'location', `their kind of place: ${l.name}`));
  ctx.worldNotes.forEach((n) => add('You know', n.title, 'note', n.title));
  return facts;
}

/** Board size scales with how close you are — the game deepens with the bond. */
function difficultyFor(ctx: MinigameBuildContext): { difficulty: MatchState['difficulty']; totalPairs: number } {
  const rel = ctx.relationship;
  if (!rel) return { difficulty: 'spark', totalPairs: 6 };
  const idx = bandIndex(warmthBand(rel));
  if (idx >= bandIndex('close')) return { difficulty: 'deep', totalPairs: 8 };
  if (idx >= bandIndex('getting-close')) return { difficulty: 'spark', totalPairs: 6 };
  return { difficulty: 'cozy', totalPairs: 4 };
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export const memoryMatchModule: MinigameModule = {
  info: INFO,

  build(ctx: MinigameBuildContext): Promise<BuiltMinigame> {
    const { difficulty, totalPairs } = difficultyFor(ctx);
    const facts = gatherFacts(ctx);
    // Pad with generic identical-label terms so the game never breaks for a
    // sparse character/worldless play.
    for (const term of FALLBACK_TERMS) {
      if (facts.length >= totalPairs) break;
      if (!facts.some((f) => f.reveal.toLowerCase() === term.toLowerCase())) {
        facts.push({ cue: term, reveal: term, category: 'generic', summary: term.toLowerCase() });
      }
    }
    // Assign each chosen fact its own opaque pairKey UP FRONT so cues that share
    // text (e.g. several "Loves …") don't collide.
    const chosen = facts.slice(0, totalPairs).map((f) => ({ ...f, pairKey: newId('pk') }));

    const cards = shuffle(
      chosen.flatMap((f) => {
        const generic = f.cue === f.reveal;
        return [
          { id: newId('card'), label: f.cue, pairKey: f.pairKey, face: 'cue' as const },
          { id: newId('card'), label: f.reveal, pairKey: f.pairKey, face: generic ? ('cue' as const) : ('reveal' as const) },
        ];
      }),
    );
    const config = MemoryMatchConfigSchema.parse({ cards, totalPairs: chosen.length, difficulty });
    const state: MatchState = {
      totalPairs: chosen.length,
      difficulty,
      facts: chosen.map((f) => ({ pairKey: f.pairKey, category: f.category, summary: f.summary })),
    };
    return Promise.resolve({ config, state });
  },

  resolve(submission: unknown, state: unknown): ResolveResult {
    const sub = MemoryMatchSubmissionSchema.parse(submission);
    const { totalPairs } = state as MatchState;

    // Sanity-clamp client-reported metrics to physically-possible values BEFORE
    // scoring, so a client can't bank a free max with impossible numbers.
    const matched = Math.max(0, Math.min(sub.pairsMatched, totalPairs));
    const completion = totalPairs > 0 ? matched / totalPairs : 0;
    const moves = Math.max(sub.moves, matched); // can't match more pairs than moves
    const idealMoves = Math.round(totalPairs * 1.6);
    const efficiency = clamp01(idealMoves / Math.max(moves, idealMoves));
    const timeSec = Math.max(0.5, sub.timeMs / 1000);
    const speedFactor = clamp01(1 - (timeSec - totalPairs * 2) / (totalPairs * 8));

    // Completion dominates; efficiency + speed spread the grade bands.
    const score = Math.round(100 * completion * (0.45 + 0.35 * efficiency + 0.2 * speedFactor));
    const grade = scoreToGrade(score);

    const base = MinigameRewardSchema.parse({
      relationship: { trust: 5, curiosity: 6, affection: 4 },
      dating: { empathy: 3 },
      money: 30,
    });
    return { score, grade, reward: scaleReward(base, grade) };
  },
};
