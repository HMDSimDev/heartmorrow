import type { FastifyInstance } from 'fastify';
import {
  CharacterCreateSchema,
  CharacterUpdateSchema,
  GenerateDatingStatsInputSchema,
  GenerateProfileInputSchema,
  GenerateCharacterFromImageInputSchema,
  GenerateCharacterFromSourcesInputSchema,
  MemoryCreateSchema,
} from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { docSchema, WorldScopedQuerySchema } from '../lib/openapi-schema';
import {
  composeConstellation,
  composeDossier,
  createCharacter,
  deleteCharacter,
  duplicateCharacter,
  ensureRoomDescription,
  generateCharacterFromImage,
  generateCharacterFromSources,
  generateCharacterProfile,
  generateDatingStats,
  getCharacter,
  getCharacterBundle,
  getSocialWeb,
  listCharacters,
  updateCharacter,
} from '../services/character-service';
import { getRelationship } from '../services/relationship-service';
import { addManualMemory, deleteMemory, listMemories } from '../services/memory-service';
import { previewCharacterPrompt } from '../services/conversation-service';
import { getChronicle } from '../services/chronicle-service';
import { getMoments } from '../services/moments-service';
import { listMemorialCharacterIds } from '../services/crisis-service';
import { listCanonFactsForCharacter, rejectCanonFact } from '../services/ex-canon-service';

