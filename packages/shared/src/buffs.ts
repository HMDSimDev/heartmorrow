import { DATING_STAT_KEYS, clampStat, type DatingStatKey, type DatingStats } from './stats';

/**
 * Temporary dating-stat buffs, stored on a relationship's `flags` map:
 *   buff:<stat>    -> remaining sessions (number)
 *   buffAmt:<stat> -> delta applied while the buff is active (number)
 *
 * Buffs add to a character's EFFECTIVE dating stats during sessions; base stats
 * are never altered. They decay by one each time a session ends. These pure
 * helpers live in the shared package so the server and the web client compute
 * effective stats identically.
 */

type FlagMap = Record<string, number | string | boolean>;

const remainKey = (stat: DatingStatKey) => `buff:${stat}`;
const amtKey = (stat: DatingStatKey) => `buffAmt:${stat}`;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Compute effective dating stats by applying active buffs to the base stats. */
export function effectiveDatingStats(base: DatingStats, flags: FlagMap): DatingStats {
  const out: DatingStats = { ...base };
  for (const stat of DATING_STAT_KEYS) {
    if (num(flags[remainKey(stat)]) > 0) {
      out[stat] = clampStat(base[stat] + num(flags[amtKey(stat)]));
    }
  }
  return out;
}

/** Add/refresh a temporary buff on a flags map, returning a new flags object. */
export function setTempBuff(
  flags: FlagMap,
  stat: DatingStatKey,
  delta: number,
  durationSessions: number,
): FlagMap {
  const next: FlagMap = { ...flags };
  next[remainKey(stat)] = Math.max(num(next[remainKey(stat)]), durationSessions);
  next[amtKey(stat)] = num(next[amtKey(stat)]) + delta;
  return next;
}

/**
 * Decrement all active buffs by one session; clear expired ones. `changed` is true
 * only when at least one active buff was decremented/expired — callers use it to
 * skip a redundant persist when there was nothing to decay (the returned `flags` is
 * the original object reference in that case).
 */
export function decayBuffs(flags: FlagMap): { flags: FlagMap; expired: DatingStatKey[]; changed: boolean } {
  const next: FlagMap = { ...flags };
  const expired: DatingStatKey[] = [];
  let changed = false;
  for (const stat of DATING_STAT_KEYS) {
    const remaining = num(next[remainKey(stat)]);
    if (remaining > 0) {
      changed = true;
      const updated = remaining - 1;
      if (updated <= 0) {
        delete next[remainKey(stat)];
        delete next[amtKey(stat)];
        expired.push(stat);
      } else {
        next[remainKey(stat)] = updated;
      }
    }
  }
  return { flags: changed ? next : flags, expired, changed };
}

/** List active buffs for UI display. */
export function listActiveBuffs(
  flags: FlagMap,
): Array<{ stat: DatingStatKey; delta: number; remaining: number }> {
  const buffs: Array<{ stat: DatingStatKey; delta: number; remaining: number }> = [];
  for (const stat of DATING_STAT_KEYS) {
    const remaining = num(flags[remainKey(stat)]);
    if (remaining > 0) buffs.push({ stat, delta: num(flags[amtKey(stat)]), remaining });
  }
  return buffs;
}

/** True for relationship-flag keys that are internal buff bookkeeping. */
export function isBuffFlagKey(key: string): boolean {
  return key.startsWith('buff:') || key.startsWith('buffAmt:');
}
