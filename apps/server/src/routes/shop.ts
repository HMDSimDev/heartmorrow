import type { FastifyInstance } from 'fastify';
import {
  GenerateShopItemsInputSchema,
  PurchaseSchema,
  ShopItemCreateSchema,
  ShopItemUpdateSchema,
  UseItemSchema,
} from '@dsim/shared';
import { parseInput } from '../lib/validate';
import {
  createShopItem,
  deleteShopItem,
  generateShopItems,
  listShopItems,
  listInventory,
  purchaseItem,
  updateShopItem,
  useItem,
} from '../services/shop-service';
import { getOrCreatePlayer } from '../services/player-service';
import { playerIdForWorldOrDefault } from '../lib/ids';

export async function shopRoutes(app: FastifyInstance): Promise<void> {
  app.get('/shop/items', async () => listShopItems());

  app.post('/shop/items', async (req, reply) => {
    const input = parseInput(ShopItemCreateSchema, req.body);
    reply.code(201);
    return createShopItem(input);
  });

  // Creator tool: generate a batch of bounded item DRAFTS for review (no mutation).
  app.post('/shop/items/generate', async (req) => {
    const input = parseInput(GenerateShopItemsInputSchema, req.body);
    return generateShopItems(input);
  });

  app.patch('/shop/items/:id', async (req) => {
    const { id } = req.params as { id: string };
    return updateShopItem(id, parseInput(ShopItemUpdateSchema, req.body));
  });

  app.delete('/shop/items/:id', async (req) => {
    const { id } = req.params as { id: string };
    deleteShopItem(id);
    return { ok: true };
  });

  app.post('/shop/purchase', async (req) => {
    const { shopItemId, quantity, worldId } = parseInput(PurchaseSchema, req.body);
    return purchaseItem(shopItemId, quantity, playerIdForWorldOrDefault(worldId));
  });

  // --- inventory (per-world wallet + bag) ---
  app.get('/inventory', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    const playerId = playerIdForWorldOrDefault(worldId);
    return { entries: listInventory(playerId), player: getOrCreatePlayer(playerId) };
  });

  app.post('/inventory/use', async (req) => {
    const { inventoryItemId, characterId, worldId } = parseInput(UseItemSchema, req.body);
    const playerId = playerIdForWorldOrDefault(worldId);
    const result = useItem(inventoryItemId, characterId, playerId);
    return { ...result, player: getOrCreatePlayer(playerId) };
  });
}
