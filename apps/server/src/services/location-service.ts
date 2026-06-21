import {
  GenerateLocationsInputSchema,
  GenerateWorldInputSchema,
  LocationGenerationSchema,
  LocationSchema,
  WorldGenerationSchema,
  WorldGenDraftSchema,
  WorldNoteCreateSchema,
  LOCATION_GEN,
  WORLD_GEN,
  type GenerateLocationsInput,
  type GenerateWorldInput,
  type GeneratedLocation,
  type GeneratedWorldNote,
  type Location,
  type WorldGenDraft,
  type WorldNoteCreate,
  type StructuredResult,
} from '@dsim/shared';
import { buildLocationGenMessages, buildWorldGenMessages } from '../prompt/prompt-builder';
import { callStructuredLlm } from '../llm/structured';
import { getLlmSettings } from './settings-service';
import { getWorld } from './world-service';
import { newId } from '../lib/ids';

/**
 * Coerce one generated location into a real, server-owned Location: assign the
 * id, clamp name/description/tags to bounds, and normalize tags. `LocationSchema`
 * is the final authority on the shape — the model never sets the id.
 */
function boundGeneratedLocation(g: GeneratedLocation): Location {
  const tags = g.tags
    .map((t) => t.trim().toLowerCase().slice(0, LOCATION_GEN.MAX_TAG_LEN))
    .filter((t) => t.length > 0)
    .slice(0, LOCATION_GEN.MAX_TAGS);
  return LocationSchema.parse({
    id: newId('loc'),
    name: g.name.trim().slice(0, LOCATION_GEN.MAX_NAME),
    description: g.description.trim().slice(0, LOCATION_GEN.MAX_DESCRIPTION),
    tags,
    indoor: g.indoor,
  });
}

/**
 * Generate a batch of in-world locations via the LLM, flavored by the named
 * world's lore/tone and steered by the creator's free-form prompt. Read-only:
 * returns server-bounded DRAFTS (with fresh ids) for the creator to review/edit
 * before saving them onto the world — it does NOT persist anything. Fails safe
 * (typed StructuredResult) if the model can't comply.
 */
export async function generateLocations(
  worldId: string,
  input: GenerateLocationsInput,
): Promise<StructuredResult<Location[]>> {
  const world = getWorld(worldId); // throws notFound if the world is gone
  const data = GenerateLocationsInputSchema.parse(input);
  const settings = getLlmSettings();
  const result = await callStructuredLlm(
    LocationGenerationSchema,
    buildLocationGenMessages({
      world,
      existingNames: world.locations.map((l) => l.name),
      count: data.count,
      prompt: data.prompt,
    }),
    {
      settings,
      task: 'Generate a batch of in-world locations (name, description, tags, indoor) that fit the world.',
      schemaName: 'LocationGeneration',
    },
  );
  if (!result.ok) {
    return { ok: false, error: result.error, attempts: result.attempts, lastRaw: result.lastRaw };
  }
  const drafts = result.data.locations.map(boundGeneratedLocation);
  return { ok: true, data: drafts, attempts: result.attempts };
}

/**
 * Coerce one generated world note into a ready-to-create WorldNoteCreate: trim
 * title/body to bounds and normalize tags. `WorldNoteCreateSchema` is the final
 * authority on the shape (and applies scope/importance defaults).
 */
function boundGeneratedNote(g: GeneratedWorldNote): WorldNoteCreate {
  const tags = g.tags
    .map((t) => t.trim().toLowerCase().slice(0, LOCATION_GEN.MAX_TAG_LEN))
    .filter((t) => t.length > 0)
    .slice(0, WORLD_GEN.MAX_NOTE_TAGS);
  return WorldNoteCreateSchema.parse({
    title: g.title.trim().slice(0, WORLD_GEN.MAX_NOTE_TITLE),
    body: g.body.trim().slice(0, WORLD_GEN.MAX_NOTE_BODY),
    tags,
    scope: g.scope,
    importance: g.importance,
  });
}

/**
 * Generate a WHOLE world DRAFT (setting + a batch of locations, NO characters) from
 * a few creator seeds, for the onboarding "Set the scene" step. Read-only: returns a
 * server-bounded draft the creator edits before it's actually created — persists
 * nothing. Fails safe (typed StructuredResult) if the model can't comply.
 */
export async function generateWorld(input: GenerateWorldInput): Promise<StructuredResult<WorldGenDraft>> {
  const data = GenerateWorldInputSchema.parse(input);
  const settings = getLlmSettings();
  const result = await callStructuredLlm(WorldGenerationSchema, buildWorldGenMessages(data), {
    settings,
    task: 'Generate a complete world (name, summary, tone, lore, rules, and locations) — but NO characters.',
    schemaName: 'WorldGeneration',
  });
  if (!result.ok) {
    return { ok: false, error: result.error, attempts: result.attempts, lastRaw: result.lastRaw };
  }
  // The schema is the final authority: trim text to bounds, bound every location +
  // note (fresh ids assigned later), and validate the whole shape. No ids from the model.
  const draft = WorldGenDraftSchema.parse({
    name: result.data.name.trim().slice(0, WORLD_GEN.MAX_NAME),
    summary: result.data.summary.trim().slice(0, WORLD_GEN.MAX_SUMMARY),
    tone: result.data.tone.trim().slice(0, WORLD_GEN.MAX_TONE),
    lore: result.data.lore.trim().slice(0, WORLD_GEN.MAX_LORE),
    rules: result.data.rules.trim().slice(0, WORLD_GEN.MAX_RULES),
    globalNotes: result.data.globalNotes.trim().slice(0, WORLD_GEN.MAX_GLOBAL_NOTES),
    locations: result.data.locations.map(boundGeneratedLocation),
    notes: result.data.notes.map(boundGeneratedNote),
  });
  return { ok: true, data: draft, attempts: result.attempts };
}
