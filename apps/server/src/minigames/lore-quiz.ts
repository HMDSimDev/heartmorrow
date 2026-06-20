import {
  GeneratedQuizQuestion,
  LoreQuizConfigSchema,
  LoreQuizSubmissionSchema,
  MinigameRewardSchema,
  QuizGenerationSchema,
  type MinigameInfo,
  type QuizQuestion,
} from '@dsim/shared';
import { newId } from '../lib/ids';
import { hashFloat } from '../lib/seeded-random';
import { callStructuredLlm } from '../llm/structured';
import type { ChatMessage } from '../llm/types';
import {
  scaleReward,
  scoreToGrade,
  type BuiltMinigame,
  type MinigameBuildContext,
  type MinigameModule,
  type ResolveResult,
} from './registry';

const INFO: MinigameInfo = {
  id: 'lore_quiz',
  title: 'Lore Quiz',
  description: 'Questions about their world — and about them. LLM-written when possible, with built-in fallbacks.',
  targetStats: ['intellect', 'respect', 'comfort'],
  rewardsCharacter: true,
};

interface QuizState {
  answerKey: Record<string, number>;
}

/** Plausible-but-wrong hobby decoys so "what does X love" tests real knowledge. */
const DECOY_INTERESTS = [
  'hiking at dawn',
  'karaoke nights',
  'board games',
  'horror movies',
  'spicy street food',
  'thrift shopping',
  'long drives',
  'crowded festivals',
];

function rotate<T>(arr: T[], seed: number): T[] {
  if (arr.length <= 1) return arr;
  const offset = Math.floor(seed * arr.length) % arr.length;
  return [...arr.slice(offset), ...arr.slice(0, offset)];
}

/** Questions about THIS character, built from their real traits (no LLM). */
function characterQuestions(ctx: MinigameBuildContext, seed: number): Array<{ prompt: string; choices: string[]; correct: number }> {
  const c = ctx.character;
  if (!c) return [];
  const out: Array<{ prompt: string; choices: string[]; correct: number }> = [];
  const decoyPool = rotate(DECOY_INTERESTS, seed);

  const like = c.likes[0];
  if (like) {
    const decoys = decoyPool.filter((d) => d.toLowerCase() !== like.toLowerCase()).slice(0, 3);
    if (decoys.length === 3) {
      const choices = rotate([like, ...decoys], seed);
      out.push({ prompt: `Which of these would ${c.name} most enjoy?`, choices, correct: choices.indexOf(like) });
    }
  }
  const dislike = c.dislikes[0];
  if (dislike) {
    const decoys = decoyPool.filter((d) => d.toLowerCase() !== dislike.toLowerCase()).slice(3, 6);
    if (decoys.length === 3) {
      const choices = rotate([dislike, ...decoys], seed + 0.5);
      out.push({ prompt: `What is ${c.name} least likely to be into?`, choices, correct: choices.indexOf(dislike) });
    }
  }
  return out;
}

/** Deterministic fallback questions used when no world exists or generation fails. */
function fallbackQuestions(ctx: MinigameBuildContext): { questions: QuizQuestion[]; answerKey: Record<string, number> } {
  const worldName = ctx.world?.name ?? 'this setting';
  const seed = hashFloat(`lorequiz|${ctx.world?.id ?? ctx.character?.id ?? 'solo'}`);
  const generic: Array<{ prompt: string; choices: string[]; correct: number }> = [
    {
      prompt: 'What is a thoughtful way to begin a first date?',
      choices: ['Ask about their interests', 'Talk only about yourself', 'Check your phone often', 'Arrive late'],
      correct: 0,
    },
    {
      prompt: 'If your date clearly sets a boundary, you should…',
      choices: ['Argue with them', 'Respect it', 'Ignore it', 'Tease them about it'],
      correct: 1,
    },
    {
      prompt: 'A good way to show you are really listening is to…',
      choices: ['Interrupt often', 'Change the subject', 'Ask follow-up questions', 'Stay silent the whole time'],
      correct: 2,
    },
    {
      prompt: `In which setting are you spending time together?`,
      choices: ['A galaxy far away', 'Ancient Rome', worldName, 'A cooking show'],
      correct: 2,
    },
  ];
  // Lead with what we know about THEM, then rotate the generic pool so repeats differ.
  const pool = [...characterQuestions(ctx, seed), ...rotate(generic, seed)].slice(0, 5);

  const questions: QuizQuestion[] = [];
  const answerKey: Record<string, number> = {};
  for (const q of pool) {
    const id = newId('q');
    questions.push({ id, prompt: q.prompt, choices: q.choices });
    answerKey[id] = q.correct;
  }
  return { questions, answerKey };
}

