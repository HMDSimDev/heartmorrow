/**
 * Deterministic float in [0,1) from a string seed (FNV-1a). Used for per-(world,
 * day, …) rolls that must be STABLE for the day and replay-safe without any
 * persistence — availability, daily-text cadence, gift rolls, email cadence.
 */
export function hashFloat(seed: string): number {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h / 0x100000000; // divide by 2^32 → true half-open [0,1)
}

/** A seeded-random function: maps a string seed to a float in [0,1). */
export type SeededRandom = (seed: string) => number;
