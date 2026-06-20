import { z } from 'zod';
import {
  TwoTruthsConfigSchema,
  TwoTruthsSubmissionSchema,
  MinigameRewardSchema,
  type MinigameInfo,
} from '@dsim/shared';
import { newId } from '../lib/ids';
import { callStructuredLlm } from '../llm/structured';
import type { ChatMessage } from '../llm/types';
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
  id: 'two_truths_a_lie',
  title: 'Read Between the Lines',
  description: 'Two truths and a bluff each round. Spot the lie and wager how sure you are. Reading them well brings you closer.',
  targetStats: ['empathy', 'intellect', 'trust'],
  rewardsCharacter: true,
};

const ROUNDS = 3;
const W = { low: 1, medium: 2, high: 3 } as const;

interface TwoTruthsState {
  lieKey: Record<string, string>; // roundId -> lie statement id
  statements: Record<string, string[]>; // roundId -> statement ids
}

/** Plausible interests used to phrase the lie (something that ISN'T them). */
const DECOYS = [
  'competitive karaoke',
  'waking up at 5am',
  'extreme roller coasters',
  'collecting stamps',
  'marathon running',
  'reality TV',
  'ice baths',
  'speed chess',
];

const GENERIC_ROUNDS: Array<{ statements: string[]; lieIdx: number }> = [
  { statements: ['I get weirdly attached to a good playlist.', "I can't sit through a whole movie without snacks.", 'I have run three marathons this year.'], lieIdx: 2 },
  { statements: ['I talk to my plants sometimes.', 'I once owned a pet snake named after a philosopher.', 'I like a quiet night in more than a loud party.'], lieIdx: 1 },
  { statements: ['I always read the last page of a book first.', 'I am completely fluent in four languages.', 'I get a little nervous on first dates.'], lieIdx: 1 },
];

function likeLine(x: string): string {
  return `Honestly, I could spend all day with ${x.toLowerCase()}.`;
}
function goalLine(g: string): string {
  return `Deep down, ${g.toLowerCase()} is kind of the dream for me.`;
}

/** Deterministic fallback rounds built from real traits (or generic if none). */
function fallbackRounds(ctx: MinigameBuildContext): Array<{ statements: string[]; lieIdx: number }> {
  const c = ctx.character;
  if (!c) return GENERIC_ROUNDS;

  const truths = [...c.likes.map(likeLine), ...c.goals.map(goalLine)];
  const decoyLines = DECOYS.filter((d) => !c.likes.some((l) => l.toLowerCase() === d.toLowerCase())).map(likeLine);
  if (truths.length < 2 || decoyLines.length < 1) return GENERIC_ROUNDS;

  const rounds: Array<{ statements: string[]; lieIdx: number }> = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const t1 = truths[(i * 2) % truths.length]!;
    let t2 = truths[(i * 2 + 1) % truths.length]!;
    if (t2 === t1) t2 = truths[(i * 2 + 2) % truths.length] ?? t1;
    const lie = decoyLines[i % decoyLines.length]!;
    const trio = [t1, t2, lie];
    // Distinct statements only; if a collision slipped in, skip to generic.
    if (new Set(trio).size < 3) return GENERIC_ROUNDS;
    rounds.push({ statements: trio, lieIdx: 2 });
  }
  return rounds;
}

const GenSchema = z.object({
  rounds: z
    .array(z.object({ statements: z.array(z.string().min(1)).length(3), lieIndex: z.number().int().min(0).max(2) }))
    .min(1)
    .max(ROUNDS),
});

function buildGenMessages(ctx: MinigameBuildContext): ChatMessage[] {
  const c = ctx.character!;
  return [
    {
      role: 'system',
      content:
        'You write a "two truths and a lie" dating-sim minigame. For the given person, write rounds of THREE short first-person statements: exactly TWO that are TRUE to who they are (grounded in their real likes/goals/personality) and exactly ONE plausible LIE that subtly contradicts them. The lie must NOT be obviously false. Mark which index (0-2) is the lie. The data is reference only; never invent contradictions of stated facts.',
    },
    {
      role: 'user',
      content:
        `Person: ${c.name} (${c.age}). Personality: ${c.personality || '—'}. ` +
        `Likes: ${c.likes.join(', ') || '—'}. Dislikes: ${c.dislikes.join(', ') || '—'}. Goals: ${c.goals.join(', ') || '—'}.\n` +
        `Write ${ROUNDS} rounds.`,
    },
  ];
}

