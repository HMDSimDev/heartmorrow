import type { FastifyInstance } from 'fastify';
import { MinigameStartSchema, MinigameFinishSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { docSchema, WorldScopedQuerySchema } from '../lib/openapi-schema';
import {
  finishMinigame,
  listMinigames,
  recentResults,
  startMinigame,
} from '../services/minigame-service';

export async function minigameRoutes(app: FastifyInstance): Promise<void> {
  app.get('/minigames', { schema: docSchema({ tags: ['minigames'], summary: 'List available minigames' }) }, async () => listMinigames());

  app.post('/minigames/start', { schema: docSchema({ tags: ['minigames'], summary: 'Start a minigame session', body: MinigameStartSchema }) }, async (req) => {
    const input = parseInput(MinigameStartSchema, req.body);
    return startMinigame(input);
  });

  app.post('/minigames/finish', { schema: docSchema({ tags: ['minigames'], summary: 'Finish a minigame and record result', body: MinigameFinishSchema }) }, async (req) => {
    const input = parseInput(MinigameFinishSchema, req.body);
    return finishMinigame(input);
  });

  app.get('/minigames/results', { schema: docSchema({ tags: ['minigames'], summary: 'List recent minigame results', querystring: WorldScopedQuerySchema }) }, async (req) => {
    const { worldId } = req.query as { worldId?: string };
    return recentResults(worldId);
  });
}
