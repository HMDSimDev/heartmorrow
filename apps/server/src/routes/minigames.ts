import type { FastifyInstance } from 'fastify';
import { MinigameStartSchema, MinigameFinishSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import {
  finishMinigame,
  listMinigames,
  recentResults,
  startMinigame,
} from '../services/minigame-service';

export async function minigameRoutes(app: FastifyInstance): Promise<void> {
  app.get('/minigames', async () => listMinigames());

  app.post('/minigames/start', async (req) => {
    const input = parseInput(MinigameStartSchema, req.body);
    return startMinigame(input);
  });

  app.post('/minigames/finish', async (req) => {
    const input = parseInput(MinigameFinishSchema, req.body);
    return finishMinigame(input);
  });

  app.get('/minigames/results', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    return recentResults(worldId);
  });
}
