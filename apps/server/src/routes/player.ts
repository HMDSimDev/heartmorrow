import type { FastifyInstance } from 'fastify';
import { PlayerUpdateSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { getOrCreatePlayer, updatePlayer } from '../services/player-service';
import { playerIdForWorldOrDefault } from '../lib/ids';

export async function playerRoutes(app: FastifyInstance): Promise<void> {
  // The player profile (money + persona) is per-world. The client passes the
  // active world; a world-less call falls back to the legacy id.
  app.get('/player', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    return getOrCreatePlayer(playerIdForWorldOrDefault(worldId));
  });

  app.patch('/player', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    const update = parseInput(PlayerUpdateSchema, req.body);
    return updatePlayer(update, playerIdForWorldOrDefault(worldId));
  });
}
