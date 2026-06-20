import { z } from 'zod';
import type { DatingStatKey, RelationshipStatKey } from './stats';

/**
 * Work & "Together" activities — each costs a daily action (1 stamina) and passes
 * time. WORK earns money. TOGETHER is unstructured time spent with a chosen
 * character: it nudges a single relationship stat, but — unlike a flat grind — the
 * payoff is shaped by who they are (fit), how bold the outing is (risk), and how
 * much you've already leaned on them today (a per-person daily cap). Crucially,
 * casual time can only carry a bond so far: it never touches AFFECTION and tapers
 * to nothing near {@link TOGETHER_SOFT_CEILING}, so real DATES remain the only road
 * to the romantic bands. Effect magnitudes are server-defined here (never client-
 * supplied) and resolved by {@link resolveTogether}.
 */

export const ActivityKindSchema = z.enum(['work', 'together']);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

/** The "mood" of a Together outing — flavor that pairs with its fit traits. */
export const TogetherAngleSchema = z.enum(['cozy', 'deep', 'lively', 'playful', 'cultured']);
export type TogetherAngle = z.infer<typeof TogetherAngleSchema>;

export interface ActivityDef {
  id: string;
  kind: ActivityKind;
  label: string;
  description: string;
  /** Work: money earned per shift. */
  money?: number;
  /** Together: the primary relationship stat this nurtures. */
  relationshipStat?: RelationshipStatKey;
  /** Together: base delta to the primary stat at the easy end of the curve. */
  amount?: number;
  /** Together: the outing's mood (drives the tile glyph + copy). */
  angle?: TogetherAngle;
  /** Together: a diegetic emoji glyph for the tile. */
  icon?: string;
  /** Together: which character traits make this outing land well. */
  fitStats?: readonly DatingStatKey[];
  /** Together: 0..1 — how bold/intimate the move is (drives misfire risk). 0 = no risk. */
  boldness?: number;
  /** Together: a small secondary nudge (usually curiosity), never ceiling-bound. */
  secondaryStat?: RelationshipStatKey;
  secondaryAmount?: number;
  /** Together: small money cost (coffee, a day out). Omitted/0 = free. */
  cost?: number;
}

export const ACTIVITIES: readonly ActivityDef[] = [
  { id: 'work_shift', kind: 'work', label: 'Work a shift', description: 'Steady hours for steady pay.', money: 50 },
  { id: 'odd_jobs', kind: 'work', label: 'Hustle odd jobs', description: 'Grittier work, a better cut.', money: 90 },
  {
    id: 'tg_in',
    kind: 'together',
    label: 'A quiet evening in',
    description: 'Cook, talk, let the hours go slow. The safe, easy kind of closeness.',
    angle: 'cozy',
    icon: '☕',
    relationshipStat: 'comfort',
    amount: 5,
    fitStats: ['empathy'],
    boldness: 0, // the no-risk anchor — a quiet night in never backfires
  },
  {
    id: 'tg_talk',
    kind: 'together',
    label: 'A long heart-to-heart',
    description: 'Open up and really listen — the kind of talk that earns trust, or asks for too much too soon.',
    angle: 'deep',
    icon: '🌙',
    relationshipStat: 'trust',
    amount: 6,
    fitStats: ['empathy', 'intellect'],
    boldness: 0.55, // the boldest move — depth can misfire on a guarded near-stranger
  },
  {
    id: 'tg_out',
    kind: 'together',
    label: 'Out for a run together',
    description: 'Sweat, banter, a little chemistry on the move.',
    angle: 'lively',
    icon: '🏃',
    relationshipStat: 'chemistry',
    amount: 5,
    fitStats: ['confidence', 'style'],
    boldness: 0.3,
    secondaryStat: 'curiosity',
    secondaryAmount: 1,
  },
  {
    id: 'tg_play',
    kind: 'together',
    label: 'Mess around, no agenda',
    description: 'An afternoon of games and nonsense. Costs a little; almost always lands light.',
    angle: 'playful',
    icon: '🎲',
    relationshipStat: 'chemistry',
    amount: 4,
    fitStats: ['humor'],
    boldness: 0.15,
    secondaryStat: 'curiosity',
    secondaryAmount: 2,
    cost: 10,
  },
  {
    id: 'tg_culture',
    kind: 'together',
    label: 'Wander a gallery',
    description: 'Trade quiet opinions among the frames. Earns respect from the right sort of person.',
    angle: 'cultured',
    icon: '🖼️',
    relationshipStat: 'respect',
    amount: 5,
    fitStats: ['intellect', 'style'],
    boldness: 0.35,
    secondaryStat: 'curiosity',
    secondaryAmount: 1,
    cost: 15,
  },
];

// --- Together tuning (server-owned; resolved by resolveTogether) -------------

/**
 * The warmth value casual time can carry a single bonding stat toward — the lower
 * bound of the `getting-close` band (see WARMTH_BANDS). Gains taper smoothly to
 * nothing as a stat nears this, and stop entirely at it. Combined with the fact
 * that NO Together outing touches affection, this means time spent together can
 * make you genuinely warm friends-on-the-cusp, but the romantic bands (dating,
 * intimacy, milestones) can only be reached on a real date.
 */
export const TOGETHER_SOFT_CEILING = 45;

/** Same-day repeat scale with the SAME person: 1st full, 2nd faint, 3rd+ nothing. */
export const TOGETHER_REPEAT_SCALE = [1, 0.4, 0] as const;

/** Tension from crowding someone with repeat outings the same day (indexed like the scale). */
export const TOGETHER_CROWD_TENSION = [0, 1, 3] as const;

/** A bold move can misfire into tension — but never more likely than this. */
export const TOGETHER_MISFIRE_MAX = 0.4;

/** Distinct outcomes of a Together outing, surfaced to the player. */
export const TogetherOutcomeSchema = z.enum(['warm', 'spark', 'flat', 'crowded', 'misfire']);
export type TogetherOutcomeKind = z.infer<typeof TogetherOutcomeSchema>;

/** The structured read of how an outing landed (server-authoritative). */
export interface TogetherResult {
  outcome: TogetherOutcomeKind;
  /** The primary stat the outing aimed at. */
  stat: RelationshipStatKey;
  /** Net applied to the primary stat (>= 0). */
  statDelta: number;
  /** Tension applied (>= 0), if any. */
  tensionDelta: number;
  /** How well the outing suited them. */
  fit: 'great' | 'ok' | 'poor';
  /** Money spent on the outing. */
  cost: number;
  /** True when this became a remembered moment. */
  memorable: boolean;
}

export const PerformActivitySchema = z.object({
  activityId: z.string().min(1),
  worldId: z.string().min(1),
  characterId: z.string().min(1).nullable().default(null),
});
export type PerformActivity = z.input<typeof PerformActivitySchema>;