export async function characterRoutes(app: FastifyInstance): Promise<void> {
  // Optional ?worldId scopes the roster to one world (the active save). Omitting it
  // returns every world's characters (creator/admin views).
  app.get(
    '/characters',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'List characters, optionally scoped to a world',
        querystring: WorldScopedQuerySchema,
      }),
    },
    async (req) => {
      const { worldId } = req.query as { worldId?: string };
      return listCharacters(worldId);
    },
  );

  // The world's social web (authored links + world-sim-formed ties), grouped by
  // character — the read model behind the phone Constellation view.
  app.get(
    '/social-web',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: "Get the world's social web grouped by character",
        querystring: WorldScopedQuerySchema,
      }),
    },
    async (req) => {
      const { worldId } = req.query as { worldId?: string };
      return getSocialWeb(worldId);
    },
  );

  // The player-centric layer of the Constellation map: the hearth + warmth-weighted
  // threads to everyone the player has met (the NPC↔NPC web rides /social-web).
  app.get(
    '/constellation',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: "Get the player's constellation edges (warmth to each met character)",
        querystring: WorldScopedQuerySchema,
      }),
    },
    async (req) => {
      const { worldId } = req.query as { worldId?: string };
      return composeConstellation(worldId);
    },
  );

  // Canon facts an ex has established about this character (creator inspection).
  app.get(
    '/characters/:id/canon-facts',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'List canon facts an ex established about a character',
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      getCharacter(id); // validate existence
      return listCanonFactsForCharacter(id);
    },
  );

  // Reverse a canonization (reversible by design) — creator/dev curation.
  app.post(
    '/canon-facts/:id/reject',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'Reverse a canonized fact',
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      rejectCanonFact(id);
      return { rejected: true };
    },
  );

  // Character ids the player has lost (opt-in tragic outcomes) — for greying them
  // out. Static path, so it resolves before the `/characters/:id` param route.
  app.get(
    '/characters/memorials',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'List character ids the player has lost',
        querystring: WorldScopedQuerySchema,
      }),
    },
    async (req) => {
      const { worldId } = req.query as { worldId?: string };
      return listMemorialCharacterIds(worldId);
    },
  );

  app.post(
    '/characters',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'Create a character',
        body: CharacterCreateSchema,
      }),
    },
    async (req, reply) => {
      const input = parseInput(CharacterCreateSchema, req.body);
      reply.code(201);
      return createCharacter(input);
    },
  );

  // Generate dating stats from a (possibly unsaved) character draft via the LLM.
  app.post(
    '/characters/generate-stats',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'Generate dating stats from a character draft',
        body: GenerateDatingStatsInputSchema,
      }),
    },
    async (req) => {
      const input = parseInput(GenerateDatingStatsInputSchema, req.body);
      return generateDatingStats(input);
    },
  );

  // Generate narrative profile fields from a (possibly unsaved) character draft.
  app.post(
    '/characters/generate-profile',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'Generate narrative profile fields from a draft',
        body: GenerateProfileInputSchema,
      }),
    },
    async (req) => {
      const input = parseInput(GenerateProfileInputSchema, req.body);
      return generateCharacterProfile(input);
    },
  );

  // Generate a FULL character draft from an uploaded portrait via a vision model.
  // Read-only: returns a server-bounded draft for the editor to review; no save.
  app.post(
    '/characters/generate-from-image',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'Generate a character draft from a portrait',
        body: GenerateCharacterFromImageInputSchema,
      }),
    },
    async (req) => {
      const input = parseInput(GenerateCharacterFromImageInputSchema, req.body);
      return generateCharacterFromImage(input);
    },
  );

  // Generate a FULL character draft from any combination of a portrait and/or
  // free-text reference (pasted text or an uploaded text file's contents). The
  // text is untrusted reference DATA only. Read-only: returns a bounded draft.
  app.post(
    '/characters/generate',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'Generate a character draft from image and/or text',
        body: GenerateCharacterFromSourcesInputSchema,
      }),
    },
    async (req) => {
      const input = parseInput(GenerateCharacterFromSourcesInputSchema, req.body);
      return generateCharacterFromSources(input);
    },
  );

  app.get(
    '/characters/:id',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'Get a character by id',
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getCharacter(id);
    },
  );

  app.get(
    '/characters/:id/bundle',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'Get a character bundle by id',
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getCharacterBundle(id);
    },
  );

  app.patch(
    '/characters/:id',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'Update a character',
        body: CharacterUpdateSchema,
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const patch = parseInput(CharacterUpdateSchema, req.body);
      return updateCharacter(id, patch);
    },
  );

  app.delete(
    '/characters/:id',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'Delete a character',
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      deleteCharacter(id);
      return { ok: true };
    },
  );

  app.post(
    '/characters/:id/duplicate',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'Duplicate a character',
      }),
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      reply.code(201);
      return duplicateCharacter(id);
    },
  );

  app.get(
    '/characters/:id/relationship',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: "Get a character's relationship with the player",
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getRelationship(id);
    },
  );

  // The Social app's tap-to-open person sheet: standing + ties + remembered life +
  // the grapevine. A pure read-model composed from existing repos.
  app.get(
    '/characters/:id/dossier',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: "Get a character's social dossier (standing, ties, timeline, gossip)",
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return composeDossier(id);
    },
  );

  app.get(
    '/characters/:id/chronicle',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: "Get a character's chronicle",
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      getCharacter(id); // validate existence
      return getChronicle(id);
    },
  );

  app.get(
    '/characters/:id/moments',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: "Get a character's moments",
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return getMoments(id);
    },
  );

  // The character's private room (their personal date venue) — generated on demand.
  app.get(
    '/characters/:id/room',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: "Get a character's private room venue",
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const character = getCharacter(id);
      const description = await ensureRoomDescription(id);
      return { name: `${character.name}'s Room`, description };
    },
  );

  // --- memories ---
  app.get(
    '/characters/:id/memories',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: "List a character's memories",
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return listMemories(id);
    },
  );

  app.post(
    '/characters/:id/memories',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'Add a manual memory to a character',
        body: MemoryCreateSchema,
      }),
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const input = parseInput(MemoryCreateSchema, req.body);
      reply.code(201);
      return addManualMemory(id, input);
    },
  );

  app.delete(
    '/memories/:memoryId',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: 'Delete a memory',
      }),
    },
    async (req) => {
      const { memoryId } = req.params as { memoryId: string };
      deleteMemory(memoryId);
      return { ok: true };
    },
  );

  // --- prompt preview ---
  app.get(
    '/characters/:id/prompt-preview',
    {
      schema: docSchema({
        tags: ['characters'],
        summary: "Preview a character's generated prompt",
      }),
    },
    async (req) => {
      const { id } = req.params as { id: string };
      return previewCharacterPrompt(id);
    },
  );
}
