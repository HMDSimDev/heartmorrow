import type { FastifyInstance } from 'fastify';
import { PlayerUpdateSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { getOrCreatePlayer, updatePlayer } from '../services/player-service';
import { playerIdForWorldOrDefault } from '../lib/ids';
import { docSchema, WorldScopedQuerySchema } from '../lib/openapi-schema';

export async function playerRoutes(app: FastifyInstance): Promise<void> {
  // The player profile (money + persona) is per-world. The client passes the
  // active world; a world-less call falls back to the legacy id.
  app.get('/player', {
    schema: docSchema({
      tags: ['player'],
      summary: 'Get the per-world player profile',
      querystring: WorldScopedQuerySchema,
    }),
  }, async (req) => {
    const { worldId } = req.query as { worldId?: string };
    return getOrCreatePlayer(playerIdForWorldOrDefault(worldId));
  });

  app.patch('/player', {
    schema: docSchema({
      tags: ['player'],
      summary: 'Update the per-world player profile',
      body: PlayerUpdateSchema,
      querystring: WorldScopedQuerySchema,
    }),
  }, async (req) => {
    const { worldId } = req.query as { worldId?: string };
    const update = parseInput(PlayerUpdateSchema, req.body);
    return updatePlayer(update, playerIdForWorldOrDefault(worldId));
  });
}
