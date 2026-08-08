import {
  FlipConfigSchema,
  FlipSubmissionSchema,
  MinigameRewardSchema,
  type MinigameInfo,
} from '@dsim/shared';
import { newId } from '../lib/ids';
import { hashFloat } from '../lib/seeded-random';
import {
  scoreToGrade,
  type BuiltMinigame,
  type MinigameBuildContext,
  type MinigameModule,
  type ResolveResult,
} from './registry';

/**
 * The Flip — a money-only SKILL JOB (no character, no relationship): hawk a
 * spread of scrounged goods to a queue of market-day buyers. Each buyer hides a
 * walk-away CEILING; two honest tells signal it — the first says how much they
 * WANT the piece (which tier the ceiling sits in), the second how deep their
 * PURSE runs (which half of that tier). Quote at or under the ceiling and they
 * pay YOUR price; over it and they walk with nothing. An accepted deal can be
 * "pressed" for a richer cut — which succeeds only if the raised price still
 * clears the ceiling, and otherwise kills the whole sale.
 *
 * THE ECONOMY IS THE MARGIN: a piece sold at its street value earns nothing —
 * only what a buyer pays ABOVE the shown worth is profit, and that profit (flat-
 * capped by the service) is EXACTLY the coin paid out. Unlike the other jobs
 * there is deliberately no grade-mult on the reward: the pouch the player
 * watched fill IS the payout, so the fiction and the wallet always agree. The
 * grade still reflects skill (profit as a fraction of the queue's maximum
 * possible margin, so a stingy draw can't sink a well-played shift) and scales
 * the career XP as usual. A lean queue pays lean even when read perfectly —
 * that swing is Hustle's identity.
 *
 * Unlike the Woodlot's per-world-stable grain, buyers are seeded PER RUN — a
 * hidden-information game collapses into a memorized script if it repeats.
 * Security model mirrors the other games: the ceiling ships in the config so the
 * client can adjudicate accept-vs-walk live (the honest UI never shows it), but
 * the server keeps its own copy in run state and re-derives the profit/score
 * from the raw quote sequence — the client never claims an outcome or a number.
 */

const INFO: MinigameInfo = {
  id: 'flip',
  title: 'The Flip',
  description: 'Market-day hustle — read what each buyer wants and what their purse can bear, then price above the piece’s worth: the margin is yours to keep. Greed pays, right up until it doesn’t.',
  targetStats: [],
  rewardsCharacter: false,
  mode: 'job',
  glyph: '⚖️',
  skill: 'hustle',
  skillXp: 55,
};

/** Buyers in one market-day shift. */
const BUYERS = 6;
/** What a "press" asks for on top of an accepted quote. */
const PRESS_MULT = 1.2;
/** Flat cap on a shift's profit payout (the service clamps money here anyway). */
const MAX_PAY = 100;

/** The stall's stock — item flavor plus its shown street value. */
const STOCK = [
  { item: 'a brass pocket compass', glyph: '🧭', value: 45 },
  { item: 'a chipped enamel teapot', glyph: '🫖', value: 20 },
  { item: 'a roll of old tide charts', glyph: '🗺️', value: 30 },
  { item: 'a lantern with amber glass', glyph: '🏮', value: 35 },
  { item: 'a fountain pen, nib intact', glyph: '🖋️', value: 40 },
  { item: 'a fox-head walking cane', glyph: '🦊', value: 50 },
  { item: 'a box of tin soldiers', glyph: '🪖', value: 25 },
  { item: 'a pocket watch that runs slow', glyph: '⌚', value: 55 },
  { item: 'a pair of opera glasses', glyph: '🎭', value: 45 },
  { item: 'a hand-stitched star atlas', glyph: '✨', value: 60 },
  { item: 'a dented brass spyglass', glyph: '🔭', value: 50 },
  { item: 'a jar of odd buttons', glyph: '🫙', value: 15 },
  { item: 'a violin missing one string', glyph: '🎻', value: 60 },
  { item: 'a cast-iron doorstop hound', glyph: '🐕', value: 25 },
  { item: 'a silk scarf, barely worn', glyph: '🧣', value: 30 },
  { item: 'a deck of fortune cards', glyph: '🃏', value: 35 },
] as const;

/** Ceiling tiers as multiplier bands over an item's street value. The first tell
 *  names the tier; the second narrows it to a half-band. Bands are sized so a
 *  typical queue's maximum possible MARGIN sums to roughly the flat pay cap —
 *  perfect reads earn about what a flawless Woodlot shift does. */
const TIERS = [
  { key: 'cold', lo: 1.05, hi: 1.3 },
  { key: 'warm', lo: 1.3, hi: 1.6 },
  { key: 'eager', lo: 1.6, hi: 2.0 },
] as const;

/** Tell #1 — desire. Honest: drawn from the buyer's actual tier. */
const DESIRE_TELLS: Record<(typeof TIERS)[number]['key'], readonly string[]> = {
  cold: [
    'Arms crossed, already glancing down the lane.',
    'Turns it over once and sets it straight back down.',
    'Sniffs that they’ve seen three of these this month.',
    'Keeps one foot pointed toward the next stall.',
  ],
  warm: [
    'Picks it up twice, trying to look casual about it.',
    'Asks what else you’ve got, but their eyes stay on it.',
    'Hums and haws, thumbing their coat button.',
    'Mentions a cousin who’d “maybe” want such a thing.',
  ],
  eager: [
    'Eyes go wide the moment they spot it — no hiding it.',
    'Already holding it like it’s theirs.',
    'Says they’ve hunted one of these for months.',
    'Waves their companion over to come and see, beaming.',
  ],
};

