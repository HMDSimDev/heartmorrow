import { DEFAULT_PLAYER_ID } from '@dsim/shared';
import { getDb } from './index';
import { playerIdForWorld } from '../lib/ids';

/**
 * One-time data migration to per-world player identity.
 *
 * Before per-world saves, the app modelled a single global player (`player-default`)
 * whose money, persona, and inventory were shared across every world. Now each world
 * is a self-contained save with its own player row (`player:${worldId}`). This moves
 * the legacy global player — money, persona, and inventory — onto the OLDEST world
 * (the user's original save), so existing progress is preserved rather than orphaned.
 *
 * Only the players row and inventory are re-keyed: relationships, threads, emails,
 * chronicles, endings and the feed remain keyed on DEFAULT_PLAYER_ID because they are
 * already world-isolated through their character / world_id and are never joined to
 * the players table.
 *
 * Idempotent: guarded by the presence of the legacy `player-default` players row, which
 * this migration renames away. Runs only at real-server startup (not in tests).
 */
export function migratePlayerIdentity(): void {
  const db = getDb();
  const legacy = db.get<{ id: string }>('SELECT id FROM players WHERE id = ?', DEFAULT_PLAYER_ID);
  if (!legacy) return; // already migrated, or a fresh per-world install

  const oldest = db.get<{ id: string }>('SELECT id FROM worlds ORDER BY created_at ASC LIMIT 1');
  if (!oldest) return; // no worlds yet — nothing to attach the legacy save to

  const primaryPlayerId = playerIdForWorld(oldest.id);
  db.transaction(() => {
    // If a per-world row for the oldest world somehow already exists, drop the legacy
    // row instead of colliding on the primary-key rename.
    const clash = db.get<{ id: string }>('SELECT id FROM players WHERE id = ?', primaryPlayerId);
    if (clash) {
      db.run('DELETE FROM players WHERE id = ?', DEFAULT_PLAYER_ID);
    } else {
      db.run('UPDATE players SET id = ? WHERE id = ?', primaryPlayerId, DEFAULT_PLAYER_ID);
    }
    db.run('UPDATE inventory_items SET player_id = ? WHERE player_id = ?', primaryPlayerId, DEFAULT_PLAYER_ID);
  });
}
