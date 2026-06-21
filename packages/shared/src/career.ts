import { CAREER } from './constants';

/**
 * Career skills — the player's per-world job mastery. Every job feeds ONE skill
 * (several jobs can share a skill), the skill levels up with use, and the level
 * scales that skill's job pay via {@link masteryMult}. Persisted on the per-world
 * player as `career: { [skill]: { xp, level } }`. The math here is pure + shared so
 * the server (authoritative grants) and the client (progress bars, locked-job
 * hints, mastery-scaled pay previews) agree exactly.
 */

export const CAREER_SKILLS = ['service', 'hustle', 'craft', 'knowledge'] as const;
export type CareerSkill = (typeof CAREER_SKILLS)[number];

export const CAREER_SKILL_LABELS: Record<CareerSkill, string> = {
  service: 'Service',
  hustle: 'Hustle',
  craft: 'Craft',
  knowledge: 'Knowledge',
};

/** One-line flavor for each skill (UI subtitle). */
export const CAREER_SKILL_BLURBS: Record<CareerSkill, string> = {
  service: 'steady shifts and counter work',
  hustle: 'gigs, odd jobs, and side cuts',
  craft: 'trades and hard, hands-on labor',
  knowledge: 'writing, records, and know-how',
};

export function isCareerSkill(s: string | null | undefined): s is CareerSkill {
  return !!s && (CAREER_SKILLS as readonly string[]).includes(s);
}

/** Cumulative XP required to REACH a given level (level 0 = 0): XP_BASE·L·(L+1)/2. */
export function xpToReachLevel(level: number): number {
  const L = Math.max(0, Math.floor(level));
  return (CAREER.XP_BASE * (L * (L + 1))) / 2;
}

/** The level a cumulative XP total has earned, clamped to MAX_LEVEL. */
export function levelForXp(xp: number): number {
  let level = 0;
  while (level < CAREER.MAX_LEVEL && xp >= xpToReachLevel(level + 1)) level += 1;
  return level;
}

/** Pay multiplier for a skill level: 1 + STEP·level (L0 = 1.0 … L5 = 1.75). */
export function masteryMult(level: number): number {
  const L = Math.max(0, Math.min(CAREER.MAX_LEVEL, Math.floor(level)));
  return 1 + CAREER.MASTERY_STEP * L;
}

/** UI-friendly progress within the current level. */
export interface CareerProgress {
  level: number;
  xp: number;
  /** XP accumulated into the current level. */
  intoLevel: number;
  /** XP span of the current level (0 at max). */
  span: number;
  /** Fraction [0..1] toward the next level (1 at max). */
  pct: number;
  atMax: boolean;
}

export function careerProgress(xp: number): CareerProgress {
  const level = levelForXp(xp);
  const atMax = level >= CAREER.MAX_LEVEL;
  const base = xpToReachLevel(level);
  const next = xpToReachLevel(level + 1);
  const span = atMax ? 0 : next - base;
  const intoLevel = xp - base;
  const pct = atMax ? 1 : span > 0 ? Math.max(0, Math.min(1, intoLevel / span)) : 0;
  return { level, xp, intoLevel, span, pct, atMax };
}
