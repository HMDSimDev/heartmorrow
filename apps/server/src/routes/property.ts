import type { FastifyInstance } from 'fastify';
import {
  PropertyCreateSchema,
  PropertyUpdateSchema,
  GeneratePropertiesInputSchema,
  PropertyActionSchema,
} from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { badRequest } from '../lib/errors';
import {
  listPropertyViews,
  getProperty,
  createProperty,
  updateProperty,
  deleteProperty,
  generateProperties,
  buyProperty,
  sellProperty,
  leaseProperty,
  payRent,
  endLease,
} from '../services/property-service';
import { getLandlordInbox, markLandlordNoticesRead } from '../services/landlord-notice-service';
import { getWorld } from '../services/world-service';
import { requireFeature } from '../services/world-feature-service';
import { playerIdForWorld } from '../lib/ids';

export async function propertyRoutes(app: FastifyInstance): Promise<void> {
  // Player + creator view of a world's properties (ownership, active lease, affordability).
  app.get('/properties', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    if (!worldId) throw badRequest('worldId is required.');
    requireFeature(worldId, 'property');
    return { properties: listPropertyViews(worldId) };
  });

  // --- authoring (creator) ---
  app.post('/properties', async (req, reply) => {
    const input = parseInput(PropertyCreateSchema, req.body);
    requireFeature(input.worldId, 'property');
    reply.code(201);
    return createProperty(input);
  });

  app.post('/properties/generate', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    if (!worldId) throw badRequest('worldId is required.');
    requireFeature(worldId, 'property');
    const world = getWorld(worldId);
    const input = parseInput(GeneratePropertiesInputSchema, {
      ...(req.body as Record<string, unknown>),
      world: { name: world.name, summary: world.summary, tone: world.tone, lore: world.lore, rules: world.rules },
    });
    return generateProperties(input, worldId);
  });

  app.patch('/properties/:id', async (req) => {
    const { id } = req.params as { id: string };
    requireFeature(getProperty(id).worldId, 'property');
    return updateProperty(id, parseInput(PropertyUpdateSchema, req.body));
  });

  app.delete('/properties/:id', async (req) => {
    const { id } = req.params as { id: string };
    requireFeature(getProperty(id).worldId, 'property');
    deleteProperty(id);
    return { ok: true };
  });

  // --- player actions ---
  app.post('/properties/buy', async (req) => {
    const { worldId, propertyId } = parseInput(PropertyActionSchema, req.body);
    requireFeature(worldId, 'property');
    return buyProperty(worldId, propertyId);
  });

  app.post('/properties/sell', async (req) => {
    const { worldId, propertyId } = parseInput(PropertyActionSchema, req.body);
    requireFeature(worldId, 'property');
    return sellProperty(worldId, propertyId);
  });

  app.post('/properties/lease', async (req) => {
    const { worldId, propertyId } = parseInput(PropertyActionSchema, req.body);
    requireFeature(worldId, 'property');
    return leaseProperty(worldId, propertyId);
  });

  app.post('/properties/pay-rent', async (req) => {
    const { worldId, propertyId } = parseInput(PropertyActionSchema, req.body);
    requireFeature(worldId, 'property');
    return payRent(worldId, propertyId);
  });

  app.post('/properties/end-lease', async (req) => {
    const { worldId, propertyId } = parseInput(PropertyActionSchema, req.body);
    requireFeature(worldId, 'property');
    return endLease(worldId, propertyId);
  });

  // --- landlord notices (the urgent "Property Management" text channel) ---
  app.get('/properties/notices', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    if (!worldId) throw badRequest('worldId is required.');
    requireFeature(worldId, 'property');
    return getLandlordInbox(worldId, playerIdForWorld(worldId));
  });

  app.post('/properties/notices/read', async (req) => {
    const { worldId } = (req.body ?? {}) as { worldId?: string };
    if (!worldId) throw badRequest('worldId is required.');
    requireFeature(worldId, 'property');
    markLandlordNoticesRead(worldId, playerIdForWorld(worldId));
    return { ok: true };
  });
}
