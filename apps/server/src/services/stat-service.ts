import {
  CharacterSchema,
  RelationshipSchema,
  applyRelationshipDeltas,
  applyDatingDeltas,
  warmthOf,
  incompatibleWarmthCap,
  LAST_DATE_FLAG,
  LAST_SEEN_FLAG,
  NEGLECT_DAILY_DECAY,
  type Character,
  type DatingStatKey,
  type Relationship,
  type RelationshipStatKey,
} from '@dsim/shared';
import { charactersRepo, relationshipsRepo } from '../db/repositories';
import { notFound } from '../lib/errors';
import { ensureRelationship } from './relationship-service';
import { recordEvent } from './event-service';
import { decayBuffs, setTempBuff } from './buffs';
import { romanticCompatFor, type RomanticCompat } from './compatibility-service';

/** The five bonding stats that make up "warmth" (matches `warmthOf`). */
const WARMTH_KEYS = ['affection', 'trust', 'chemistry', 'comfort', 'respect'] as const;
/** Reveal the character's orientation once warmth climbs to within this of the ceiling. */
const REVEAL_WARMTH_MARGIN = 4;

/**
 * The central stat service. EVERY stat change in the game flows through here.
 * It validates, clamps, persists, and records a GameEvent. Neither the client
 * nor the LLM mutates stats directly — they can only *propose* changes that
 * this service validates and clamps.
 */

export interface StatChangeMeta {
  source: string; // e.g. "session_eval", "item_use", "minigame"
  detail?: Record<string, unknown>;
}

/** Apply clamped relationship deltas and record the change. */
export function applyRelationshipChange(
  characterId: string,
  deltas: Partial<Record<RelationshipStatKey, number>>,
  meta: StatChangeMeta,
): Relationship {
  const current = ensureRelationship(characterId);
  let merged: Relationship = { ...current, ...applyRelationshipDeltas(current, deltas) };

  // ORIENTATION GATE: if the player and character aren't a plausible romantic
  // match, cap warmth growth at the incompatible ceiling. Because dating,
  // milestones, jealousy and intimacy ALL unlock at the 'getting-close' band,
  // capping warmth below it blocks every romance mechanic in one place — the
  // pairing can stay friendly acquaintances but never become a couple.
  const compat = romanticCompatFor(characterId);
  if (compat && !compat.mutual) {
    const cap = Math.max(incompatibleWarmthCap(), warmthOf(current)); // never yank existing warmth down
    merged = capWarmthGrowth(current, merged, cap);
  }

  const next = RelationshipSchema.parse({ ...merged, updatedAt: Date.now() });
  const saved = relationshipsRepo.update(next);
  recordEvent('relationship_change', {
    characterId,
    source: meta.source,
    deltas,
    after: pickRelationshipStats(saved),
    ...meta.detail,
  });

  // Once an incompatible bond has plateaued near the ceiling AND it's the character
  // who isn't into the player, they reveal their orientation and decline romance.
  if (compat && !compat.mutual && !compat.bIntoA) maybeRevealOrientation(saved, compat);

  return saved;
}

/** Trim a relationship's POSITIVE warmth growth so its warmth never exceeds `cap`.
 *  Only the gains over `prev` are cut (existing warmth is preserved); negative
 *  changes, curiosity, and tension are untouched. */
function capWarmthGrowth(prev: Relationship, next: Relationship, cap: number): Relationship {
  let over = WARMTH_KEYS.reduce((s, k) => s + next[k], 0) - cap * WARMTH_KEYS.length;
  if (over <= 0) return next;
  const out = { ...next };
  for (const k of WARMTH_KEYS) {
    if (over <= 0) break;
    const gain = Math.max(0, next[k] - prev[k]);
    const cut = Math.min(gain, over);
    if (cut > 0) {
      out[k] = next[k] - cut;
      over -= cut;
    }
  }
  return out;
}

/** Fire the one-time orientation reveal: mark it, queue a kind reveal text, record it. */
function maybeRevealOrientation(rel: Relationship, compat: RomanticCompat): void {
  if (rel.flags['state:orientationRevealed'] === true) return;
  if (warmthOf(rel) < incompatibleWarmthCap() - REVEAL_WARMTH_MARGIN) return; // not yet acquainted enough
  setRelationshipFlag(rel.characterId, 'state:orientationRevealed', true, { source: 'orientation' });
  // Queue a reveal text via the existing relationship-beat path, unless a more
  // urgent beat (rocks/breakup) is already waiting.
  if (!ensureRelationship(rel.characterId).flags['beat:pending']) {
    setRelationshipFlag(rel.characterId, 'beat:pending', 'orientation', { source: 'orientation' });
  }
  recordEvent('orientation_revealed', {
    characterId: rel.characterId,
    sexuality: compat.character.sexuality,
    gender: compat.character.gender,
  });
}

