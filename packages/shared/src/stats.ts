import { z } from 'zod';

/**
 * Stat definitions and helpers.
 *
 * Two layers of stats exist:
 *  - Character "dating" stats: intrinsic traits of a character.
 *  - "Relationship" stats: the evolving bond between the player and a character.
 *
 * All stat values are clamped to [STAT_MIN, STAT_MAX]. Clamping and mutation
 * are owned by the server's stat service — never by the client or the LLM.
 */

export const STAT_MIN = 0;
export const STAT_MAX = 100;

export const DATING_STAT_KEYS = [
  'charm',
  'empathy',
  'humor',
  'confidence',
  'intellect',
  'style',
] as const;
export type DatingStatKey = (typeof DATING_STAT_KEYS)[number];

export const RELATIONSHIP_STAT_KEYS = [
  'affection',
  'trust',
  'chemistry',
  'comfort',
  'respect',
  'curiosity',
  'tension',
] as const;
export type RelationshipStatKey = (typeof RELATIONSHIP_STAT_KEYS)[number];

export const DatingStatKeySchema = z.enum(DATING_STAT_KEYS);
export const RelationshipStatKeySchema = z.enum(RELATIONSHIP_STAT_KEYS);

/** Human-friendly labels for UI display. */
export const DATING_STAT_LABELS: Record<DatingStatKey, string> = {
  charm: 'Charm',
  empathy: 'Empathy',
  humor: 'Humor',
  confidence: 'Confidence',
  intellect: 'Intellect',
  style: 'Style',
};

/**
 * What each dating stat actually does in play. Surfaced in the Character
 * editor so authors understand the mechanical effect, not just the flavor.
 *
 * Today, dating stats feed three systems:
 *  - Together activities: each activity has "fit" stats; higher fit means
 *    bigger relationship gains (and fewer tension hits) from that activity.
 *  - Minigames: a character's highest stat picks their favorite minigame,
 *    which earns a small bonus and a warmer reaction when played.
 *  - Date conversations: the effective stats are shown to the model so it can
 *    color how the character talks (this is flavor, not a hard score).
 *
 * They may also drive additional systems in the future.
 */
export const DATING_STAT_DESCRIPTIONS: Record<DatingStatKey, string> = {
  charm: 'Attractiveness and social spark. Favors the timing-meter minigame.',
  empathy:
    'Emotional attunement. Boosts quiet/heart-to-heart Together activities; favors the sweet-and-sour minigame.',
  humor: 'Wit and playfulness. Boosts goofing-off Together activities; favors the two-truths-and-a-lie minigame.',
  confidence:
    'Self-assurance and boldness. Boosts active outings; favors the rhythm-serenade minigame.',
  intellect:
    'Depth and curiosity. Boosts deep-talk and culture Together activities; favors the lore-quiz minigame.',
  style:
    'Aesthetic sense and refinement. Boosts outings and culture activities; favors the memory-match minigame.',
};

export const RELATIONSHIP_STAT_LABELS: Record<RelationshipStatKey, string> = {
  affection: 'Affection',
  trust: 'Trust',
  chemistry: 'Chemistry',
  comfort: 'Comfort',
  respect: 'Respect',
  curiosity: 'Curiosity',
  tension: 'Tension',
};

export const StatValueSchema = z.number().int().min(STAT_MIN).max(STAT_MAX);

export const DatingStatsSchema = z.object({
  charm: StatValueSchema,
  empathy: StatValueSchema,
  humor: StatValueSchema,
  confidence: StatValueSchema,
  intellect: StatValueSchema,
  style: StatValueSchema,
});
export type DatingStats = z.infer<typeof DatingStatsSchema>;

export const RelationshipStatsSchema = z.object({
  affection: StatValueSchema,
  trust: StatValueSchema,
  chemistry: StatValueSchema,
  comfort: StatValueSchema,
  respect: StatValueSchema,
  curiosity: StatValueSchema,
  tension: StatValueSchema,
});
export type RelationshipStats = z.infer<typeof RelationshipStatsSchema>;

/** Clamp + round a single stat value to the valid range.
 * NaN floors to `min`; ±Infinity clamps to the respective bound. */
export function clampStat(value: number, min = STAT_MIN, max = STAT_MAX): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export const DEFAULT_DATING_STATS: DatingStats = {
  charm: 50,
  empathy: 50,
  humor: 50,
  confidence: 50,
  intellect: 50,
  style: 50,
};

export const DEFAULT_RELATIONSHIP_STATS: RelationshipStats = {
  affection: 5,
  trust: 5,
  chemistry: 5,
  comfort: 5,
  respect: 5,
  curiosity: 10,
  tension: 0,
};

/** Apply a partial set of deltas to a relationship stat block, clamping each result. */
export function applyRelationshipDeltas(
  current: RelationshipStats,
  deltas: Partial<Record<RelationshipStatKey, number>>,
): RelationshipStats {
  const next: RelationshipStats = { ...current };
  for (const key of RELATIONSHIP_STAT_KEYS) {
    const delta = deltas[key];
    if (typeof delta === 'number' && delta !== 0) {
      next[key] = clampStat(current[key] + delta);
    }
  }
  return next;
}

/** Apply a partial set of deltas to a dating stat block, clamping each result. */
export function applyDatingDeltas(
  current: DatingStats,
  deltas: Partial<Record<DatingStatKey, number>>,
): DatingStats {
  const next: DatingStats = { ...current };
  for (const key of DATING_STAT_KEYS) {
    const delta = deltas[key];
    if (typeof delta === 'number' && delta !== 0) {
      next[key] = clampStat(current[key] + delta);
    }
  }
  return next;
}
