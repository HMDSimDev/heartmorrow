import { randomUUID } from 'node:crypto';
import { DEFAULT_PLAYER_ID } from '@dsim/shared';

/** Generate a unique id, optionally namespaced with a short prefix. */
export function newId(prefix?: string): string {
  const uuid = randomUUID();
  return prefix ? `${prefix}_${uuid}` : uuid;
}

/**
 * The player-profile id for a world. Each world is a self-contained save, so its
 * money, inventory, and persona live under a per-world player row. The legacy
 * single-player id (`player-default`) is migrated to the OLDEST world's id on
 * startup (see db/migrate-player-identity), so this format is the single source
 * of truth everywhere after that point.
 */
export function playerIdForWorld(worldId: string): string {
  return `player:${worldId}`;
}

/** Per-world player id, falling back to the legacy id for a world-less context
 *  (e.g. an orphaned character with no world). */
export function playerIdForWorldOrDefault(worldId: string | null | undefined): string {
  return worldId ? playerIdForWorld(worldId) : DEFAULT_PLAYER_ID;
}
