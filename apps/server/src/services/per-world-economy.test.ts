import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_PLAYER_ID,
  DEFAULT_STARTING_MONEY,
  InventoryItemSchema,
  MinigameResultSchema,
  PlayerProfileSchema,
} from '@dsim/shared';
import { resetDb } from '../test/helpers';
import { getDb } from '../db/index';
import { createWorld } from './world-service';
import { performActivity } from './activity-service';
import { createShopItem, purchaseItem, listInventory } from './shop-service';
import { getOrCreatePlayer, updatePlayer } from './player-service';
import { minigameResultsRepo, playersRepo, inventoryRepo } from '../db/repositories';
import { migratePlayerIdentity } from '../db/migrate-player-identity';
import { playerIdForWorld } from '../lib/ids';

beforeEach(() => resetDb());

describe('per-world economy', () => {
  it('keeps money in the world it was earned in', () => {
    const a = createWorld({ name: 'Alpha' });
    const b = createWorld({ name: 'Beta' });
    const aWallet = playerIdForWorld(a.id);
    const bWallet = playerIdForWorld(b.id);
    const beforeB = getOrCreatePlayer(bWallet).money;

    performActivity({ activityId: 'work_shift', worldId: a.id, characterId: null });

    expect(getOrCreatePlayer(aWallet).money).toBeGreaterThan(DEFAULT_STARTING_MONEY);
    expect(getOrCreatePlayer(bWallet).money).toBe(beforeB); // world B's wallet untouched
  });

  it('keeps inventory in the world it was bought in', () => {
    const a = createWorld({ name: 'Alpha' });
    const b = createWorld({ name: 'Beta' });
    const item = createShopItem({
      name: 'Bouquet', description: '', price: 20, category: 'gift', rarity: 'common',
      effects: [], infiniteStock: true, stock: 0, assetId: null,
    });

    purchaseItem(item.id, 1, playerIdForWorld(a.id));

    expect(listInventory(playerIdForWorld(a.id)).some((e) => e.inventoryItem.shopItemId === item.id)).toBe(true);
    expect(listInventory(playerIdForWorld(b.id))).toHaveLength(0); // not usable in world B
  });

  it('keeps persona separate per world', () => {
    const a = createWorld({ name: 'Alpha' });
    const b = createWorld({ name: 'Beta' });
    updatePlayer({ name: 'Robin' }, playerIdForWorld(a.id));
    expect(getOrCreatePlayer(playerIdForWorld(a.id)).name).toBe('Robin');
    expect(getOrCreatePlayer(playerIdForWorld(b.id)).name).toBe('Player'); // fresh per world
  });

  it('scopes minigame highscores per world', () => {
    const a = createWorld({ name: 'Alpha' });
    const b = createWorld({ name: 'Beta' });
    const mk = (worldId: string, score: number) =>
      minigameResultsRepo.insert(
        MinigameResultSchema.parse({
          id: `mgr_${worldId}_${score}`, minigameId: 'timing_meter', characterId: null,
          worldId, score, grade: 'A', reward: { dating: {}, relationship: {}, money: 0 }, createdAt: Date.now(),
        }),
      );
    mk(a.id, 90);
    mk(b.id, 40);

    expect(minigameResultsRepo.listByWorld(a.id).map((r) => r.score)).toEqual([90]);
    expect(minigameResultsRepo.bestScore('timing_meter', null, a.id)).toBe(90);
    expect(minigameResultsRepo.bestScore('timing_meter', null, b.id)).toBe(40); // not polluted by A's 90
  });
});

describe('legacy player migration', () => {
  it('moves the global player’s money + inventory onto the oldest world', () => {
    // A pre-migration save: one global player with money + a bag.
    const now = Date.now();
    playersRepo.insert(
      PlayerProfileSchema.parse({
        id: DEFAULT_PLAYER_ID, name: 'Rowan', pronouns: 'they/them', personaNotes: 'legacy',
        money: 999, createdAt: now, updatedAt: now,
      }),
    );
    const item = createShopItem({
      name: 'Heirloom', description: '', price: 0, category: 'gift', rarity: 'common',
      effects: [], infiniteStock: true, stock: 0, assetId: null,
    });
    inventoryRepo.insert(
      InventoryItemSchema.parse({ id: 'inv_legacy', playerId: DEFAULT_PLAYER_ID, shopItemId: item.id, quantity: 2, acquiredAt: now }),
    );

    const oldest = createWorld({ name: 'Original' });
    const newer = createWorld({ name: 'Second' });
    // Force a deterministic age ordering (createWorld stamps Date.now()).
    getDb().run('UPDATE worlds SET created_at = ? WHERE id = ?', 1000, oldest.id);
    getDb().run('UPDATE worlds SET created_at = ? WHERE id = ?', 2000, newer.id);

    migratePlayerIdentity();

    // The legacy row is gone; the oldest world inherited the money, persona, and bag.
    expect(playersRepo.get(DEFAULT_PLAYER_ID)).toBeUndefined();
    const primary = getOrCreatePlayer(playerIdForWorld(oldest.id));
    expect(primary.money).toBe(999);
    expect(primary.name).toBe('Rowan');
    expect(listInventory(playerIdForWorld(oldest.id)).find((e) => e.inventoryItem.shopItemId === item.id)?.inventoryItem.quantity).toBe(2);
    // The newer world starts empty.
    expect(getOrCreatePlayer(playerIdForWorld(newer.id)).money).toBe(DEFAULT_STARTING_MONEY);
    expect(listInventory(playerIdForWorld(newer.id))).toHaveLength(0);

    // Idempotent: a second run is a no-op (no legacy row left to move).
    expect(() => migratePlayerIdentity()).not.toThrow();
    expect(getOrCreatePlayer(playerIdForWorld(oldest.id)).money).toBe(999);
  });
});
