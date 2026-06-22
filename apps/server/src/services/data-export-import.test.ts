import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_STARTING_MONEY, type ShopItemCreate } from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { createWorld } from './world-service';
import { exportAll, importAll } from './data-service';
import { addMoney, getOrCreatePlayer } from './player-service';
import { createShopItem, grantItem, listInventory } from './shop-service';
import { playerIdForWorld } from '../lib/ids';

function item(name: string): ShopItemCreate {
  return {
    name,
    description: '',
    price: 0,
    category: 'gift',
    rarity: 'common',
    effects: [],
    infiniteStock: true,
    stock: 0,
    assetId: null,
  };
}

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('savegame export/import: per-world wallets + inventory', () => {
  // Regression for the critical data-loss bug: wallets/inventory live under PER-WORLD
  // player ids (player:<worldId>), but the export used to read only the legacy
  // DEFAULT_PLAYER_ID — so a round-trip captured an empty default and importAll wiped
  // every world's money and items.
  it('a round-trip preserves EVERY world\'s money and inventory, not just the default player', () => {
    const a = createWorld({ name: 'Alpha' });
    const b = createWorld({ name: 'Beta' });
    const walletA = playerIdForWorld(a.id);
    const walletB = playerIdForWorld(b.id);

    // Distinct per-world balances (base + delta) so a default-collapse or cross-world
    // overwrite would be caught by the exact-value assertions below.
    addMoney(13_337, walletA);
    addMoney(4_242, walletB);

    const mixtape = createShopItem(item('Mixtape'));
    const bouquet = createShopItem(item('Bouquet'));
    grantItem(mixtape.id, 3, walletA);
    grantItem(bouquet.id, 1, walletB);

    const bundle = exportAll({ kind: 'savegame' });

    // The bundle must carry BOTH per-world wallets and BOTH inventory rows.
    expect(bundle.players.some((p) => p.id === walletA && p.money === DEFAULT_STARTING_MONEY + 13_337)).toBe(true);
    expect(bundle.players.some((p) => p.id === walletB && p.money === DEFAULT_STARTING_MONEY + 4_242)).toBe(true);
    expect(bundle.inventory.length).toBeGreaterThanOrEqual(2);

    // importAll is destructive: it clears the players/inventory tables, then restores
    // from the bundle. With the bug this wiped both worlds' money + items.
    importAll(bundle);

    expect(getOrCreatePlayer(walletA).money).toBe(DEFAULT_STARTING_MONEY + 13_337);
    expect(getOrCreatePlayer(walletB).money).toBe(DEFAULT_STARTING_MONEY + 4_242);
    expect(listInventory(walletA).find((e) => e.item?.name === 'Mixtape')?.inventoryItem.quantity).toBe(3);
    expect(listInventory(walletB).find((e) => e.item?.name === 'Bouquet')?.inventoryItem.quantity).toBe(1);
  });
});
