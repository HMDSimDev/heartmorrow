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
  app.get('/gambling', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    if (!worldId) throw badRequest('worldId is required.');
    requireFeature(worldId, 'gambling');
    return getGamblingState(worldId);
  });

  app.post('/gambling/slots', async (req) => {
    const { worldId, bet } = parseInput(SlotsBetSchema, req.body);
    requireFeature(worldId, 'gambling');
    return playSlots(worldId, bet);
  });

  app.post('/gambling/roulette', async (req) => {
    const { worldId, bets } = parseInput(RouletteSpinSchema, req.body);
    requireFeature(worldId, 'gambling');
    return playRoulette(worldId, bets);
  });

  app.post('/gambling/blackjack/start', async (req) => {
    const { worldId, bet } = parseInput(BlackjackStartSchema, req.body);
    requireFeature(worldId, 'gambling');
    return startBlackjack(worldId, bet);
  });

  app.post('/gambling/blackjack/action', async (req) => {
    const { worldId, roundId, action } = parseInput(BlackjackActionSchema, req.body);
    requireFeature(worldId, 'gambling');
    return blackjackAction(worldId, roundId, action);
  });

  app.post('/gambling/videopoker/start', async (req) => {
    const { worldId, bet } = parseInput(VideoPokerStartSchema, req.body);
    requireFeature(worldId, 'gambling');
    return startVideoPoker(worldId, bet);
  });

  app.post('/gambling/videopoker/draw', async (req) => {
    const { worldId, roundId, holds } = parseInput(VideoPokerDrawSchema, req.body);
    requireFeature(worldId, 'gambling');
    return videoPokerDraw(worldId, roundId, holds);
  });
}
