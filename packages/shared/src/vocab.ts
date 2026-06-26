import { z } from 'zod';

/**
 * Canonical gameplay vocabularies. These replace what used to be free-form LLM /
 * creator strings (date expressions, memory tags) with fixed, mappable sets — so
 * the UI can always resolve them and behavior is deterministic. The LLM is told to
 * pick from these lists; anything off-list is coerced/dropped here, never stored.
 */

// --- Date expressions (drive the character portrait) ------------------------

export const EXPRESSIONS = [
  'neutral',
  'happy',
  'smiling',
  'laughing',
  'flirty',
  'tender',
  'shy',
  'blushing',
  'thoughtful',
  'surprised',
  'excited',
  'bored',
  'uncomfortable',
  'worried',
  'annoyed',
  'sad',
  'hurt',
  'angry',
] as const;
export type Expression = (typeof EXPRESSIONS)[number];
export const ExpressionSchema = z.enum(EXPRESSIONS);
export const DEFAULT_EXPRESSION: Expression = 'neutral';

export const EXPRESSION_LABELS: Record<Expression, string> = {
  neutral: 'Neutral',
  happy: 'Happy',
  smiling: 'Smiling',
  laughing: 'Laughing',
  flirty: 'Flirty',
  tender: 'Tender',
  shy: 'Shy',
  blushing: 'Blushing',
  thoughtful: 'Thoughtful',
  surprised: 'Surprised',
  excited: 'Excited',
  bored: 'Bored',
  uncomfortable: 'Uncomfortable',
  worried: 'Worried',
  annoyed: 'Annoyed',
  sad: 'Sad',
  hurt: 'Hurt',
  angry: 'Angry',
};

/** Coerce any value to a canonical expression, falling back to neutral. */
export function toExpression(value: unknown): Expression {
  return typeof value === 'string' && (EXPRESSIONS as readonly string[]).includes(value)
    ? (value as Expression)
    : DEFAULT_EXPRESSION;
}

// --- Memory tags (categorize a remembered moment) ---------------------------

export const MEMORY_TAGS = [
  // Date-moment flavors the LLM picks from.
  'date',
  'sweet',
  'funny',
  'flirty',
  'vulnerable',
  'conflict',
  'plans',
  'shared_interest',
  'met_people',
  'gift',
  // Engine-driven relationship beats.
  'milestone',
  'relationship',
  'jealousy',
  'breakup',
  'reconcile',
  'memorial',
  'ending',
  'social',
  'minigame',
  'npc_life',
  // A beat that happened inside a Wayfarer quest scene.
  'quest',
] as const;
export type MemoryTag = (typeof MEMORY_TAGS)[number];
export const MemoryTagSchema = z.enum(MEMORY_TAGS);

/** Tag marking a memory of the character's OWN off-screen life (from the world-sim). */
export const NPC_LIFE_TAG: MemoryTag = 'npc_life';

export function isMemoryTag(value: unknown): value is MemoryTag {
  return typeof value === 'string' && (MEMORY_TAGS as readonly string[]).includes(value);
}

/**
 * A zod array of memory tags that keeps ONLY canonical values and drops anything
 * else (an off-list LLM tag, or a legacy stored tag). Used for both the LLM
 * candidate shape and the persisted memory, so a non-canonical tag can never reach
 * storage AND legacy rows still load (their stray tags are simply filtered out).
 */
export const MemoryTagArraySchema = z
  .array(z.string())
  .default([])
  .transform((arr): MemoryTag[] => arr.filter(isMemoryTag).slice(0, 8));

// --- Quest mode (Wayfarer) --------------------------------------------------

/**
 * The quest vocabularies. Like the date expressions above, these are CLOSED sets
 * the LLM picks from — never free-form. They are *classification targets* (the
 * Interpreter coerces freeform player intent onto them) and *consequence
 * primitives* (the referee composes outcomes from them). Anything off-list is
 * coerced to a safe default via `.catch()`, so a hallucinated value can never
 * reach the deterministic referee or game state. See `docs/quest-mode-plan.md`.
 */

