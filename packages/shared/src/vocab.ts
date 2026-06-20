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
