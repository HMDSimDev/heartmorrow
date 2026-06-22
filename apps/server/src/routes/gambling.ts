import type { FastifyInstance } from 'fastify';
import {
  SlotsBetSchema,
  RouletteSpinSchema,
  BlackjackStartSchema,
  BlackjackActionSchema,
  VideoPokerStartSchema,
  VideoPokerDrawSchema,
} from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { docSchema, WorldScopedQuerySchema } from '../lib/openapi-schema';
import { badRequest } from '../lib/errors';
import { requireFeature } from '../services/world-feature-service';
import {
  getGamblingState,
  playSlots,
  playRoulette,
  startBlackjack,
  blackjackAction,
  startVideoPoker,
  videoPokerDraw,
} from '../services/gambling-service';

/**
 * Casino routes. Every handler calls `requireFeature(worldId, 'gambling')` first —
 * the client hiding the tile is cosmetic; THIS is the real gate. The service is
 * the money + RNG authority; the client never reports an outcome or payout.
 */
export async function gamblingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/gambling', { schema: docSchema({ tags: ['gambling'], summary: 'Get casino state for a world', querystring: WorldScopedQuerySchema }) }, async (req) => {
    const { worldId } = req.query as { worldId?: string };
    if (!worldId) throw badRequest('worldId is required.');
    requireFeature(worldId, 'gambling');
    return getGamblingState(worldId);
  });

  app.post('/gambling/slots', { schema: docSchema({ tags: ['gambling'], summary: 'Play a slots spin', body: SlotsBetSchema }) }, async (req) => {
    const { worldId, bet } = parseInput(SlotsBetSchema, req.body);
    requireFeature(worldId, 'gambling');
    return playSlots(worldId, bet);
  });

  app.post('/gambling/roulette', { schema: docSchema({ tags: ['gambling'], summary: 'Spin roulette with bets', body: RouletteSpinSchema }) }, async (req) => {
    const { worldId, bets } = parseInput(RouletteSpinSchema, req.body);
    requireFeature(worldId, 'gambling');
    return playRoulette(worldId, bets);
  });

  app.post('/gambling/blackjack/start', { schema: docSchema({ tags: ['gambling'], summary: 'Start a blackjack round', body: BlackjackStartSchema }) }, async (req) => {
    const { worldId, bet } = parseInput(BlackjackStartSchema, req.body);
    requireFeature(worldId, 'gambling');
    return startBlackjack(worldId, bet);
  });

  app.post('/gambling/blackjack/action', { schema: docSchema({ tags: ['gambling'], summary: 'Take a blackjack action', body: BlackjackActionSchema }) }, async (req) => {
    const { worldId, roundId, action } = parseInput(BlackjackActionSchema, req.body);
    requireFeature(worldId, 'gambling');
    return blackjackAction(worldId, roundId, action);
  });

  app.post('/gambling/videopoker/start', { schema: docSchema({ tags: ['gambling'], summary: 'Start a video poker round', body: VideoPokerStartSchema }) }, async (req) => {
    const { worldId, bet } = parseInput(VideoPokerStartSchema, req.body);
    requireFeature(worldId, 'gambling');
    return startVideoPoker(worldId, bet);
  });

  app.post('/gambling/videopoker/draw', { schema: docSchema({ tags: ['gambling'], summary: 'Draw/hold in video poker', body: VideoPokerDrawSchema }) }, async (req) => {
    const { worldId, roundId, holds } = parseInput(VideoPokerDrawSchema, req.body);
    requireFeature(worldId, 'gambling');
    return videoPokerDraw(worldId, roundId, holds);
  });
}