/** Apply clamped dating-stat deltas to a character's base stats. */
export function applyCharacterDatingChange(
  characterId: string,
  deltas: Partial<Record<DatingStatKey, number>>,
  meta: StatChangeMeta,
): Character {
  const character = charactersRepo.get(characterId);
  if (!character) throw notFound(`Character ${characterId} not found.`);
  const updated = applyDatingDeltas(character.datingStats, deltas);
  const next = CharacterSchema.parse({ ...character, datingStats: updated, updatedAt: Date.now() });
  const saved = charactersRepo.update(next);
  recordEvent('dating_stat_change', { characterId, source: meta.source, deltas, after: saved.datingStats, ...meta.detail });
  return saved;
}

/** Set or clear a relationship flag. */
export function setRelationshipFlag(
  characterId: string,
  flag: string,
  value: boolean | number | string,
  meta: StatChangeMeta,
): Relationship {
  const current = ensureRelationship(characterId);
  const flags = { ...current.flags, [flag]: value };
  const next = RelationshipSchema.parse({ ...current, flags, updatedAt: Date.now() });
  const saved = relationshipsRepo.update(next);
  recordEvent('relationship_flag', { characterId, source: meta.source, flag, value });
  return saved;
}

/** Apply a temporary dating-stat buff stored on the relationship flags. */
export function applyTempBuff(
  characterId: string,
  stat: DatingStatKey,
  delta: number,
  durationSessions: number,
  meta: StatChangeMeta,
): Relationship {
  const current = ensureRelationship(characterId);
  const flags = setTempBuff(current.flags, stat, delta, durationSessions);
  const next = RelationshipSchema.parse({ ...current, flags, updatedAt: Date.now() });
  const saved = relationshipsRepo.update(next);
  recordEvent('temp_buff', { characterId, source: meta.source, stat, delta, durationSessions });
  return saved;
}

/** Decay active buffs by one session (called when a session ends). */
export function decayRelationshipBuffs(characterId: string): Relationship {
  const current = ensureRelationship(characterId);
  const { flags, expired, changed } = decayBuffs(current.flags);
  if (!changed) return current; // nothing to decay — skip the redundant persist
  const next = RelationshipSchema.parse({ ...current, flags, updatedAt: Date.now() });
  const saved = relationshipsRepo.update(next);
  if (expired.length > 0) recordEvent('buff_expired', { characterId, expired });
  return saved;
}

/** Record the world-day a character was last seen (drives neglect + prompts). */
export function stampLastSeen(characterId: string, day: number): Relationship {
  const current = ensureRelationship(characterId);
  const flags = { ...current.flags, [LAST_SEEN_FLAG]: day };
  const next = RelationshipSchema.parse({ ...current, flags, updatedAt: Date.now() });
  return relationshipsRepo.update(next);
}

/** Record an IN-PERSON meeting (date / activity / minigame): stamps BOTH the
 *  last-seen clock (so neglect stays in sync) AND the last-DATE clock the date
 *  greeting reads. Texting uses stampLastSeen (last-seen only), so a heavy texter
 *  who hasn't visited in person still triggers the "it's been a while" greeting. */
export function stampLastDate(characterId: string, day: number): Relationship {
  const current = ensureRelationship(characterId);
  const flags = { ...current.flags, [LAST_SEEN_FLAG]: day, [LAST_DATE_FLAG]: day };
  const next = RelationshipSchema.parse({ ...current, flags, updatedAt: Date.now() });
  return relationshipsRepo.update(next);
}

/**
 * Apply one day of neglect decay (used by the day-advance pass). `mult` scales
 * the decay by commitment — a neglected live-in partner drifts faster than a
 * casual date (see NEGLECT_BY_STATUS). Deltas are re-rounded after scaling.
 */
export function applyNeglectDecay(characterId: string, daysNeglected: number, mult = 1): Relationship {
  const scaled = Object.fromEntries(
    Object.entries(NEGLECT_DAILY_DECAY).map(([k, v]) => [k, Math.round(v * mult)]),
  ) as Partial<Record<RelationshipStatKey, number>>;
  return applyRelationshipChange(characterId, scaled, {
    source: 'neglect',
    detail: { daysNeglected, mult },
  });
}

function pickRelationshipStats(rel: Relationship) {
  const { affection, trust, chemistry, comfort, respect, curiosity, tension } = rel;
  return { affection, trust, chemistry, comfort, respect, curiosity, tension };
}