function buildGenMessages(ctx: MinigameBuildContext): ChatMessage[] {
  const w = ctx.world!;
  const noteText = ctx.worldNotes
    .slice(0, 8)
    .map((n) => `- ${n.title}: ${n.body}`)
    .join('\n');
  const c = ctx.character;
  const charBlock = c
    ? `\nYour date is ${c.name}. Likes: ${c.likes.join(', ') || '—'}. Dislikes: ${c.dislikes.join(', ') || '—'}. Goals: ${c.goals.join(', ') || '—'}.`
    : '';
  return [
    {
      role: 'system',
      content:
        'You write fun multiple-choice quiz questions for a dating-sim minigame. ' +
        'Each question has exactly 4 choices and one correct answer. ' +
        (c
          ? 'Mix questions about the fictional WORLD with a couple about the date themselves (their tastes/goals). '
          : '') +
        'Keep them grounded ONLY in the provided data — never invent facts.',
    },
    {
      role: 'user',
      content:
        `World: ${w.name}\nSummary: ${w.summary}\nTone: ${w.tone}\nLore: ${w.lore}\nRules: ${w.rules}\n` +
        `Notes:\n${noteText || '(none)'}${charBlock}\n\nWrite 5 questions.`,
    },
  ];
}

export const loreQuizModule: MinigameModule = {
  info: INFO,

  async build(ctx: MinigameBuildContext): Promise<BuiltMinigame> {
    // Try LLM generation when a world exists; otherwise use fallbacks.
    if (ctx.world) {
      try {
        const result = await callStructuredLlm(QuizGenerationSchema, buildGenMessages(ctx), {
          settings: ctx.settings,
          task: 'Generate multiple-choice quiz questions about the world and the date.',
          schemaName: 'QuizGeneration',
          log: ctx.log,
        });
        if (result.ok) {
          const valid = result.data.questions.filter(
            (q: GeneratedQuizQuestion) => q.correctIndex < q.choices.length,
          );
          if (valid.length > 0) {
            const questions: QuizQuestion[] = [];
            const answerKey: Record<string, number> = {};
            for (const q of valid.slice(0, 6)) {
              const id = newId('q');
              questions.push({ id, prompt: q.prompt, choices: q.choices });
              answerKey[id] = q.correctIndex;
            }
            const config = LoreQuizConfigSchema.parse({ questions, source: 'llm' });
            return { config, state: { answerKey } satisfies QuizState };
          }
        }
        ctx.log?.('[lore_quiz] generation failed validation; using fallback questions.');
      } catch (err) {
        ctx.log?.(`[lore_quiz] generation error; using fallback. ${(err as Error).message}`);
      }
    }

    const { questions, answerKey } = fallbackQuestions(ctx);
    const config = LoreQuizConfigSchema.parse({ questions, source: 'fallback' });
    return { config, state: { answerKey } satisfies QuizState };
  },

  resolve(submission: unknown, state: unknown): ResolveResult {
    const sub = LoreQuizSubmissionSchema.parse(submission);
    const { answerKey } = state as QuizState;
    const total = Object.keys(answerKey).length;

    let correct = 0;
    const seen = new Set<string>();
    for (const a of sub.answers) {
      if (seen.has(a.questionId)) continue; // ignore duplicate answers for a question
      seen.add(a.questionId);
      if (answerKey[a.questionId] === a.choiceIndex) correct += 1;
    }
    const ratio = total > 0 ? correct / total : 0;
    const score = Math.round(ratio * 100);
    const grade = scoreToGrade(score);

    const base = MinigameRewardSchema.parse({
      dating: { intellect: 4 },
      relationship: { respect: 6, comfort: 3 },
      money: 30,
    });
    return { score, grade, reward: scaleReward(base, grade) };
  },
};
