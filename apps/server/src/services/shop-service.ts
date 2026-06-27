import {
  DEFAULT_PLAYER_ID,
  InventoryItemSchema,
  ItemCategorySchema,
  ItemRaritySchema,
  ITEM_GEN,
  ShopItemSchema,
  ShopItemGenerationSchema,
  GenerateShopItemsInputSchema,
  isStoryFlag,
  type Character,
  type GeneratedItemEffect,
  type GeneratedShopItem,
  type GenerateShopItemsInput,
  type GenerateShopItemsParsed,
  type InventoryItem,
  type ItemEffect,
  type PlayerProfile,
  type Relationship,
  type ShopItem,
  type ShopItemCreate,
  type ShopItemUpdate,
  type StructuredResult,
} from '@dsim/shared';
import { getDb } from '../db/index';
import { inventoryRepo, shopItemsRepo } from '../db/repositories';
import { newId } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';
import { addMoney, getOrCreatePlayer, spendMoney } from './player-service';
import {
  applyCharacterDatingChange,
  applyRelationshipChange,
  applyTempBuff,
  setRelationshipFlag,
} from './stat-service';
import { getCharacter } from './character-service';
import { getRelationship } from './relationship-service';
import { recordEvent } from './event-service';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import { buildShopItemGenMessages } from '../prompt/prompt-builder';

// --- shop CRUD --------------------------------------------------------------

export function listShopItems(): ShopItem[] {
  return shopItemsRepo.list();
}

export function getShopItem(id: string): ShopItem {
  const item = shopItemsRepo.get(id);
  if (!item) throw notFound(`Shop item ${id} not found.`);
  return item;
}

export function createShopItem(input: ShopItemCreate): ShopItem {
  const now = Date.now();
  const item = ShopItemSchema.parse({ ...input, id: newId('item'), createdAt: now, updatedAt: now });
  return shopItemsRepo.insert(item);
}

export function updateShopItem(id: string, patch: ShopItemUpdate): ShopItem {
  const current = getShopItem(id);
  const next = ShopItemSchema.parse({ ...current, ...patch, id: current.id, updatedAt: Date.now() });
  return shopItemsRepo.update(next);
}

export function deleteShopItem(id: string): void {
  getShopItem(id);
  shopItemsRepo.delete(id);
}

// --- purchase ---------------------------------------------------------------

export interface PurchaseResult {
  player: PlayerProfile;
  item: ShopItem;
  inventoryItem: InventoryItem;
}

/**
 * Buy `quantity` of an item. The TOTAL COST and stock are computed and checked
 * server-side; the client never supplies a price or money amount.
 */
export function purchaseItem(
  shopItemId: string,
  quantity: number,
  playerId: string = DEFAULT_PLAYER_ID,
): PurchaseResult {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw badRequest('Quantity must be a positive integer.');
  }
  const item = getShopItem(shopItemId);
  if (!item.infiniteStock && item.stock < quantity) {
    throw badRequest(`Not enough stock: ${item.stock} left.`);
  }
  const totalCost = item.price * quantity;

  return getDb().transaction<PurchaseResult>(() => {
    const player = spendMoney(totalCost, playerId); // throws on insufficient funds
    const { item: updatedItem, inventoryItem } = grantItem(shopItemId, quantity, playerId);
    recordEvent('purchase', { playerId, shopItemId, quantity, totalCost });
    return { player, item: updatedItem, inventoryItem };
  });
}

/**
 * Add an item to the player's inventory WITHOUT charging money (decrementing
 * stock if finite). Used by purchases and by claiming gifts attached to texts.
 * The caller records the appropriate event.
 */
export function grantItem(
  shopItemId: string,
  quantity = 1,
  playerId: string = DEFAULT_PLAYER_ID,
): { item: ShopItem; inventoryItem: InventoryItem } {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw badRequest('Quantity must be a positive integer.');
  }
  const item = getShopItem(shopItemId);
  if (!item.infiniteStock && item.stock < quantity) {
    throw badRequest(`Not enough stock: ${item.stock} left.`);
  }
  return getDb().transaction(() => {
    let updatedItem = item;
    if (!item.infiniteStock) {
      updatedItem = shopItemsRepo.update(
        ShopItemSchema.parse({ ...item, stock: item.stock - quantity, updatedAt: Date.now() }),
      );
    }
    const existing = inventoryRepo.getByPlayerAndItem(playerId, shopItemId);
    const inventoryItem = existing
      ? inventoryRepo.update(
          InventoryItemSchema.parse({ ...existing, quantity: existing.quantity + quantity, acquiredAt: Date.now() }),
        )
      : inventoryRepo.insert(
          InventoryItemSchema.parse({ id: newId('inv'), playerId, shopItemId, quantity, acquiredAt: Date.now() }),
        );
    return { item: updatedItem, inventoryItem };
  });
}