/**
 * Verbs are a CLASSIFICATION target, not the action space (~a dozen, off-list → noop).
 *
 * `talk` is the neutral conversational verb — asking, greeting, querying — distinct
 * from the *leverage* verbs (`persuade`/`deceive`/`charm`/`intimidate`), so an
 * information request is never mistaken for a bluff. `noop` is a NON-diegetic
 * sentinel (not a real in-world action): the interpreter routes self-directed,
 * meta/OOC, impossible, or nonsensical input to it, and the referee resolves it as
 * a do-nothing beat — kept away from the dice AND the narrator. It is the `.catch()`
 * target so any off-list hallucination also degrades to a safe no-op rather than a
 * real verb. (Authoring surfaces hide `noop`; it is a classification result only.)
 */
export const QUEST_VERBS = [
  'inspect',
  'move',
  'use_item',
  'talk',
  'persuade',
  'intimidate',
  'deceive',
  'charm',
  'sneak',
  'force',
  'aid',
  'attack',
  'wait',
  'noop',
] as const;
export type QuestVerb = (typeof QUEST_VERBS)[number];
export const QuestVerbSchema = z.enum(QUEST_VERBS).catch('noop');

/** How hard the Interpreter judged the attempt to be — gates the proportionality tier. */
export const DIFFICULTY_BANDS = ['trivial', 'normal', 'hard', 'desperate'] as const;
export type DifficultyBand = (typeof DIFFICULTY_BANDS)[number];
export const DifficultyBandSchema = z.enum(DIFFICULTY_BANDS).catch('normal');

/** The four grades a seeded check resolves to — the referee owns this, never the LLM. */
export const OUTCOME_GRADES = ['success', 'partial', 'fail', 'complication'] as const;
export type OutcomeGrade = (typeof OUTCOME_GRADES)[number];
export const OutcomeGradeSchema = z.enum(OUTCOME_GRADES).catch('fail');

/** The closed consequence grammar — every outcome is a COMPOSITION of these primitives. */
export const EFFECT_OPS = [
  'setFlag',
  'clearFlag',
  'moveEntityToFaction', // the "switch sides" primitive
  'adjustWarmth', // → stat-service, capped + anti-grind
  'adjustStat', // player stat OR an entity's hp/disposition, clamped
  'grantItem',
  'removeItem',
  'addMoney', // → addMoney(), capped
  'moveToNode', // authored routing (gated; desperate tier only)
  'endScene',
] as const;
export type EffectOp = (typeof EFFECT_OPS)[number];
export const EffectOpSchema = z.enum(EFFECT_OPS).catch('setFlag');

/** A scene entity's allegiance — mutable, the target of `moveEntityToFaction`. */
export const QUEST_FACTIONS = ['party', 'ally', 'neutral', 'hostile'] as const;
export type QuestFaction = (typeof QUEST_FACTIONS)[number];
export const QuestFactionSchema = z.enum(QUEST_FACTIONS).catch('neutral');

/** Lifecycle of a quest run. */
export const QUEST_STATUSES = ['active', 'resolved', 'abandoned'] as const;
export type QuestStatus = (typeof QUEST_STATUSES)[number];
export const QuestStatusSchema = z.enum(QUEST_STATUSES).catch('active');

/** The SHAPES of an authored end condition; each compiles to a state predicate. */
export const GOAL_KINDS = ['defeat', 'persuade', 'acquire', 'reach', 'survive', 'flag'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];
export const GoalKindSchema = z.enum(GOAL_KINDS).catch('flag');

/** Whether satisfying a goal predicate WINS or LOSES the quest. */
export const GOAL_OUTCOMES = ['win', 'lose'] as const;
export type GoalOutcome = (typeof GOAL_OUTCOMES)[number];
export const GoalOutcomeSchema = z.enum(GOAL_OUTCOMES).catch('win');
