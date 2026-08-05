/**
 * Live date dynamics: each date the character has a "need" the player must read,
 * and a per-turn RAPPORT that rises or falls with how well each message lands.
 * Bad dates can cool off and end early; the final rapport scales the outcome.
 * This module is the shared vocabulary; the server owns the running value.
 */

import type { RelationshipStatKey } from './stats';

export interface DateNeed {
  key: string;
  /** Hidden behavioral hint fed into the dialogue prompt (the character acts on it). */
  behavior: string;
  /** What the per-turn judge rewards / penalizes given this need. */
  judge: string;
}

/** What the character is quietly hoping for on this date — the thing to read. */
export const DATE_NEEDS: DateNeed[] = [
  {
    key: 'listen',
    behavior: 'You want to feel truly listened to — you bring up something on your mind and hope they actually engage with it rather than steering back to themselves.',
    judge: 'Reward attentive listening, genuine follow-up questions, and remembering/responding to what the character actually said. Penalize self-absorption, ignoring their cues, and yanking the conversation back to the player.',
  },
  // NOTE: behavior strings land in the SAME prompt as the independently-rolled
  // mood-of-the-day ("Today you're feeling cheerful"), so they must state only the
  // WANT — never assert a backstory or state ("you've had a heavy week", "you're
  // restless") that can flatly contradict the mood beside them.
  {
    key: 'levity',
    behavior: 'You want lightness from this date — easy banter, fun, a little flirtatious teasing, not an interrogation.',
    judge: 'Reward playfulness, humor, warmth, and lightness. Penalize heaviness, relentless deep questions, moping, or negativity.',
  },
  {
    key: 'desire',
    behavior: 'You want to feel wanted — attention on you, warmth, sincere flirtation.',
    judge: 'Reward genuine flirtation, warmth, and attention aimed at the character. Penalize coldness, pure logistics, or making it all about the player.',
  },
  {
    key: 'depth',
    behavior: 'You want something real — honesty and a little vulnerability, not surface small talk.',
    judge: 'Reward openness, sincerity, real questions, and vulnerability. Penalize shallow small talk, deflection, and jokey avoidance.',
  },
  {
    key: 'spontaneity',
    behavior: 'You want spontaneity from this date — for them to take a little initiative, suggest something, surprise you.',
    judge: 'Reward initiative, ideas, playfulness, and spontaneity. Penalize passivity, one-word answers, and putting every decision back on the character.',
  },
  {
    key: 'guarded',
    behavior: "You're keeping this date a little guarded — they have to earn it before you fully warm up. Don't be hostile, just slower to open.",
    judge: 'Reward patience, respect, warmth, and not pushing. Penalize presumption, pushiness, crossing boundaries, or rushing intimacy.',
  },
];

/** Map a 0..1 seed to a date need (server passes a stable per-day hash). */
export function pickDateNeed(seed: number): DateNeed {
  const s = Math.max(0, Math.min(0.999999, seed));
  return DATE_NEEDS[Math.floor(s * DATE_NEEDS.length)] ?? DATE_NEEDS[0]!;
}

/** Rapport runs 0..100 and opens at the NEUTRAL midpoint — a date has to be earned
 *  from here, not coasted down from a head start. A character's guardedness pulls
 *  their personal opening lower (see `startingRapport`). */
export const RAPPORT_START = 50;
/** At/below this, the character has lost interest — your next message, they leave. */
export const RAPPORT_LEAVE_FLOOR = 14;

/** How a character's guardedness (0..100) shapes the live rapport. Tuned for a
 *  "harsh/realistic" feel: reserved people open cooler, warm slowly, and cool just
 *  as fast as anyone — and any date quietly cools when you stop putting in effort. */
export const GUARDEDNESS = {
  /** Points a fully-guarded (100) character's opening rapport is dropped below the midpoint. */
  START_DROP: 18,
  /** Positive-engagement gain is scaled by (1 − guardedness/100 × GAIN_DAMP). Tuned so a
   *  very guarded character still climbs on genuinely good play — just markedly slower
   *  (hard, not impossible): a +3 turn is worth ~8 to them vs ~15 to an open character. */
  GAIN_DAMP: 0.6,
  /** A purely forgettable turn (engagement 0) no longer cools an open character — a
   *  pleasant-but-empty line HOLDS the line; you just can't BUILD warmth without a real
   *  +1. (Genuine letdowns still score −1/−2/−3 and cool as before.) */
  IDLE_DRIFT_BASE: 0,
  /** …but a guarded character still slips a little on empty turns — they extend less
   *  goodwill, so coasting with them slowly cools (up to this much for fully guarded). */
  IDLE_DRIFT_GUARD: 2,
  /** Asymmetric per-turn step: a good beat is worth less than a bad one costs. */
  POS_STEP: 5,
  NEG_STEP: 8,
} as const;

/** A date's opening rapport for a character of the given guardedness (0..100). */
export function startingRapport(guardedness = 0): number {
  const g = Math.max(0, Math.min(100, guardedness));
  return Math.round(RAPPORT_START - (g / 100) * GUARDEDNESS.START_DROP);
}

