import type { PromptCatalogEntry } from '@dsim/shared';
import { promptOverridesRepo } from '../db/repositories';
import { buildPromptCatalog, isPromptId, setPromptOverrides, validateOverride, type PromptId } from '../prompt/registry';
import { badRequest } from '../lib/errors';

/**
 * Service layer for the local Prompt Editor. The canonical text + registry live in
 * `../prompt/registry`; this wires the persisted `prompt_overrides` table to the
 * registry's in-process override cache and exposes the catalog/save/reset the
 * routes call. The cache is refreshed from the DB after every write so a saved
 * override takes effect on the very next prompt the game builds.
 */

/** Load every saved override into the registry cache (called at boot + after writes).
 *  Stale ids (from a prompt removed in a later release) are dropped, never resolved. */
export function hydratePromptOverrides(): void {
  const raw = promptOverridesRepo.getAll();
  const valid: Record<string, string> = {};
  for (const [id, text] of Object.entries(raw)) {
    if (isPromptId(id)) valid[id] = text;
  }
  setPromptOverrides(valid);
}

/** The full catalog the editor renders (defaults + current text + metadata). */
export function getPromptCatalog(): PromptCatalogEntry[] {
  return buildPromptCatalog();
}

/** Save (or replace) one override. Validates the id and that every required
 *  `{{token}}` is retained, then persists and refreshes the cache. */
export function savePromptOverride(id: string, text: string, when: number): PromptCatalogEntry {
  if (!isPromptId(id)) throw badRequest(`Unknown prompt id: ${id}`);
  const check = validateOverride(id as PromptId, text);
  if (!check.ok) {
    throw badRequest(
      `Your custom prompt is missing required placeholder${check.missing.length === 1 ? '' : 's'} the game fills in: ${check.missing
        .map((t) => `{{${t}}}`)
        .join(', ')}. Keep them in the text.`,
    );
  }
  promptOverridesRepo.set(id, text, when);
  hydratePromptOverrides();
  return entryFor(id);
}

/** Drop the override for `id`, restoring the shipped default. */
export function resetPromptOverride(id: string): PromptCatalogEntry {
  if (!isPromptId(id)) throw badRequest(`Unknown prompt id: ${id}`);
  promptOverridesRepo.remove(id);
  hydratePromptOverrides();
  return entryFor(id);
}

function entryFor(id: string): PromptCatalogEntry {
  const entry = buildPromptCatalog().find((e) => e.id === id);
  // id is validated above, so it is always present.
  if (!entry) throw badRequest(`Unknown prompt id: ${id}`);
  return entry;
}
