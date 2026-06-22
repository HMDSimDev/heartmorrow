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
import { docSchema, WorldScopedQuerySchema } from '../lib/openapi-schema';

export async function shopRoutes(app: FastifyInstance): Promise<void> {
  app.get('/shop/items', { schema: docSchema({ tags: ['shop'], summary: 'List shop items' }) }, async () => listShopItems());

  app.post('/shop/items', { schema: docSchema({ tags: ['shop'], summary: 'Create a shop item', body: ShopItemCreateSchema }) }, async (req, reply) => {
    const input = parseInput(ShopItemCreateSchema, req.body);
    reply.code(201);
    return createShopItem(input);
  });

  // Creator tool: generate a batch of bounded item DRAFTS for review (no mutation).
  app.post('/shop/items/generate', { schema: docSchema({ tags: ['shop'], summary: 'Generate bounded shop item drafts', body: GenerateShopItemsInputSchema }) }, async (req) => {
    const input = parseInput(GenerateShopItemsInputSchema, req.body);
    return generateShopItems(input);
  });

  app.patch('/shop/items/:id', { schema: docSchema({ tags: ['shop'], summary: 'Update a shop item', body: ShopItemUpdateSchema }) }, async (req) => {
    const { id } = req.params as { id: string };
    return updateShopItem(id, parseInput(ShopItemUpdateSchema, req.body));
  });

  app.delete('/shop/items/:id', { schema: docSchema({ tags: ['shop'], summary: 'Delete a shop item' }) }, async (req) => {
    const { id } = req.params as { id: string };
    deleteShopItem(id);
    return { ok: true };
  });

  app.post('/shop/purchase', { schema: docSchema({ tags: ['shop'], summary: 'Purchase a shop item', body: PurchaseSchema }) }, async (req) => {
    const { shopItemId, quantity, worldId } = parseInput(PurchaseSchema, req.body);
    return purchaseItem(shopItemId, quantity, playerIdForWorldOrDefault(worldId));
  });

  // --- inventory (per-world wallet + bag) ---
  app.get('/inventory', { schema: docSchema({ tags: ['shop'], summary: 'Get per-world inventory and wallet', querystring: WorldScopedQuerySchema }) }, async (req) => {
    const { worldId } = req.query as { worldId?: string };
    const playerId = playerIdForWorldOrDefault(worldId);
    return { entries: listInventory(playerId), player: getOrCreatePlayer(playerId) };
  });

  app.post('/inventory/use', { schema: docSchema({ tags: ['shop'], summary: 'Use an inventory item', body: UseItemSchema }) }, async (req) => {
    const { inventoryItemId, characterId, worldId } = parseInput(UseItemSchema, req.body);
    const playerId = playerIdForWorldOrDefault(worldId);
    const result = useItem(inventoryItemId, characterId, playerId);
    return { ...result, player: getOrCreatePlayer(playerId) };
  });
}
