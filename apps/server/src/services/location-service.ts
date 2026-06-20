import {
  GenerateLocationsInputSchema,
  LocationGenerationSchema,
  LocationSchema,
  LOCATION_GEN,
  type GenerateLocationsInput,
  type GeneratedLocation,
  type Location,
  type StructuredResult,
} from '@dsim/shared';
import { buildLocationGenMessages } from '../prompt/prompt-builder';
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
