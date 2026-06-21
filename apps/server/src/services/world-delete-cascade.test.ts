import { describe, it, expect, beforeEach } from 'vitest';
import { MinigameResultSchema } from '@dsim/shared';
import { resetDb } from '../test/helpers';
import { getDb } from '../db/index';
import { createWorld, deleteWorld } from './world-service';
import { createCharacter } from './character-service';
import { applyRelationshipChange } from './stat-service';
import { ensureWorldState } from './world-clock-service';
import { performActivity } from './activity-service';
import { createShopItem, purchaseItem } from './shop-service';
import { getOrCreateThread } from './text-message-service';
import { recordEvent } from './event-service';
import { charactersRepo, worldsRepo, worldStatesRepo, minigameResultsRepo, playersRepo } from '../db/repositories';
import { playerIdForWorld } from '../lib/ids';

beforeEach(() => resetDb());

function rows(table: string, where: string, ...params: Array<string | number>): number {
  const r = getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params);
  return r ? Number(r.n) : 0;
}

/** Seed a world with a full slice of per-character + per-world progress. */
function seedFullWorld(name: string) {
  const world = createWorld({ name });
  const character = createCharacter({
    worldId: world.id, name: `${name} person`, age: 25,
    datingStats: { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 },
  });
  ensureWorldState(world.id);
  applyRelationshipChange(character.id, { affection: 10 }, { source: 'test' }); // relationship
  getOrCreateThread(character.id); // message thread
  performActivity({ activityId: 'work_shift', worldId: world.id, characterId: null }); // per-world money + event
  const item = createShopItem({
    name: `${name} gift`, description: '', price: 10, category: 'gift', rarity: 'common',
    effects: [], infiniteStock: true, stock: 0, assetId: null,
  });
  purchaseItem(item.id, 1, playerIdForWorld(world.id)); // per-world inventory
  minigameResultsRepo.insert(
    MinigameResultSchema.parse({
      id: `mgr_${world.id}`, minigameId: 'timing_meter', characterId: character.id, worldId: world.id,
      score: 80, grade: 'B', reward: { dating: {}, relationship: {}, money: 0 }, createdAt: Date.now(),
    }),
  );
  recordEvent('test_marker', { characterId: character.id }); // world-stamped event
  return { world, character };
}

describe('deleting a world cascades everything it owns (no orphans)', () => {
  it('with deleteCharacters: removes the world and ALL its progress, leaving other worlds intact', () => {
    const doomed = seedFullWorld('Doomed');
    const survivor = seedFullWorld('Survivor');

    deleteWorld(doomed.world.id, true);

    // The world and its character are gone.
    expect(worldsRepo.get(doomed.world.id)).toBeUndefined();
    expect(charactersRepo.get(doomed.character.id)).toBeUndefined();
    expect(worldStatesRepo.get(doomed.world.id)).toBeUndefined();

    // No orphaned per-character progress (these FK-cascade off the character row).
    expect(rows('relationships', 'character_id = ?', doomed.character.id)).toBe(0);
    expect(rows('message_threads', 'character_id = ?', doomed.character.id)).toBe(0);

    // No orphaned no-FK / per-world tails.
    expect(rows('game_events', 'world_id = ?', doomed.world.id)).toBe(0);
    expect(rows('minigame_results', 'world_id = ?', doomed.world.id)).toBe(0);
    expect(playersRepo.get(playerIdForWorld(doomed.world.id))).toBeUndefined();
    expect(rows('inventory_items', 'player_id = ?', playerIdForWorld(doomed.world.id))).toBe(0);

    // The OTHER world is fully intact.
    expect(worldsRepo.get(survivor.world.id)).toBeDefined();
    expect(charactersRepo.get(survivor.character.id)).toBeDefined();
    expect(rows('relationships', 'character_id = ?', survivor.character.id)).toBe(1);
    expect(rows('minigame_results', 'world_id = ?', survivor.world.id)).toBe(1);
    expect(playersRepo.get(playerIdForWorld(survivor.world.id))).toBeDefined();
    expect(rows('inventory_items', 'player_id = ?', playerIdForWorld(survivor.world.id))).toBe(1);
  });

  it('by default: keeps characters (unassigned + pristine), still wipes the world + progress', () => {
    const doomed = seedFullWorld('Doomed');
    const survivor = seedFullWorld('Survivor');

    deleteWorld(doomed.world.id);

    // The world is gone, but the character SURVIVES — detached to unassigned.
    expect(worldsRepo.get(doomed.world.id)).toBeUndefined();
    expect(worldStatesRepo.get(doomed.world.id)).toBeUndefined();
    const kept = charactersRepo.get(doomed.character.id);
    expect(kept).toBeDefined();
    expect(kept?.worldId).toBeNull();

    // The kept character returns pristine — its playthrough progress is wiped.
    expect(rows('relationships', 'character_id = ?', doomed.character.id)).toBe(0);
    expect(rows('message_threads', 'character_id = ?', doomed.character.id)).toBe(0);

    // The no-FK / per-world tails are still cleaned up.
    expect(rows('game_events', 'world_id = ?', doomed.world.id)).toBe(0);
    expect(rows('minigame_results', 'world_id = ?', doomed.world.id)).toBe(0);
    expect(playersRepo.get(playerIdForWorld(doomed.world.id))).toBeUndefined();
    expect(rows('inventory_items', 'player_id = ?', playerIdForWorld(doomed.world.id))).toBe(0);

    // The OTHER world is fully intact.
    expect(worldsRepo.get(survivor.world.id)).toBeDefined();
    expect(charactersRepo.get(survivor.character.id)?.worldId).toBe(survivor.world.id);
    expect(rows('relationships', 'character_id = ?', survivor.character.id)).toBe(1);
  });
});
