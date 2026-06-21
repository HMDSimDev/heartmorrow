import {
  WorldSchema,
  WorldNoteSchema,
  type World,
  type WorldCreate,
  type WorldUpdate,
  type WorldNote,
  type WorldNoteCreate,
  type WorldNoteUpdate,
} from '@dsim/shared';
import { getDb } from '../db/index';
import { charactersRepo, worldsRepo, worldNotesRepo } from '../db/repositories';
import { newId, playerIdForWorld } from '../lib/ids';
import { notFound } from '../lib/errors';
import { cloneCharactersToWorld } from './character-service';
import { clonePropertiesToWorld } from './property-service';
import { cloneCompaniesToWorld } from './market-service';

export function listWorlds(): World[] {
  return worldsRepo.list();
}

export function getWorld(id: string): World {
  const w = worldsRepo.get(id);
  if (!w) throw notFound(`World ${id} not found.`);
  return w;
}

export function createWorld(input: WorldCreate): World {
  const now = Date.now();
  const world = WorldSchema.parse({ ...input, id: newId('world'), createdAt: now, updatedAt: now });
  return worldsRepo.insert(world);
}

/**
 * Clone an existing world into a fresh save: its definition (summary, tone, lore,
 * rules, locations, content flags), its world notes, and its entire cast (copied as
 * fresh characters with links remapped within the cast). The new world starts with
 * its own clean progress — no relationships, money, or history carried over.
 */
export function cloneWorld(sourceId: string, name: string): World {
  const source = getWorld(sourceId);
  return getDb().transaction(() => {
    const created = createWorld({
      name: name.trim() || `${source.name} (Copy)`,
      summary: source.summary,
      tone: source.tone,
      globalNotes: source.globalNotes,
      rules: source.rules,
      lore: source.lore,
      locations: source.locations,
      featureFlags: source.featureFlags,
      gamblingConfig: source.gamblingConfig,
    });
    for (const n of worldNotesRepo.listByWorld(sourceId)) {
      createWorldNote(created.id, { title: n.title, body: n.body, tags: n.tags, scope: n.scope, importance: n.importance });
    }
    cloneCharactersToWorld(
      charactersRepo.listByWorld(sourceId).map((c) => c.id),
      created.id,
    );
    // Authored wealth content (property + company DEFINITIONS) travels with the world.
    clonePropertiesToWorld(sourceId, created.id);
    cloneCompaniesToWorld(sourceId, created.id);
    return created;
  });
}

export function updateWorld(id: string, patch: WorldUpdate): World {
  const current = getWorld(id);
  const next = WorldSchema.parse({ ...current, ...patch, id: current.id, updatedAt: Date.now() });
  return worldsRepo.update(next);
}

/**
 * Delete a world AND everything that belongs to it — a true cascade.
 *
 * `worlds` ON DELETE CASCADE only reaches the rows that carry a world_id FK
 * (world_notes, world_states, feed_*, npc_*, canon_facts). It does NOT reach:
 *  - characters (their world_id FK is ON DELETE SET NULL), and therefore none of
 *    the per-character progress hanging off them (relationships, memories,
 *    sessions+messages, threads+texts, chronicles, endings);
 *  - the no-FK / per-world-id tails (game_events, minigame_results, emails, and
 *    this world's player row + inventory).
 * So we delete those explicitly, in one transaction.
 *
 * `deleteCharacters` controls what happens to this world's people:
 *  - false (default): KEEP them as reusable definitions but unassign them
 *    (world_id → NULL) and wipe the playthrough progress they accrued here, so
 *    they resurface pristine under People → Unassigned. A character only ever
 *    lives in one world, so all of its attached progress belongs to this world
 *    and is safe to clear wholesale.
 *  - true: delete each character row, firing its ON DELETE CASCADE chain to
 *    clean up its progress.
 */
export function deleteWorld(id: string, deleteCharacters = false): void {
  getWorld(id);
  const db = getDb();
  const playerId = playerIdForWorld(id);
  db.transaction(() => {
    const worldChars = charactersRepo.listByWorld(id);
    if (deleteCharacters) {
      for (const c of worldChars) charactersRepo.delete(c.id);
    } else {
      const now = Date.now();
      for (const c of worldChars) {
        // Wipe this world's playthrough progress off the character (the same set a
        // character-delete cascade would reach), then detach it to unassigned.
        db.run('DELETE FROM relationships WHERE character_id = ?', c.id);
        db.run('DELETE FROM character_memories WHERE character_id = ?', c.id);
        db.run('DELETE FROM conversation_sessions WHERE character_id = ?', c.id); // cascades messages + rapport
        db.run('DELETE FROM message_threads WHERE character_id = ?', c.id); // cascades text_messages
        db.run('DELETE FROM character_chronicles WHERE character_id = ?', c.id);
        db.run('DELETE FROM character_endings WHERE character_id = ?', c.id);
        db.run('UPDATE characters SET world_id = NULL, updated_at = ? WHERE id = ?', now, c.id);
      }
    }
    db.run('DELETE FROM game_events WHERE world_id = ?', id);
    db.run('DELETE FROM minigame_results WHERE world_id = ?', id);
    db.run('DELETE FROM emails WHERE world_id = ?', id);
    db.run('DELETE FROM inventory_items WHERE player_id = ?', playerId);
    db.run('DELETE FROM players WHERE id = ?', playerId);
    // Cascades world_notes, world_states, feed_*, the derived world-sim tables, and
    // the wealth tables (properties/companies + ownership/holdings/prices/news all
    // carry a world_id FK ON DELETE CASCADE).
    worldsRepo.delete(id);
  });
}

// --- world notes ------------------------------------------------------------

export function listWorldNotes(worldId: string): WorldNote[] {
  getWorld(worldId);
  return worldNotesRepo.listByWorld(worldId);
}

export function createWorldNote(worldId: string, input: WorldNoteCreate): WorldNote {
  getWorld(worldId);
  const now = Date.now();
  const note = WorldNoteSchema.parse({ ...input, id: newId('note'), worldId, createdAt: now, updatedAt: now });
  return worldNotesRepo.insert(note);
}

export function updateWorldNote(id: string, patch: WorldNoteUpdate): WorldNote {
  const current = worldNotesRepo.get(id);
  if (!current) throw notFound(`World note ${id} not found.`);
  const next = WorldNoteSchema.parse({ ...current, ...patch, id: current.id, updatedAt: Date.now() });
  return worldNotesRepo.update(next);
}

export function deleteWorldNote(id: string): void {
  const current = worldNotesRepo.get(id);
  if (!current) throw notFound(`World note ${id} not found.`);
  worldNotesRepo.delete(id);
}
