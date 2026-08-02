/**
 * In-process guard for multi-step world day rollovers.
 *
 * A rollover commits some state before awaiting recap/world-sim LLM work, so a
 * plain mutex is not enough: a request created during that await could observe the
 * newly committed day, queue behind the rollover, and incorrectly act on it. This
 * synchronous guard lets day-sensitive entry points reject while the transition is
 * in flight. The server is single-process, so these operations are atomic with
 * respect to other request handlers.
 */
const advancingWorlds = new Set<string>();

/** Claim a world's rollover. Returns false when one is already in progress. */
export function beginWorldAdvance(worldId: string): boolean {
  if (advancingWorlds.has(worldId)) return false;
  advancingWorlds.add(worldId);
  return true;
}

/** Release a rollover claim. Always call from a finally block. */
export function endWorldAdvance(worldId: string): void {
  advancingWorlds.delete(worldId);
}

/** True while the world's multi-step day rollover is in flight. */
export function isWorldAdvancing(worldId: string): boolean {
  return advancingWorlds.has(worldId);
}
