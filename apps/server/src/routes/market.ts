import type { FastifyInstance } from 'fastify';
import {
  CompanyCreateSchema,
  CompanyUpdateSchema,
  GenerateCompaniesInputSchema,
  TradeStockSchema,
} from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { badRequest } from '../lib/errors';
import {
  listCompanies,
  getCompany,
  createCompany,
  updateCompany,
  deleteCompany,
  generateCompanies,
  marketView,
  portfolioView,
  buyStock,
  sellStock,
} from '../services/market-service';
import { netWorth } from '../services/wealth-service';
import { getWorld } from '../services/world-service';
import { requireFeature, featureEnabled } from '../services/world-feature-service';

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  // Player market board: companies + current/prior prices + holdings + recent news.
  app.get('/market', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    if (!worldId) throw badRequest('worldId is required.');
    requireFeature(worldId, 'stockMarket');
    return marketView(worldId);
  });

  app.get('/portfolio', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    if (!worldId) throw badRequest('worldId is required.');
    requireFeature(worldId, 'stockMarket');
    return portfolioView(worldId);
  });

  // --- authoring (creator) ---
  app.get('/market/companies', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    if (!worldId) throw badRequest('worldId is required.');
    requireFeature(worldId, 'stockMarket');
    return { companies: listCompanies(worldId) };
  });

  app.post('/market/companies', async (req, reply) => {
    const input = parseInput(CompanyCreateSchema, req.body);
    requireFeature(input.worldId, 'stockMarket');
    reply.code(201);
    return createCompany(input);
  });

  app.post('/market/companies/generate', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    if (!worldId) throw badRequest('worldId is required.');
    requireFeature(worldId, 'stockMarket');
    const world = getWorld(worldId);
    const input = parseInput(GenerateCompaniesInputSchema, {
      ...(req.body as Record<string, unknown>),
      world: { name: world.name, summary: world.summary, tone: world.tone, lore: world.lore, rules: world.rules },
    });
    return generateCompanies(input, worldId);
  });

  app.patch('/market/companies/:id', async (req) => {
    const { id } = req.params as { id: string };
    requireFeature(getCompany(id).worldId, 'stockMarket');
    return updateCompany(id, parseInput(CompanyUpdateSchema, req.body));
  });

  app.delete('/market/companies/:id', async (req) => {
    const { id } = req.params as { id: string };
    requireFeature(getCompany(id).worldId, 'stockMarket');
    deleteCompany(id);
    return { ok: true };
  });

  // --- player actions ---
  app.post('/market/buy', async (req) => {
    const { worldId, companyId, shares } = parseInput(TradeStockSchema, req.body);
    requireFeature(worldId, 'stockMarket');
    return buyStock(worldId, companyId, shares);
  });

  app.post('/market/sell', async (req) => {
    const { worldId, companyId, shares } = parseInput(TradeStockSchema, req.body);
    requireFeature(worldId, 'stockMarket');
    return sellStock(worldId, companyId, shares);
  });

  // Net-worth readout (cash + property equity + stock value) for the HUD. Available
  // whenever EITHER wealth feature is on; 404-free no-op shape otherwise.
  app.get('/wealth', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    if (!worldId) throw badRequest('worldId is required.');
    if (!featureEnabled(worldId, 'property') && !featureEnabled(worldId, 'stockMarket')) {
      return { cash: 0, property: 0, stocks: 0, total: 0 };
    }
    return netWorth(worldId);
  });
}