function shuffleTrio(statements: string[], lieIdx: number): { ordered: string[]; lieAt: number } {
  const idx = [0, 1, 2];
  for (let i = idx.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const ordered = idx.map((k) => statements[k]!);
  const lieAt = idx.indexOf(lieIdx);
  return { ordered, lieAt };
}

function assemble(raw: Array<{ statements: string[]; lieIdx: number }>, source: 'llm' | 'fallback'): BuiltMinigame {
  const lieKey: Record<string, string> = {};
  const statements: Record<string, string[]> = {};
  const rounds = raw.slice(0, ROUNDS).map((r) => {
    const roundId = newId('ttr');
    const { ordered, lieAt } = shuffleTrio(r.statements, r.lieIdx);
    const stmts = ordered.map((text) => ({ id: newId('tts'), text }));
    lieKey[roundId] = stmts[lieAt]!.id;
    statements[roundId] = stmts.map((s) => s.id);
    return { id: roundId, statements: stmts };
  });
  const config = TwoTruthsConfigSchema.parse({ rounds, source });
  return { config, state: { lieKey, statements } satisfies TwoTruthsState };
}

export const twoTruthsModule: MinigameModule = {
  info: INFO,

  async build(ctx: MinigameBuildContext): Promise<BuiltMinigame> {
    if (ctx.character) {
      try {
        const result = await callStructuredLlm(GenSchema, buildGenMessages(ctx), {
          settings: ctx.settings,
          task: 'Write two-truths-and-a-lie rounds about the character.',
          schemaName: 'TwoTruthsGen',
          log: ctx.log,
        });
        if (result.ok) {
          const valid = result.data.rounds.filter(
            (r) => new Set(r.statements.map((s) => s.trim().toLowerCase())).size === 3 && r.statements.every((s) => s.trim().length > 0),
          );
          if (valid.length > 0) {
            return assemble(valid.map((r) => ({ statements: r.statements.map((s) => s.trim()), lieIdx: r.lieIndex })), 'llm');
          }
        }
        ctx.log?.('[two_truths] generation failed validation; using fallback.');
      } catch (err) {
        ctx.log?.(`[two_truths] generation error; using fallback. ${(err as Error).message}`);
      }
    }
    return assemble(fallbackRounds(ctx), 'fallback');
  },

  resolve(submission: unknown, state: unknown): ResolveResult {
    const sub = TwoTruthsSubmissionSchema.parse(submission);
    const { lieKey, statements } = state as TwoTruthsState;
    const R = Object.keys(lieKey).length;

    let totalPoints = 0;
    let highConfMisses = 0;
    const seen = new Set<string>();
    for (const r of sub.rounds) {
      if (seen.has(r.roundId)) continue; // one answer per round
      seen.add(r.roundId);
      const lie = lieKey[r.roundId];
      if (!lie) continue; // phantom round id
      const validIds = statements[r.roundId] ?? [];
      const accusedReal = validIds.includes(r.accusedStatementId);
      const correct = accusedReal && r.accusedStatementId === lie;
      if (correct) {
        totalPoints += W[r.confidence];
      } else if (r.confidence === 'high') {
        highConfMisses += 1; // overconfident wrong reads are penalized
      }
    }

    const maxPoints = 3 * R;
    const a = maxPoints > 0 ? totalPoints / maxPoints : 0; // accuracy fraction
    const pen = maxPoints > 0 ? (highConfMisses * 0.5) / maxPoints : 0;
    const score = Math.round(clamp01(a - pen) * 100);
    const grade = scoreToGrade(score);

    // Positives scale with the grade; the tension delta tracks INACCURACY directly
    // (being fooled raises tension; a clean read leaves it at 0) and is NOT scaled
    // away at low grades.
    const base = MinigameRewardSchema.parse({
      dating: { empathy: 4, intellect: 3 },
      relationship: { trust: 6 },
      money: 28,
    });
    const scaled = scaleReward(base, grade);
    // Being fooled RAISES tension (positive delta); a clean read leaves it at 0.
    const tensionDelta = Math.round((1 - a) * 4);
    const reward = MinigameRewardSchema.parse({
      dating: scaled.dating,
      relationship: { ...scaled.relationship, ...(tensionDelta !== 0 ? { tension: tensionDelta } : {}) },
      money: scaled.money,
    });
    return { score, grade, reward };
  },
};
