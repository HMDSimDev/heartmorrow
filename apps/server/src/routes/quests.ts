import type { FastifyInstance } from 'fastify';
import {
  QuestStartSchema,
  QuestTurnInputSchema,
  QuestAbandonSchema,
  QuestCreateSchema,
  QuestUpdateSchema,
  GenerateQuestInputSchema,
} from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { docSchema, WorldScopedQuerySchema } from '../lib/openapi-schema';
import { badRequest } from '../lib/errors';
import { requireFeature } from '../services/world-feature-service';
import {
  getQuestLobby,
  startQuest,
  takeQuestTurn,
  abandonQuest,
  listAuthoredQuests,
  getQuestById,
  createQuest,
  updateQuest,
  deleteQuest,
  generateQuest,
} from '../services/quest-service';

/**
 * Wayfarer quest routes, behind the per-world `quests` feature flag. Every handler
 * calls `requireFeature(worldId, 'quests')` first — the client hiding the tab is
 * cosmetic; THIS is the real gate. The service owns the seeded referee + every
 * capped side-effect; the client never reports an outcome.
 */
export async function questRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/quests',
    { schema: docSchema({ tags: ['quests'], summary: 'List a world’s quests + the active run', querystring: WorldScopedQuerySchema }) },
    async (req) => {
      const { worldId } = req.query as { worldId?: string };
      if (!worldId) throw badRequest('worldId is required.');
      requireFeature(worldId, 'quests');
      return getQuestLobby(worldId);
    },
  );

  app.post(
    '/quests/start',
    { schema: docSchema({ tags: ['quests'], summary: 'Begin a quest', body: QuestStartSchema }) },
    async (req) => {
      const { worldId, questId } = parseInput(QuestStartSchema, req.body);
      requireFeature(worldId, 'quests');
      return startQuest(worldId, questId);
    },
  );

  app.post(
    '/quests/turn',
    { schema: docSchema({ tags: ['quests'], summary: 'Take a turn in the active quest', body: QuestTurnInputSchema }) },
    async (req) => {
      const { worldId, text } = parseInput(QuestTurnInputSchema, req.body);
      requireFeature(worldId, 'quests');
      return takeQuestTurn(worldId, text);
    },
  );

  app.post(
    '/quests/abandon',
    { schema: docSchema({ tags: ['quests'], summary: 'Leave the active quest', body: QuestAbandonSchema }) },
    async (req) => {
      const { worldId } = parseInput(QuestAbandonSchema, req.body);
      requireFeature(worldId, 'quests');
      return abandonQuest(worldId);
    },
  );

  // --- authoring (creator) ---
  app.get(
    '/quests/authoring',
    { schema: docSchema({ tags: ['quests'], summary: 'List a world’s authored quests (full graphs)', querystring: WorldScopedQuerySchema }) },
    async (req) => {
      const { worldId } = req.query as { worldId?: string };
      if (!worldId) throw badRequest('worldId is required.');
      requireFeature(worldId, 'quests');
      return { quests: listAuthoredQuests(worldId) };
    },
  );

  app.post(
    '/quests/authoring',
    { schema: docSchema({ tags: ['quests'], summary: 'Create a quest (creator authoring)', body: QuestCreateSchema }) },
    async (req, reply) => {
      const input = parseInput(QuestCreateSchema, req.body);
      requireFeature(input.worldId, 'quests');
      reply.code(201);
      return createQuest(input);
    },
  );

  app.patch(
    '/quests/authoring/:id',
    { schema: docSchema({ tags: ['quests'], summary: 'Update a quest (creator authoring)', body: QuestUpdateSchema }) },
    async (req) => {
      const { id } = req.params as { id: string };
      requireFeature(getQuestById(id).worldId, 'quests');
      return updateQuest(id, parseInput(QuestUpdateSchema, req.body));
    },
  );

  app.delete(
    '/quests/authoring/:id',
    { schema: docSchema({ tags: ['quests'], summary: 'Delete a quest (creator authoring)' }) },
    async (req) => {
      const { id } = req.params as { id: string };
      requireFeature(getQuestById(id).worldId, 'quests');
      deleteQuest(id);
      return { ok: true };
    },
  );

  app.post(
    '/quests/generate',
    { schema: docSchema({ tags: ['quests'], summary: 'Draft a quest via the LLM (creator ✨)', body: GenerateQuestInputSchema }) },
    async (req) => {
      const { worldId, prompt, partnerId } = parseInput(GenerateQuestInputSchema, req.body);
      requireFeature(worldId, 'quests');
      return generateQuest(worldId, prompt, partnerId ?? null);
    },
  );
}
