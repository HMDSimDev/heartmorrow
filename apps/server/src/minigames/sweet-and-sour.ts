import {
  SweetAndSourConfigSchema,
  SweetAndSourSubmissionSchema,
  MinigameRewardSchema,
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
  id: 'sweet_and_sour',
  title: 'Sweet & Sour',
  description: "Sort what they adore, can't stand, or don't mind. How well do you really know their heart?",
  targetStats: ['empathy', 'trust', 'affection'],
  rewardsCharacter: true,
};

type Tray = 'adore' | 'avoid' | 'meh';

interface SweetSourState {
  answerKey: Record<string, Tray>;
  total: number;
}

/** Mundane things a person plausibly has no strong feeling about → "doesn't mind". */
const NEUTRAL_POOL = [
  'elevator music',
  'beige walls',
  'tap water',
  'waiting rooms',
  'instruction manuals',
  'stock photos',
  'lukewarm tea',
  'parking lots',
  'filing cabinets',
  'weather reports',
];

function clean(s: string): string {
  return s.trim();
}

function take(values: string[], seen: Set<string>, max: number, maxLen = 40): string[] {
  const out: string[] = [];
  for (const raw of values) {
    if (out.length >= max) break;
    const v = clean(raw);
    const key = v.toLowerCase();
    if (v.length < 2 || v.length > maxLen || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export const sweetAndSourModule: MinigameModule = {
  info: INFO,

  build(ctx: MinigameBuildContext): Promise<BuiltMinigame> {
    const c = ctx.character;
    const seen = new Set<string>();
    // Trays are assigned SERVER-SIDE from real trait data — never shipped.
    const adore = take(c?.likes ?? [], seen, 5);
    const avoid = take(
      [...(c?.dislikes ?? []), ...(c?.dislikedWeather ?? []).map((w) => `${w} weather`), ...(c?.boundaries ?? [])],
      seen,
      5,
    );
    // Balance "doesn't mind" against the real data, at least 3, capped 5.
    const mehCount = Math.max(3, Math.min(5, Math.round((adore.length + avoid.length) / 2) || 3));
    const meh = take(NEUTRAL_POOL, seen, mehCount);

    const entries: Array<{ label: string; tray: Tray }> = [
      ...adore.map((label) => ({ label, tray: 'adore' as const })),
      ...avoid.map((label) => ({ label, tray: 'avoid' as const })),
      ...meh.map((label) => ({ label, tray: 'meh' as const })),
    ];
    // Safety floor: never fewer than the schema minimum (6) — pad neutrals.
    for (const term of NEUTRAL_POOL) {
      if (entries.length >= 6) break;
      const key = term.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({ label: term, tray: 'meh' });
      }
    }

    const answerKey: Record<string, Tray> = {};
    const cards = shuffle(
      entries.map((e) => {
        const id = newId('sc');
        answerKey[id] = e.tray;
        return { id, label: e.label };
      }),
    );
    const config = SweetAndSourConfigSchema.parse({
      cards,
      trays: [
        { key: 'adore', label: 'Adores' },
        { key: 'avoid', label: "Can't stand" },
        { key: 'meh', label: "Doesn't mind" },
      ],
      source: 'fallback',
    });
    return Promise.resolve({ config, state: { answerKey, total: cards.length } satisfies SweetSourState });
  },

  resolve(submission: unknown, state: unknown): ResolveResult {
    const sub = SweetAndSourSubmissionSchema.parse(submission);
    const { answerKey, total } = state as SweetSourState;

    let sum = 0;
    const seen = new Set<string>();
    for (const p of sub.placements) {
      if (seen.has(p.cardId)) continue; // keep first placement only
      seen.add(p.cardId);
      const correctTray = answerKey[p.cardId];
      if (!correctTray) continue; // phantom card id → ignored
      const c = clamp01(p.confidence);
      if (p.tray === correctTray) {
        sum += 0.6 + 0.4 * c; // confident-correct rewarded most
      } else {
        sum -= 0.3 * c; // confident-wrong stings; a hesitant wrong barely costs
      }
    }
    // Denominator is the SERVER's fixed total — skipping hard cards is not free.
    const accuracy = clamp01(total > 0 ? sum / total : 0);
    const score = Math.round(accuracy * 100);
    const grade = scoreToGrade(score);

    const base = MinigameRewardSchema.parse({
      dating: { empathy: 5 },
      relationship: { trust: 5, affection: 4, comfort: 3 },
      money: 30,
    });
    return { score, grade, reward: scaleReward(base, grade) };
  },
};