// --- inventory + use --------------------------------------------------------

export interface InventoryEntry {
  inventoryItem: InventoryItem;
  item: ShopItem | null;
}

export function listInventory(playerId: string = DEFAULT_PLAYER_ID): InventoryEntry[] {
  return inventoryRepo.listByPlayer(playerId).map((inv) => ({
    inventoryItem: inv,
    item: shopItemsRepo.get(inv.shopItemId) ?? null,
  }));
}

function effectNeedsCharacter(effect: ItemEffect): boolean {
  return effect.kind !== 'money';
}

export interface UseItemResult {
  inventoryItem: InventoryItem;
  item: ShopItem;
  relationship: Relationship | null;
  character: Character | null;
  appliedEffects: ItemEffect[];
}

/**
 * Use/gift an inventory item. Effects are applied through the stat service
 * (which clamps and records events). The client never supplies deltas.
 */
export function useItem(
  inventoryItemId: string,
  characterId: string | null,
  playerId: string = DEFAULT_PLAYER_ID,
): UseItemResult {
  const inv = inventoryRepo.get(inventoryItemId);
  if (!inv || inv.playerId !== playerId) throw notFound('Inventory item not found.');
  if (inv.quantity <= 0) throw badRequest('You have none of this item left.');

  const item = getShopItem(inv.shopItemId);
  const needsCharacter = item.effects.some(effectNeedsCharacter);
  if (needsCharacter && !characterId) {
    throw badRequest('This item must be used on a character.');
  }
  if (characterId) getCharacter(characterId); // validates existence

  return getDb().transaction<UseItemResult>(() => {
    let relationship: Relationship | null = characterId ? getRelationship(characterId) : null;
    let character: Character | null = null;

    for (const effect of item.effects) {
      switch (effect.kind) {
        case 'relationship':
          relationship = applyRelationshipChange(characterId!, { [effect.stat]: effect.delta }, {
            source: 'item_use',
            detail: { itemId: item.id },
          });
          break;
        case 'dating':
          character = applyCharacterDatingChange(characterId!, { [effect.stat]: effect.delta }, {
            source: 'item_use',
            detail: { itemId: item.id },
          });
          break;
        case 'temp_buff':
          relationship = applyTempBuff(characterId!, effect.stat, effect.delta, effect.durationSessions, {
            source: 'item_use',
            detail: { itemId: item.id },
          });
          break;
        case 'flag':
          relationship = setRelationshipFlag(characterId!, effect.flag, effect.value, {
            source: 'item_use',
            detail: { itemId: item.id },
          });
          break;
        case 'money':
          // A negative-money (cost) item must SPEND — so it's gated on funds and
          // records a true delta — rather than being silently floored by addMoney.
          if (effect.delta < 0) spendMoney(-effect.delta, playerId);
          else if (effect.delta > 0) addMoney(effect.delta, playerId);
          break;
        default: {
          const _exhaustive: never = effect;
          throw badRequest(`Unknown effect: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }

    const inventoryItem = inventoryRepo.update(
      InventoryItemSchema.parse({ ...inv, quantity: inv.quantity - 1 }),
    );

    // Refresh character if a dating effect didn't already
    if (characterId && !character) character = getCharacter(characterId);

    recordEvent('item_use', { playerId, itemId: item.id, characterId, effects: item.effects.length });
    return { inventoryItem, item, relationship, character, appliedEffects: item.effects };
  });
}

/**
 * Decrement one unit of an inventory item. Used when a gift is GIVEN away: the
 * gift reaction (LLM-judged) owns the relationship outcome, so we consume the
 * item directly instead of running its static `useItem` effects. Validates
 * ownership + stock; throws if the player doesn't have it.
 */
export function consumeInventoryItem(
  inventoryItemId: string,
  playerId: string = DEFAULT_PLAYER_ID,
): InventoryItem {
  const inv = inventoryRepo.get(inventoryItemId);
  if (!inv || inv.playerId !== playerId) throw notFound('Inventory item not found.');
  if (inv.quantity <= 0) throw badRequest('You have none of this item left.');
  return inventoryRepo.update(InventoryItemSchema.parse({ ...inv, quantity: inv.quantity - 1 }));
}

/** Force-refresh the player profile (used by routes after money changes). */
export function currentPlayer(playerId: string = DEFAULT_PLAYER_ID): PlayerProfile {
  return getOrCreatePlayer(playerId);
}

// --- LLM item generation (creator tool) -------------------------------------

const clampInt = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : lo)));

const clampMagnitude = (n: number): number =>
  clampInt(n, -ITEM_GEN.MAX_EFFECT_MAGNITUDE, ITEM_GEN.MAX_EFFECT_MAGNITUDE);

/** Bound a single generated effect into a safe ItemEffect, or drop it (null). */
function boundEffect(e: GeneratedItemEffect): ItemEffect | null {
  switch (e.kind) {
    case 'relationship':
      return { kind: 'relationship', stat: e.stat, delta: clampMagnitude(e.delta) };
    case 'temp_buff':
      return {
        kind: 'temp_buff',
        stat: e.stat,
        delta: clampMagnitude(e.delta),
        durationSessions: clampInt(e.durationSessions, 1, ITEM_GEN.MAX_BUFF_DURATION),
      };
    case 'flag':
      // Only canonical STORY flags — a free-form flag is non-deterministic and can't be
      // mapped/displayed, and isStoryFlag also excludes the engine's internal keys.
      if (!isStoryFlag(e.flag)) return null;
      return { kind: 'flag', flag: e.flag, value: e.value };
    case 'money':
      return { kind: 'money', delta: clampInt(e.delta, -ITEM_GEN.MAX_MONEY_EFFECT, ITEM_GEN.MAX_MONEY_EFFECT) };
    default: {
      const _exhaustive: never = e;
      return _exhaustive;
    }
  }
}

/**
 * SERVER-OWNS-RULES layer: turn an LLM-proposed item into a safe ShopItemCreate.
 * Clamps price + effect magnitudes, coerces enums, drops reserved-flag collisions,
 * forces server-owned fields, and guarantees buying an item can never net money.
 */
export function boundGeneratedItem(g: GeneratedShopItem, input: GenerateShopItemsParsed): ShopItemCreate {
  const rarity = ItemRaritySchema.catch('common').parse(g.rarity);
  const category = ItemCategorySchema.catch('gift').parse(g.category);

  const lo = Math.max(ITEM_GEN.MIN_PRICE, input.minPrice ?? ITEM_GEN.MIN_PRICE);
  const hi = Math.min(ITEM_GEN.MAX_PRICE, input.maxPrice ?? ITEM_GEN.MAX_PRICE);
  let price = clampInt(g.price, lo, Math.max(lo, hi));

  const effects = g.effects
    .map(boundEffect)
    .filter((e): e is ItemEffect => e !== null)
    .slice(0, ITEM_GEN.MAX_EFFECTS_PER_ITEM);

  // Money-printer guard: a buyable item must never net the player money.
  const netMoney = effects.reduce((sum, e) => sum + (e.kind === 'money' ? e.delta : 0), 0);
  if (netMoney > 0) price = Math.max(price, netMoney + 1);

  return {
    name: g.name.slice(0, ITEM_GEN.MAX_NAME),
    description: g.description.slice(0, ITEM_GEN.MAX_DESCRIPTION),
    category,
    rarity,
    price,
    effects,
    infiniteStock: true,
    stock: 0,
    assetId: null,
  };
}

/**
 * Generate a batch of in-world shop items via the LLM. Read-only: returns
 * server-bounded DRAFTS for the creator to review/edit before saving — it does
 * NOT persist anything. Fails safe (typed StructuredResult) if the model can't
 * comply. The drafts are still re-validated by `createShopItem` at save time.
 */
export async function generateShopItems(
  input: GenerateShopItemsInput,
): Promise<StructuredResult<ShopItemCreate[]>> {
  const data = GenerateShopItemsInputSchema.parse(input);
  const settings = getLlmSettings();
  const result = await callStructuredLlm(ShopItemGenerationSchema, buildShopItemGenMessages(data), {
    settings,
    task: 'Generate a batch of in-world shop items (name, description, category, rarity, price, effects).',
    schemaName: 'ShopItemGeneration',
  });
  if (!result.ok) {
    return { ok: false, error: result.error, attempts: result.attempts, lastRaw: result.lastRaw };
  }
  const drafts = result.data.items.map((g) => boundGeneratedItem(g, data));
  return { ok: true, data: drafts, attempts: result.attempts };
}