/** The player-facing difficulty ladder (a Settings knob; 'normal' is the tuned baseline). */
export const DIFFICULTIES = ['gentle', 'normal', 'harsh'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface DifficultyTuning {
  /** Scales a turn's positive rapport movement (applied AFTER guardedness damping). */
  posMult: number;
  /** Scales a turn's negative rapport movement (including a guarded idle slip). */
  negMult: number;
  /** Added to the FINAL rapport before the end-of-date stakes ladder grades it. */
  endShift: number;
  /** Rapport at/below which the character loses interest and leaves. */
  leaveFloor: number;
  /** Scales end-of-sitting evaluator deltas in the player's FAVOR. */
  evalGainMult: number;
  /** Scales end-of-sitting evaluator deltas AGAINST the player (harm-aware: see
   *  `scaleEvaluationDeltas` — a tension rise is harm even though its sign is +). */
  evalHarmMult: number;
}

/**
 * How difficulty shapes a date's consequences. Difficulty NEVER touches the LLM
 * judges (their rubric stays impartial) and NEVER moves a date's opening rapport
 * (every date starts exactly where it would on normal) — it only scales what the
 * server DOES with the judges' reads. 'normal' is the identity row: it must keep
 * the tuned baseline byte-identical.
 */
export const DIFFICULTY: Record<Difficulty, DifficultyTuning> = {
  gentle: { posMult: 1.25, negMult: 0.7, endShift: 4, leaveFloor: 8, evalGainMult: 1.25, evalHarmMult: 0.6 },
  normal: { posMult: 1, negMult: 1, endShift: 0, leaveFloor: RAPPORT_LEAVE_FLOOR, evalGainMult: 1, evalHarmMult: 1 },
  harsh: { posMult: 0.8, negMult: 1.25, endShift: -4, leaveFloor: 20, evalGainMult: 0.8, evalHarmMult: 1.3 },
};

/**
 * Scale an end-of-sitting evaluator's proposed relationship deltas by difficulty.
 * "Against the player" is judged by HARM direction, not raw sign — tension is
 * inverted (a rise is a setback, a drop is a win) — so gentle softens a tension
 * spike and harsh sharpens it, never the other way round. One plain Math.round
 * per stat; 'normal' is exactly identity.
 */
export function scaleEvaluationDeltas(
  deltas: Partial<Record<RelationshipStatKey, number>>,
  difficulty: Difficulty,
): Partial<Record<RelationshipStatKey, number>> {
  const tune = DIFFICULTY[difficulty];
  if (tune.evalGainMult === 1 && tune.evalHarmMult === 1) return { ...deltas };
  const out: Partial<Record<RelationshipStatKey, number>> = {};
  for (const [key, value] of Object.entries(deltas) as [RelationshipStatKey, number][]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const harmful = key === 'tension' ? value > 0 : value < 0;
    out[key] = Math.round(value * (harmful ? tune.evalHarmMult : tune.evalGainMult));
  }
  return out;
}

/**
 * How much a single turn moves the live rapport, given the per-turn judge's
 * engagement (−3..+3) and the character's guardedness. Three deliberate biases:
 *  - ASYMMETRIC: warmth is harder to build than to lose (POS_STEP < NEG_STEP).
 *  - NO FREE WARMTH: an empty turn (engagement 0) doesn't BUILD rapport — it holds
 *    steady for an open character and cools a guarded one slightly; you climb only on
 *    genuine +1/+2 turns. (Real letdowns score negative and cool everyone.)
 *  - GUARDED = SLOW TO WARM: only the upside is dampened by guardedness; a guarded
 *    person still cools at full speed, so they're easy to lose and hard to win.
 * Difficulty then scales the finished step (gentle: warms faster / cools slower;
 * harsh: the reverse) — after guardedness, so hard mode compounds with a guarded
 * character rather than washing them out. An open character's empty turn stays 0
 * on every difficulty: difficulty never invents drift.
 */
export function turnRapportDelta(engagement: number, opts: { guardedness?: number; difficulty?: Difficulty } = {}): number {
  const e = Math.max(-3, Math.min(3, Math.round(engagement)));
  const g = Math.max(0, Math.min(100, opts.guardedness ?? 0));
  const tune = DIFFICULTY[opts.difficulty ?? 'normal'];
  let d = e >= 0 ? e * GUARDEDNESS.POS_STEP : e * GUARDEDNESS.NEG_STEP;
  if (e === 0) d -= GUARDEDNESS.IDLE_DRIFT_BASE + Math.round((g / 100) * GUARDEDNESS.IDLE_DRIFT_GUARD);
  if (d > 0) d *= 1 - (g / 100) * GUARDEDNESS.GAIN_DAMP;
  d *= d > 0 ? tune.posMult : tune.negMult;
  return Math.round(d);
}

/** A short behavioral descriptor of how readily a character opens up (for prompts). */
export function guardednessDescriptor(guardedness = 0): string {
  const g = Math.max(0, Math.min(100, guardedness));
  if (g >= 70) return 'very guarded';
  if (g >= 50) return 'guarded';
  if (g >= 30) return 'a little reserved';
  if (g >= 12) return 'fairly open';
  return 'an open book';
}

/** A short, qualitative read of how the date is going (no numbers shown to the player). */
export function rapportLabel(v: number): string {
  if (v >= 85) return 'enchanted';
  if (v >= 72) return 'really into it';
  if (v >= 60) return 'warming to you';
  if (v >= 47) return 'finding the rhythm';
  if (v >= 34) return 'a bit awkward';
  if (v >= 22) return 'cooling off';
  if (v > RAPPORT_LEAVE_FLOOR) return 'losing interest';
  return 'checked out';
}
