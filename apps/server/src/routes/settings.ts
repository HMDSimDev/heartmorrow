import type { FastifyInstance } from 'fastify';
import { LlmSettingsSchema, LlmSettingsUpdateSchema, PromptEstimateRequestSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { getLlmSettings, getRedactedLlmSettings, updateLlmSettings } from '../services/settings-service';
import { runHealthCheck } from '../llm/health';
import { getAdapter } from '../llm/provider';
import { estimatePrompts } from '../services/prompt-estimator-service';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings', async () => getRedactedLlmSettings());

  app.patch('/settings', async (req) => {
    const update = parseInput(LlmSettingsUpdateSchema, req.body);
    updateLlmSettings(update);
    return getRedactedLlmSettings();
  });

  // Test connectivity using the current settings merged with any provided
  // overrides (overrides are NOT persisted — this is a dry-run).
  app.post('/settings/test', async (req) => {
    const patch = req.body ? parseInput(LlmSettingsUpdateSchema, req.body) : {};
    const current = getLlmSettings();
    const effective = LlmSettingsSchema.parse({
      ...current,
      ...patch,
      apiKey: patch.apiKey && patch.apiKey.length > 0 ? patch.apiKey : current.apiKey,
    });
    return runHealthCheck(effective);
  });

  // List models from the endpoint. Accepts an optional override body (same shape
  // as the test route) so the UI can list against the values currently typed into
  // the form WITHOUT having to save them first. POST (not GET) so a body is allowed.
  app.post('/settings/models', async (req) => {
    const current = getLlmSettings();
    const patch = req.body ? parseInput(LlmSettingsUpdateSchema, req.body) : {};
    const settings = LlmSettingsSchema.parse({
      ...current,
      ...patch,
      apiKey: patch.apiKey && patch.apiKey.length > 0 ? patch.apiKey : current.apiKey,
    });
    try {
      const models = await getAdapter(settings).listModels(AbortSignal.timeout(10_000));
      return { ok: true, models };
    } catch (err) {
      return { ok: false, models: [], error: (err as Error).message };
    }
  });

  // Build the REAL prompt for each common interaction and report its size. When
  // `live` is set, token counts are the model's exact usage.prompt_tokens.
  app.post('/settings/prompt-estimate', async (req) => {
    const input = parseInput(PromptEstimateRequestSchema, req.body ?? {});
    return estimatePrompts(input);
  });
}
