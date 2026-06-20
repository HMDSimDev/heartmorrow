import type { DatingStats, RelationshipStatKey } from './stats';
import { warmthOf, type WarmthStats } from './social';
import {
  type ActivityDef,
  type TogetherOutcomeKind,
  type TogetherResult,
  TOGETHER_CROWD_TENSION,
  TOGETHER_MISFIRE_MAX,
  TOGETHER_REPEAT_SCALE,
  TOGETHER_SOFT_CEILING,
} from './activities';

/**
 * The PURE resolver for a "Together" outing. Given who the character is, where the
 * bond stands, how many times you've already leaned on them today, and a
 * deterministic roll, it decides the outcome and the exact relationship deltas to
 * apply. No I/O, no clamping beyond what the stat service will redo — same inputs
 * always yield the same result, so it's unit-testable and replayable, and the web
 * client can reuse {@link togetherFit}/{@link fitLabel} for honest fit hints.
 *
 * The four levers (matching the design): FIT (suits their traits → warmer),
 * DIMINISHING RETURNS toward {@link TOGETHER_SOFT_CEILING} (casual time can't reach
 * romance), a per-person DAILY CAP (repeats fizzle then crowd), and RISK (a bold
 * move on a guarded, cool, or poorly-matched person can misfire into tension).
 */

/** The five warmth-contributing stats — the only ones the soft ceiling bounds. */
const WARMTH_STATS: readonly RelationshipStatKey[] = ['affection', 'trust', 'chemistry', 'comfort', 'respect'];

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** How well an outing's fit-traits suit a character: the mean of those dating stats (0..100). */
export function togetherFit(activity: ActivityDef, datingStats: DatingStats): number {
  const stats = activity.fitStats ?? [];
  if (stats.length === 0) return 50;
  const sum = stats.reduce((s, k) => s + (datingStats[k] ?? 50), 0);
  return sum / stats.length;
}

/** Bucket a 0..100 fit score into the player-facing tier. */
export function fitLabel(fit: number): TogetherResult['fit'] {
  if (fit >= 64) return 'great';
  if (fit >= 40) return 'ok';
  return 'poor';
}

export interface TogetherInput {
  activity: ActivityDef;
  datingStats: DatingStats;
  /** Character guardedness (0..100) — slower to warm, quicker to feel crowded. */
  guardedness: number;
  /** Current relationship warmth stats (+ curiosity for the secondary nudge). */
  relationship: WarmthStats & { curiosity: number };
  /** Current value of the activity's PRIMARY stat (drives diminishing returns). */
  current: number;
  /** How many Together outings you've already had with THIS person today. */
  timesToday: number;
  /** A deterministic roll in [0, 1) — misfire at the low end, spark at the high end. */
  roll: number;
}

export interface TogetherResolution {
  result: TogetherResult;
  /** The relationship deltas to apply through the stat service. */
  deltas: Partial<Record<RelationshipStatKey, number>>;
}

export function resolveTogether(input: TogetherInput): TogetherResolution {
  const { activity, datingStats, guardedness, relationship, current, timesToday, roll } = input;

  const stat: RelationshipStatKey = activity.relationshipStat ?? 'comfort';
  const base = activity.amount ?? 4;
  const boldness = clamp01(activity.boldness ?? 0.2);
  const cost = activity.cost ?? 0;

  const repeatIdx = Math.min(timesToday, TOGETHER_REPEAT_SCALE.length - 1);
  const repeatScale = TOGETHER_REPEAT_SCALE[repeatIdx]!;
  const crowdTension = TOGETHER_CROWD_TENSION[repeatIdx]!;

  const fit = togetherFit(activity, datingStats);
  const fitTier = fitLabel(fit);
  const fitN = fit / 100;
  const fitScale = 0.6 + 0.8 * fitN; // 0.6 (poor fit) .. 1.4 (great fit)

  const warmth = warmthOf(relationship);
  const cold = clamp01(1 - warmth / TOGETHER_SOFT_CEILING); // 1 when near-strangers, 0 once warm

  const deltas: Partial<Record<RelationshipStatKey, number>> = {};
  const addTension = (n: number) => {
    if (n > 0) deltas.tension = (deltas.tension ?? 0) + n;
  };
  const done = (outcome: TogetherOutcomeKind, statDelta: number, memorable: boolean): TogetherResolution => ({
    result: { outcome, stat, statDelta, tensionDelta: deltas.tension ?? 0, fit: fitTier, cost, memorable },
    deltas,
  });

  // --- RISK: a bold move on a guarded / cool / poorly-matched person can sting.
  // Only the FIRST outing of the day rolls for it; repeats merely fizzle (below).
  const misfireChance = Math.min(
    TOGETHER_MISFIRE_MAX,
    Math.max(0, boldness * (0.25 + 0.45 * (guardedness / 100) + 0.4 * cold - 0.35 * fitN)),
  );
  if (timesToday === 0 && roll < misfireChance) {
    addTension(Math.round(2 + 3 * boldness)); // the deeper the reach, the worse the recoil
    return done('misfire', 0, false);
  }

  // --- DAILY CAP: the 3rd+ outing the same day gives nothing and starts to grate.
  if (repeatScale === 0) {
    addTension(crowdTension);
    return done('crowded', 0, false);
  }

  // --- DIMINISHING RETURNS toward the soft ceiling (warmth stats only).
  const isWarmthStat = WARMTH_STATS.includes(stat);
  const proximity = isWarmthStat ? clamp01((TOGETHER_SOFT_CEILING - current) / TOGETHER_SOFT_CEILING) : 1;
  let gain = base * fitScale * repeatScale * proximity;

  // A great-fit, first-of-day outing with room to grow can SPARK — a touch extra
  // plus a remembered moment. (Uses the high end of the same deterministic roll.)
  let outcome: TogetherOutcomeKind = 'warm';
  let memorable = false;
  const sparkChance = timesToday === 0 && proximity > 0.1 ? clamp01(0.15 + 0.5 * fitN) : 0;
  if (fitTier === 'great' && roll > 1 - sparkChance) {
    gain += 2;
    outcome = 'spark';
    memorable = true;
    deltas.chemistry = (deltas.chemistry ?? 0) + 1;
  }

  let statDelta = Math.round(gain);
  if (isWarmthStat && current >= TOGETHER_SOFT_CEILING) statDelta = 0; // at the ceiling, easy time can't add
  if (statDelta > 0) deltas[stat] = (deltas[stat] ?? 0) + statDelta;
  else if (outcome !== 'spark') outcome = 'flat'; // "as close as easy afternoons can take you"

  // Secondary nudge (usually curiosity) — scaled by fit + repeat, never ceiling-bound.
  if (activity.secondaryStat && activity.secondaryAmount) {
    const sec = Math.round(activity.secondaryAmount * fitScale * repeatScale);
    if (sec > 0) deltas[activity.secondaryStat] = (deltas[activity.secondaryStat] ?? 0) + sec;
  }

  // Friction: a 2nd-of-day outing adds a little tension; a poor match grates slightly.
  addTension(crowdTension);
  if (fitTier === 'poor' && outcome !== 'spark') addTension(1);

  return done(outcome, statDelta, memorable);
}
