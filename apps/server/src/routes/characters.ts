import type { FastifyInstance } from 'fastify';
import {
  CharacterCreateSchema,
  CharacterUpdateSchema,
  GenerateDatingStatsInputSchema,
  GenerateProfileInputSchema,
  GenerateCharacterFromImageInputSchema,
  MemoryCreateSchema,
} from '@dsim/shared';
import { parseInput } from '../lib/validate';
import {
  createCharacter,
  deleteCharacter,
  duplicateCharacter,
  ensureRoomDescription,
  generateCharacterFromImage,
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
  app.get('/characters', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    return listCharacters(worldId);
  });

  // The world's social web (authored links + world-sim-formed ties), grouped by
  // character — the read model behind the phone "Social" view.
  app.get('/social-web', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    return getSocialWeb(worldId);
  });

  // Canon facts an ex has established about this character (creator inspection).
  app.get('/characters/:id/canon-facts', async (req) => {
    const { id } = req.params as { id: string };
    getCharacter(id); // validate existence
    return listCanonFactsForCharacter(id);
  });

  // Reverse a canonization (reversible by design) — creator/dev curation.
  app.post('/canon-facts/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    rejectCanonFact(id);
    return { rejected: true };
  });

  // Character ids the player has lost (opt-in tragic outcomes) — for greying them
  // out. Static path, so it resolves before the `/characters/:id` param route.
  app.get('/characters/memorials', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    return listMemorialCharacterIds(worldId);
  });

  app.post('/characters', async (req, reply) => {
    const input = parseInput(CharacterCreateSchema, req.body);
    reply.code(201);
    return createCharacter(input);
  });

  // Generate dating stats from a (possibly unsaved) character draft via the LLM.
  app.post('/characters/generate-stats', async (req) => {
    const input = parseInput(GenerateDatingStatsInputSchema, req.body);
    return generateDatingStats(input);
  });

  // Generate narrative profile fields from a (possibly unsaved) character draft.
  app.post('/characters/generate-profile', async (req) => {
    const input = parseInput(GenerateProfileInputSchema, req.body);
    return generateCharacterProfile(input);
  });

  // Generate a FULL character draft from an uploaded portrait via a vision model.
  // Read-only: returns a server-bounded draft for the editor to review; no save.
  app.post('/characters/generate-from-image', async (req) => {
    const input = parseInput(GenerateCharacterFromImageInputSchema, req.body);
    return generateCharacterFromImage(input);
  });

  app.get('/characters/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getCharacter(id);
  });

  app.get('/characters/:id/bundle', async (req) => {
    const { id } = req.params as { id: string };
    return getCharacterBundle(id);
  });

  app.patch('/characters/:id', async (req) => {
    const { id } = req.params as { id: string };
    const patch = parseInput(CharacterUpdateSchema, req.body);
    return updateCharacter(id, patch);
  });

  app.delete('/characters/:id', async (req) => {
    const { id } = req.params as { id: string };
    deleteCharacter(id);
    return { ok: true };
  });

  app.post('/characters/:id/duplicate', async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.code(201);
    return duplicateCharacter(id);
  });

  app.get('/characters/:id/relationship', async (req) => {
    const { id } = req.params as { id: string };
    return getRelationship(id);
  });

  app.get('/characters/:id/chronicle', async (req) => {
    const { id } = req.params as { id: string };
    getCharacter(id); // validate existence
    return getChronicle(id);
  });

  app.get('/characters/:id/moments', async (req) => {
    const { id } = req.params as { id: string };
    return getMoments(id);
  });

  // The character's private room (their personal date venue) — generated on demand.
  app.get('/characters/:id/room', async (req) => {
    const { id } = req.params as { id: string };
    const character = getCharacter(id);
    const description = await ensureRoomDescription(id);
    return { name: `${character.name}'s Room`, description };
  });

  // --- memories ---
  app.get('/characters/:id/memories', async (req) => {
    const { id } = req.params as { id: string };
    return listMemories(id);
  });

  app.post('/characters/:id/memories', async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = parseInput(MemoryCreateSchema, req.body);
    reply.code(201);
    return addManualMemory(id, input);
  });

  app.delete('/memories/:memoryId', async (req) => {
    const { memoryId } = req.params as { memoryId: string };
    deleteMemory(memoryId);
    return { ok: true };
  });

  // --- prompt preview ---
  app.get('/characters/:id/prompt-preview', async (req) => {
    const { id } = req.params as { id: string };
    return previewCharacterPrompt(id);
  });
}
