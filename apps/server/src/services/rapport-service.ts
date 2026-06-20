import {
  RAPPORT_START,
  RAPPORT_LEAVE_FLOOR,
  rapportLabel,
  pickDateNeed,
  startingRapport,
  turnRapportDelta,
  type DateNeed,
  type RelationshipStatKey,
} from '@dsim/shared';
import { hashFloat } from '../lib/seeded-random';
import { sessionRapportRepo } from '../db/repositories';

/**
 * Live date "rapport": a per-session value (0..100) that rises and falls with how
 * well each of the player's messages lands. The final value drives the end-of-date
 * consequence (`rapportEndEffect`) and a too-low value makes the character lose
 * interest and leave early.
 *
 * It is DURABLE: an in-memory map is a write-through cache for hot live turns, but
 * every change is persisted to `session_rapport` so a date RESUMED after a server
 * restart (or one authored by the mock generator) keeps its real vibe instead of
 * snapping back to the neutral midpoint. `clearRapport` (called when the date ends)
 * drops both.
 */

const sessionRapport = new Map<string, number>();

/** Read the cache, falling back to the durable row (and warming the cache from it). */
function lookup(sessionId: string): number | undefined {
  const cached = sessionRapport.get(sessionId);
  if (cached !== undefined) return cached;
  const stored = sessionRapportRepo.get(sessionId);
  if (stored !== undefined) sessionRapport.set(sessionId, stored);
  return stored;
}

export function getRapport(sessionId: string): number {
  return lookup(sessionId) ?? RAPPORT_START;
}

function setRapport(sessionId: string, value: number): number {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  sessionRapport.set(sessionId, v);
  sessionRapportRepo.upsert(sessionId, v, Date.now());
  return v;
}

export function clearRapport(sessionId: string): void {
  sessionRapport.delete(sessionId);
  sessionRapportRepo.delete(sessionId);
}

/**
 * The live rapport for a session IF one has been established, else null. Unlike
 * {@link getRapport} (which falls back to the neutral start), this distinguishes
 * "no read yet" from "a read of 50" so a resumed date's trajectory bar stays honest.
 */
export function peekRapport(sessionId: string): number | null {
  return lookup(sessionId) ?? null;
}

/**
 * Seed this date's rapport to the character's guarded starting point if it hasn't
 * begun yet — so the FIRST judged turn (and the vibe label shown to the judge)
 * reflects a reserved character's cooler opening, not the neutral midpoint.
 * Idempotent: once a date has any rapport, this is a no-op.
 */
export function ensureRapportSeeded(sessionId: string, guardedness = 0): number {
  const existing = lookup(sessionId);
  if (existing === undefined) return setRapport(sessionId, startingRapport(guardedness));
  return existing;
}

/** The result of applying a turn: the new rapport plus the signed change this turn
 *  (so the UI can flash a +N / −N flourish on the trajectory bar). */
export interface RapportStep {
  rapport: number;
  delta: number;
}

/**
 * Apply a turn's engagement (−3..+3) to the running rapport, scaled by the
 * character's guardedness. A guarded character opens cooler (seeded lazily from
 * `startingRapport` on their first judged turn) and warms more slowly; a neutral
 * turn cools the date for everyone. Returns the new value and the signed delta.
 */
export function applyTurnEngagement(sessionId: string, engagement: number, guardedness = 0): RapportStep {
  const prev = lookup(sessionId) ?? startingRapport(guardedness);
  const rapport = setRapport(sessionId, prev + turnRapportDelta(engagement, { guardedness }));
  return { rapport, delta: rapport - prev };
}

export { rapportLabel };

/** True once rapport has cratered — the character is about to lose interest. */
export function hasLostInterest(sessionId: string): boolean {
  return getRapport(sessionId) <= RAPPORT_LEAVE_FLOOR;
}

/** What the character is quietly hoping for on this date (stable per world-day). */
export function dateNeedFor(worldId: string, day: number, characterId: string): DateNeed {
  return pickDateNeed(hashFloat(`${worldId}|${day}|${characterId}|need`));
}

/**
 * End-of-date consequence from the FINAL rapport — the real stakes. A great date
 * boosts warmth; a bad one nets negative (cooler + more tense), feeding the
 * breakup machine over repeated bad nights. Clamped server-side as always.
 */
export function rapportEndEffect(rapport: number): Partial<Record<RelationshipStatKey, number>> {
  if (rapport >= 82) return { affection: 4, chemistry: 3, comfort: 2, trust: 1 }; // a genuinely great night
  if (rapport >= 68) return { affection: 2, chemistry: 1, comfort: 1 };
  if (rapport >= 56) return { comfort: 1 };
  if (rapport >= 47) return {}; // narrow neutral band — the evaluator's own read stands
  if (rapport >= 36) return { comfort: -2, tension: 2 }; // flat/awkward — you lose a little ground
  if (rapport >= 22) return { affection: -3, comfort: -4, tension: 5 };
  return { affection: -6, comfort: -6, tension: 9 }; // a genuinely bad date sets you back hard
}

/** Stat hit when the character loses interest and ends the date early. */
export const RAPPORT_LEAVE_PENALTY: Partial<Record<RelationshipStatKey, number>> = {
  affection: -3,
  comfort: -5,
  tension: 6,
};
