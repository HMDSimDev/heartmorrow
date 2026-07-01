/**
 * Live date dynamics: each date the character has a "need" the player must read,
 * and a per-turn RAPPORT that rises or falls with how well each message lands.
 * Bad dates can cool off and end early; the final rapport scales the outcome.
 * This module is the shared vocabulary; the server owns the running value.
 */

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

/**
 * How much a single turn moves the live rapport, given the per-turn judge's
 * engagement (−3..+3) and the character's guardedness. Three deliberate biases:
 *  - ASYMMETRIC: warmth is harder to build than to lose (POS_STEP < NEG_STEP).
 *  - NO FREE WARMTH: an empty turn (engagement 0) doesn't BUILD rapport — it holds
 *    steady for an open character and cools a guarded one slightly; you climb only on
 *    genuine +1/+2 turns. (Real letdowns score negative and cool everyone.)
 *  - GUARDED = SLOW TO WARM: only the upside is dampened by guardedness; a guarded
 *    person still cools at full speed, so they're easy to lose and hard to win.
 */
export function turnRapportDelta(engagement: number, opts: { guardedness?: number } = {}): number {
  const e = Math.max(-3, Math.min(3, Math.round(engagement)));
  const g = Math.max(0, Math.min(100, opts.guardedness ?? 0));
  let d = e >= 0 ? e * GUARDEDNESS.POS_STEP : e * GUARDEDNESS.NEG_STEP;
  if (e === 0) d -= GUARDEDNESS.IDLE_DRIFT_BASE + Math.round((g / 100) * GUARDEDNESS.IDLE_DRIFT_GUARD);
  if (d > 0) d *= 1 - (g / 100) * GUARDEDNESS.GAIN_DAMP;
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
