import type { FastifyInstance } from 'fastify';
import { CreateFeedPostSchema, FeedCommentInputSchema, FeedReactSchema, SendTextSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import {
  claimTextGift,
  getThreadView,
  listContactableCharacters,
  listThreadSummaries,
  regenerateTextReply,
  retryPlayerTextReply,
  sendPlayerText,
  unreadTextCount,
} from '../services/text-message-service';
import { generateDailyEmails, listEmails, markEmailRead, unreadEmailCount } from '../services/email-service';
import { generateDailyTextsForDay } from '../services/text-generation-service';
import {
  commentOnPost,
  createPlayerPost,
  feedUnreadCount,
  generateFeedForDay,
  getFeedView,
  markFeedSeen,
  reactToPost,
} from '../services/feed-service';
import { ensureWorldState } from '../services/world-clock-service';
import { getWorld } from '../services/world-service';
import { featureEnabled } from '../services/world-feature-service';
import { landlordNoticesRepo } from '../db/repositories';
import { playerIdForWorld } from '../lib/ids';
import { docSchema, WorldScopedQuerySchema } from '../lib/openapi-schema';

export async function phoneRoutes(app: FastifyInstance): Promise<void> {
  // Badge counts for the phone home screen (scoped to the active world if given).
  app.get('/phone/inbox', { schema: docSchema({ tags: ['phone'], summary: 'Get phone badge counts', querystring: WorldScopedQuerySchema }) }, async (req) => {
    const { worldId } = req.query as { worldId?: string };
    const landlordUnread =
      worldId && featureEnabled(worldId, 'property')
        ? landlordNoticesRepo.countUnread(worldId, playerIdForWorld(worldId))
        : 0;
    return {
      unreadTexts: unreadTextCount(worldId),
      unreadEmails: unreadEmailCount(worldId),
      feedUnread: worldId ? feedUnreadCount(worldId) : 0,
      landlordUnread,
    };
  });

  // --- Messages ---
  app.get('/phone/threads', { schema: docSchema({ tags: ['phone'], summary: 'List text message threads', querystring: WorldScopedQuerySchema }) }, async (req) => {
    const { worldId } = req.query as { worldId?: string };
    return listThreadSummaries(worldId);
  });

  // Characters the player may start a text with (only those they've dated).
  app.get('/phone/contacts', { schema: docSchema({ tags: ['phone'], summary: 'List contactable characters', querystring: WorldScopedQuerySchema }) }, async (req) => {
    const { worldId } = req.query as { worldId?: string };
    return listContactableCharacters(worldId);
  });

  app.get('/phone/threads/:characterId', { schema: docSchema({ tags: ['phone'], summary: 'Get a text thread with a character' }) }, async (req) => {
    const { characterId } = req.params as { characterId: string };
    return getThreadView(characterId);
  });

  app.post('/phone/threads/:characterId/send', { schema: docSchema({ tags: ['phone'], summary: 'Send a text to a character', body: SendTextSchema }) }, async (req) => {
    const { characterId } = req.params as { characterId: string };
    const { text, imageAssetId, giftId } = parseInput(SendTextSchema, req.body);
    // `undefined` keeps the per-world playerId resolution sendPlayerText does itself.
    return sendPlayerText(characterId, text, imageAssetId, undefined, giftId);
  });

  // Regenerate a reply when the previous send saved the player's text but the
  // model failed to answer — no new player message is created (no duplicate).
  app.post('/phone/threads/:characterId/retry-reply', { schema: docSchema({ tags: ['phone'], summary: 'Retry generating a reply to the last unanswered text' }) }, async (req) => {
    const { characterId } = req.params as { characterId: string };
    return retryPlayerTextReply(characterId);
  });

  // Regenerate the character's LAST reply (when it was bad/looping) — rewrites the
  // prose only, without re-running the relationship judge.
  app.post('/phone/threads/:characterId/regenerate-reply', { schema: docSchema({ tags: ['phone'], summary: 'Regenerate the last reply (no re-judge)' }) }, async (req) => {
    const { characterId } = req.params as { characterId: string };
    return regenerateTextReply(characterId);
  });

  app.post('/phone/messages/:textId/claim-gift', { schema: docSchema({ tags: ['phone'], summary: 'Claim a gift from a text message' }) }, async (req) => {
    const { textId } = req.params as { textId: string };
    return claimTextGift(textId);
  });

  // --- Email ---
  app.get('/phone/emails', { schema: docSchema({ tags: ['phone'], summary: 'List emails', querystring: WorldScopedQuerySchema }) }, async (req) => {
    const { worldId } = req.query as { worldId?: string };
    return listEmails(worldId);
  });

  app.post('/phone/emails/:id/read', { schema: docSchema({ tags: ['phone'], summary: 'Mark an email as read' }) }, async (req) => {
    const { id } = req.params as { id: string };
    return markEmailRead(id);
  });

  // --- Faces (social feed) ---
  app.get('/phone/feed', { schema: docSchema({ tags: ['phone'], summary: 'Get the social feed', querystring: WorldScopedQuerySchema }) }, async (req) => {
    const { worldId } = req.query as { worldId?: string };
    return getFeedView(worldId ?? '');
  });

  app.post('/phone/feed/posts', { schema: docSchema({ tags: ['phone'], summary: 'Create a player feed post', body: CreateFeedPostSchema }) }, async (req) => {
    const input = parseInput(CreateFeedPostSchema, req.body);
    return createPlayerPost(input);
  });

  app.post('/phone/feed/posts/:id/react', { schema: docSchema({ tags: ['phone'], summary: 'React to a feed post', body: FeedReactSchema }) }, async (req) => {
    const { id } = req.params as { id: string };
    const { kind } = parseInput(FeedReactSchema, req.body);
    return reactToPost(id, kind);
  });

  app.post('/phone/feed/posts/:id/comment', { schema: docSchema({ tags: ['phone'], summary: 'Comment on a feed post', body: FeedCommentInputSchema }) }, async (req) => {
    const { id } = req.params as { id: string };
    const { body } = parseInput(FeedCommentInputSchema, req.body);
    return commentOnPost(id, body);
  });

  app.post('/phone/feed/seen', { schema: docSchema({ tags: ['phone'], summary: 'Mark the feed as seen' }) }, async (req) => {
    const { worldId } = (req.body ?? {}) as { worldId?: string };
    if (worldId) markFeedSeen(worldId);
    return { ok: true };
  });

  // --- Dev/testing: force-generate today's texts + emails for a world ---
  app.post('/phone/dev/generate', { schema: docSchema({ tags: ['phone'], summary: 'Dev: force-generate daily phone content' }) }, async (req) => {
    const { worldId } = (req.body ?? {}) as { worldId?: string };
    if (!worldId) return { ok: false, error: 'worldId required' };
    getWorld(worldId); // 404 if the world doesn't exist (avoids a phantom clock row)
    const day = ensureWorldState(worldId).day;
    await generateDailyTextsForDay(worldId, day);
    await generateDailyEmails(worldId, day);
    await generateFeedForDay(worldId, day);
    return { ok: true, day, worldId };
  });
}
