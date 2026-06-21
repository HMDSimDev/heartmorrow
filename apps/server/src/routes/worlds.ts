import type { FastifyInstance } from 'fastify';
import {
  WorldCreateSchema,
  WorldUpdateSchema,
  WorldNoteCreateSchema,
  WorldNoteUpdateSchema,
  GenerateLocationsInputSchema,
  GenerateWorldInputSchema,
  CloneWorldSchema,
  ImportCharactersSchema,
} from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { generateLocations, generateWorld } from '../services/location-service';
import {
  cloneWorld,
  createWorld,
  createWorldNote,
  deleteWorld,
  deleteWorldNote,
  getWorld,
  listWorldNotes,
  listWorlds,
  updateWorld,
  updateWorldNote,
} from '../services/world-service';
import { cloneCharactersToWorld } from '../services/character-service';
import { getActiveDateForWorld } from '../services/conversation-service';
import { advanceDay, getWorldState } from '../services/world-clock-service';
import { getWorldAvailability } from '../services/availability-service';
import { getWorldWeather } from '../services/ambiance-service';
import { getWorldCalendar } from '../services/day-record-service';

export async function worldRoutes(app: FastifyInstance): Promise<void> {
  app.get('/worlds', async () => listWorlds());

  app.post('/worlds', async (req, reply) => {
    const input = parseInput(WorldCreateSchema, req.body);
    reply.code(201);
    return createWorld(input);
  });

  // Onboarding tool: generate a whole world DRAFT (setting + locations, no cast)
  // from a few seeds. Read-only — returns a draft for review, creates nothing.
  app.post('/worlds/generate', async (req) => {
    const input = parseInput(GenerateWorldInputSchema, req.body);
    return generateWorld(input);
  });

  // Start a new save from an existing world: clones its definition, notes, and cast.
  app.post('/worlds/:id/clone', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = parseInput(CloneWorldSchema, req.body);
    reply.code(201);
    return cloneWorld(id, name);
  });

  // Import (copy) character definitions from other worlds into this world.
  app.post('/worlds/:id/import-characters', async (req, reply) => {
    const { id } = req.params as { id: string };
    getWorld(id); // validate the target exists
    const { sourceCharacterIds } = parseInput(ImportCharactersSchema, req.body);
    reply.code(201);
    return cloneCharactersToWorld(sourceCharacterIds, id);
  });

  app.get('/worlds/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getWorld(id);
  });

  app.patch('/worlds/:id', async (req) => {
    const { id } = req.params as { id: string };
    const patch = parseInput(WorldUpdateSchema, req.body);
    return updateWorld(id, patch);
  });

  app.delete('/worlds/:id', async (req) => {
    const { id } = req.params as { id: string };
    // Opt-in: also delete the world's characters. Default keeps them (unassigned).
    const { deleteCharacters } = req.query as { deleteCharacters?: string };
    deleteWorld(id, deleteCharacters === 'true');
    return { ok: true };
  });

  // Creator tool: generate a batch of location DRAFTS from a prompt + the world's
  // own lore (loaded server-side). Read-only — returns drafts for review, no mutation.
  app.post('/worlds/:id/locations/generate', async (req) => {
    const { id } = req.params as { id: string };
    const input = parseInput(GenerateLocationsInputSchema, req.body);
    return generateLocations(id, input);
  });

  // --- world clock (time / stamina / day) ---
  app.get('/worlds/:id/state', async (req) => {
    const { id } = req.params as { id: string };
    getWorld(id); // validate existence
    return getWorldState(id);
  });

  app.post('/worlds/:id/sleep', async (req) => {
    const { id } = req.params as { id: string };
    getWorld(id);
    return advanceDay(id);
  });

  app.get('/worlds/:id/availability', async (req) => {
    const { id } = req.params as { id: string };
    getWorld(id);
    return getWorldAvailability(id, getWorldState(id).day);
  });

  // The world's single in-progress date, if any — lets the client RESUME a date
  // after a navigation/refresh and lock day-spending actions while it's underway.
  app.get('/worlds/:id/active-date', async (req) => {
    const { id } = req.params as { id: string };
    getWorld(id);
    return { date: getActiveDateForWorld(id) };
  });

  app.get('/worlds/:id/weather', async (req) => {
    const { id } = req.params as { id: string };
    getWorld(id);
    return getWorldWeather(id);
  });

  // The almanac: history of every day (recaps + what happened), for the Calendar app.
  app.get('/worlds/:id/calendar', async (req) => {
    const { id } = req.params as { id: string };
    getWorld(id);
    return getWorldCalendar(id);
  });

  // --- world notes ---
  app.get('/worlds/:id/notes', async (req) => {
    const { id } = req.params as { id: string };
    return listWorldNotes(id);
  });

  app.post('/worlds/:id/notes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const input = parseInput(WorldNoteCreateSchema, req.body);
    reply.code(201);
    return createWorldNote(id, input);
  });

  app.patch('/world-notes/:noteId', async (req) => {
    const { noteId } = req.params as { noteId: string };
    const patch = parseInput(WorldNoteUpdateSchema, req.body);
    return updateWorldNote(noteId, patch);
  });

  app.delete('/world-notes/:noteId', async (req) => {
    const { noteId } = req.params as { noteId: string };
    deleteWorldNote(noteId);
    return { ok: true };
  });
}
