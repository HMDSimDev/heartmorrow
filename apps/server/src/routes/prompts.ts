import type { FastifyInstance } from 'fastify';
import { PromptOverridePatchSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { docSchema } from '../lib/openapi-schema';
import { getPromptCatalog, savePromptOverride, resetPromptOverride } from '../services/prompt-override-service';

/**
 * Prompt Editor API. The catalog lists every editable prompt (with its shipped
 * default + the active text); PUT saves a local override; DELETE restores the
 * default. Overrides are global, installation-local, and never bundled into world
 * or character share files. The model text is non-secret, so nothing is redacted.
 */
export async function promptRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/settings/prompts',
    { schema: docSchema({ tags: ['settings'], summary: 'List every editable prompt + its current/default text' }) },
    async () => ({ entries: getPromptCatalog() }),
  );

  app.put(
    '/settings/prompts/:id',
    { schema: docSchema({ tags: ['settings'], summary: 'Save a local override for one prompt', body: PromptOverridePatchSchema }) },
    async (req) => {
      const { id } = req.params as { id: string };
      const { text } = parseInput(PromptOverridePatchSchema, req.body ?? {});
      return savePromptOverride(id, text, Date.now());
    },
  );

  app.delete(
    '/settings/prompts/:id',
    { schema: docSchema({ tags: ['settings'], summary: 'Reset one prompt to its shipped default' }) },
    async (req) => {
      const { id } = req.params as { id: string };
      return resetPromptOverride(id);
    },
  );
}