/** Tell #2 — purse. Honest: low half of the tier band vs the high half. */
const PURSE_TELLS: Record<'low' | 'high', readonly string[]> = {
  low: [
    'Counts through a thin purse with a small frown.',
    'Mutters that money’s tight till payday.',
    'Keeps glancing at the clock tower like it owes them.',
    'Claims the last stall offered “a fairer deal.”',
  ],
  high: [
    'A heavy coin purse swings openly at their belt.',
    'Says price is “no great matter” a little too quickly.',
    'Dressed like money has never once been the question.',
    'Fingers are already at the purse strings.',
  ],
};

interface FlipState {
  /** The authoritative worth/ceiling pairs, in buyer order. */
  buyers: Array<{ base: number; ceiling: number }>;
  pressMult: number;
}

function pick<T>(pool: readonly T[], roll: number): T {
  return pool[Math.min(pool.length - 1, Math.floor(roll * pool.length))]!;
}

export const flipModule: MinigameModule = {
  info: INFO,

  build(_ctx: MinigameBuildContext): Promise<BuiltMinigame> {
    // Seeded per RUN (not per world): a fresh queue every shift, deterministic
    // only in the sense that one seed fully decides it. Needs no character or
    // world, so it runs in the framework's character-null "job mode".
    // Seed shape matters: the varying index goes MID-string with a constant tag
    // LAST (the `…|day|…|mood` idiom) — FNV-1a barely diffuses a change in the
    // final character, so `…|tier|${i}` would deal every buyer the same roll.
    const seed = newId('flip');
    const stock = STOCK
      .map((it, i) => ({ it, k: hashFloat(`${seed}|${i}|stock`) }))
      .sort((a, b) => a.k - b.k)
      .slice(0, BUYERS);
    const buyers = stock.map(({ it }, i) => {
      const tier = pick(TIERS, hashFloat(`${seed}|${i}|tier`));
      const highHalf = hashFloat(`${seed}|${i}|half`) >= 0.5;
      const mid = (tier.lo + tier.hi) / 2;
      const lo = highHalf ? mid : tier.lo;
      const hi = highHalf ? tier.hi : mid;
      const mult = lo + hashFloat(`${seed}|${i}|mult`) * (hi - lo);
      return {
        item: it.item,
        glyph: it.glyph,
        baseValue: it.value,
        tells: [
          pick(DESIRE_TELLS[tier.key], hashFloat(`${seed}|${i}|desire`)),
          pick(PURSE_TELLS[highHalf ? 'high' : 'low'], hashFloat(`${seed}|${i}|purse`)),
        ],
        // Never below value+1, so quoting the shown street value always sells.
        ceiling: Math.max(it.value + 1, Math.round(it.value * mult)),
      };
    });
    const config = FlipConfigSchema.parse({ buyers, pressMult: PRESS_MULT });
    return Promise.resolve({
      config,
      state: {
        buyers: buyers.map((b) => ({ base: b.baseValue, ceiling: b.ceiling })),
        pressMult: PRESS_MULT,
      } satisfies FlipState,
    });
  },

  resolve(submission: unknown, state: unknown): ResolveResult {
    const sub = FlipSubmissionSchema.parse(submission);
    const { buyers, pressMult } = state as FlipState;

    // Re-derive every outcome from the raw quotes against the SERVER's ceilings —
    // the client never says what sold. A buyer with no deal entry earned nothing
    // (bailing early costs you), and extra entries beyond the queue are ignored.
    // Only the MARGIN above a piece's worth counts: a sale at (or, from a hostile
    // client, below) street value clears nothing.
    let profit = 0;
    buyers.forEach(({ base, ceiling }, i) => {
      const deal = sub.deals[i];
      if (!deal || deal.quote > ceiling) return; // never engaged, or they walked
      const paid = deal.pressed ? Math.round(deal.quote * pressMult) : deal.quote;
      if (paid > ceiling) return; // a greedy press kills the whole sale
      profit += Math.max(0, paid - base);
    });

    // Grade against the most this queue could EVER have cleared (each ceiling met
    // exactly), so the score reflects the reads, not the luck of the draw. The
    // ceiling construction guarantees at least +1 per buyer, so maxProfit > 0.
    const maxProfit = buyers.reduce((n, b) => n + (b.ceiling - b.base), 0);
    const score = Math.round((profit / maxProfit) * 100);
    const grade = scoreToGrade(score);

    // The payout IS the cleared margin (flat-capped) — no grade-mult on purpose:
    // the pouch the player watched fill must be exactly the coin that arrives.
    // No-margin play already earns nothing, so F-earns-nothing holds naturally;
    // the grade's job here is the score display + the career-XP scaling.
    return {
      score,
      grade,
      reward: MinigameRewardSchema.parse({ dating: {}, relationship: {}, money: Math.min(MAX_PAY, profit) }),
    };
  },
};
