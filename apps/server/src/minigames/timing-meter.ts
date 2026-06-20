import {
  TimingMeterConfigSchema,
  TimingMeterSubmissionSchema,
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

const INFO: MinigameInfo = {
  id: 'timing_meter',
  title: 'Timing Meter',
  description: 'Stop the sweeping meter in the zone — but it speeds up and the zone shrinks each round. Holds its nerve to the end.',
  targetStats: ['charm', 'confidence', 'chemistry'],
  rewardsCharacter: true,
};

const ROUNDS = 5;

export const timingMeterModule: MinigameModule = {
  info: INFO,

  build(ctx: MinigameBuildContext): Promise<BuiltMinigame> {
    // Each round is faster with a tighter, repositioned zone. Position is seeded
    // per-world so a given world's runs are stable but worlds differ.
    const worldKey = ctx.world?.id ?? 'solo';
    const rounds = Array.from({ length: ROUNDS }, (_, i) => {
      const speed = 1.0 + i * 0.28; // 1.0 -> ~2.1
      const width = Math.max(0.08, 0.22 - i * 0.03); // 0.22 -> 0.10
      const slack = Math.max(0.001, 1 - width);
      const targetStart = hashFloat(`${worldKey}|timing|${i}`) * slack;
      const targetEnd = Math.min(1, targetStart + width);
      return { targetStart, targetEnd, speed };
    });
    const config = TimingMeterConfigSchema.parse({ rounds });
    return Promise.resolve({ config, state: { rounds: ROUNDS } });
  },

  resolve(submission: unknown, state: unknown): ResolveResult {
    const sub = TimingMeterSubmissionSchema.parse(submission);
    const { rounds } = state as { rounds: number };

    const counted = sub.rounds.slice(0, rounds);
    const avg = counted.length > 0 ? counted.reduce((n, r) => n + r.accuracy, 0) / counted.length : 0;
    const coverage = rounds > 0 ? counted.length / rounds : 0; // penalize skipped rounds
    const score = Math.round(avg * coverage * 100);
    const grade = scoreToGrade(score);

    const base = MinigameRewardSchema.parse({
      dating: { charm: 4, confidence: 4 },
      relationship: { chemistry: 6, comfort: 2 },
      money: 30,
    });
    return { score, grade, reward: scaleReward(base, grade) };
  },
};
