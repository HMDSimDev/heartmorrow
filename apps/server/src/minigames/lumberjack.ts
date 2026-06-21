import {
  LumberjackConfigSchema,
  LumberjackSubmissionSchema,
  MinigameRewardSchema,
  type MinigameInfo,
} from '@dsim/shared';
import { hashFloat } from '../lib/seeded-random';
import {
  scaleReward,
  scoreToGrade,
  type BuiltMinigame,
  type MinigameBuildContext,
  type MinigameModule,
  type ResolveResult,
} from './registry';

/**
 * The Woodlot — a money-only SKILL JOB (no character, no relationship). Time each
 * axe swing into the log's "grain" zone; the zone narrows and the swing quickens
 * with every log as your arms tire. Mechanically a cousin of `timing_meter`, but:
 *  - it rewards COIN only (rewardsCharacter: false, no targetStats), so it runs in
 *    the framework's character-null "job mode" (money flows to the world wallet),
 *  - it pays a higher base than the dating games (a worked S-grade should beat a
 *    no-skill flat shift), and
 *  - the GRADE is driven by a server-derived combo, not just average accuracy, so
 *    sustained clean swings — the real skill — matter.
 */

const INFO: MinigameInfo = {
  id: 'lumberjack',
  title: 'The Woodlot',
  description: 'Dawn shift at the woodlot — read the grain, swing on the beat, and fell each log before your arms give out. Pure skill, paid in coin.',
  targetStats: [],
  rewardsCharacter: false,
};

/** Logs to fell in one shift. */
const LOGS = 7;
/** Accuracy at/above which a swing is "clean" and keeps a combo alive. */
const CLEAN = 0.6;
/** Base pay for a flawless shift; the service caps money at 100, so an S play lands there. */
const BASE_PAY = 100;

export const lumberjackModule: MinigameModule = {
  info: INFO,

  build(ctx: MinigameBuildContext): Promise<BuiltMinigame> {
    // Each log is faster with a tighter, repositioned grain zone. Position is
    // seeded per-world so a given world's runs are stable but worlds differ — and
    // it needs no character (job mode), mirroring timing_meter's `world ?? 'solo'`.
    const worldKey = ctx.world?.id ?? 'solo';
    const logs = Array.from({ length: LOGS }, (_, i) => {
      const speed = 1.05 + i * 0.22; // arms tire: the swing gets faster each log
      const width = Math.max(0.07, 0.24 - i * 0.025); // the grain narrows
      const slack = Math.max(0.001, 1 - width);
      const targetStart = hashFloat(`${worldKey}|lumberjack|${i}`) * slack;
      const targetEnd = Math.min(1, targetStart + width);
      return { targetStart, targetEnd, speed };
    });
    const config = LumberjackConfigSchema.parse({ logs });
    return Promise.resolve({ config, state: { logs: LOGS } });
  },

  resolve(submission: unknown, state: unknown): ResolveResult {
    const sub = LumberjackSubmissionSchema.parse(submission);
    const { logs } = state as { logs: number };

    const counted = sub.swings.slice(0, logs);
    const avg = counted.length > 0 ? counted.reduce((n, s) => n + s.accuracy, 0) / counted.length : 0;
    const coverage = logs > 0 ? counted.length / logs : 0; // bailing early costs you

    // Derive the combo SERVER-SIDE from the raw accuracy sequence — the client
    // never claims a combo. Longest run of clean swings is the skill signal.
    let combo = 0;
    let maxCombo = 0;
    for (const s of counted) {
      if (s.accuracy >= CLEAN) {
        combo += 1;
        if (combo > maxCombo) maxCombo = combo;
      } else {
        combo = 0;
      }
    }
    const comboRatio = logs > 0 ? maxCombo / logs : 0;

    // 80% clean-timing, 20% sustained-combo bonus — kept in [0,100].
    const score = Math.round((0.8 * avg * coverage + 0.2 * comboRatio) * 100);
    const grade = scoreToGrade(score);

    // Money-only: empty dating/relationship bundles, a higher base than the dating
    // games. scaleReward grades it down; the service clamps money to 100.
    const base = MinigameRewardSchema.parse({ dating: {}, relationship: {}, money: BASE_PAY });
    return { score, grade, reward: scaleReward(base, grade) };
  },
};
