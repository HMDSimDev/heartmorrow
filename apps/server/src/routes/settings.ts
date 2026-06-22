import type { FastifyInstance } from 'fastify';
import { LlmSettingsSchema, LlmSettingsUpdateSchema, PromptEstimateRequestSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { getLlmSettings, getRedactedLlmSettings, updateLlmSettings } from '../services/settings-service';
import { runHealthCheck } from '../llm/health';
import { getAdapter } from '../llm/provider';
import { estimatePrompts } from '../services/prompt-estimator-service';
import { docSchema } from '../lib/openapi-schema';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings', { schema: docSchema({ tags: ['settings'], summary: 'Get redacted LLM settings' }) }, async () => getRedactedLlmSettings());

  app.patch('/settings', { schema: docSchema({ tags: ['settings'], summary: 'Update LLM settings', body: LlmSettingsUpdateSchema }) }, async (req) => {
    const update = parseInput(LlmSettingsUpdateSchema, req.body);
    updateLlmSettings(update);
    return getRedactedLlmSettings();
  });

  // Resolve a dry-run connection from the current settings + a typed-in override
  // body (NOT persisted). When `role` is given (evaluator/vision), a blank key
  // falls back to THAT role's stored key, not the base one — so the UI can test a
  // role's saved endpoint without re-typing its key.
  const dryRunSettings = (body: unknown) => {
    const current = getLlmSettings();
    const role = (body as { role?: string } | null)?.role;
    const fallbackKey =
      role === 'evaluator' || role === 'vision' ? current.roleOverrides[role].apiKey : current.apiKey;
    const patch = body ? parseInput(LlmSettingsUpdateSchema, body) : {};
    return LlmSettingsSchema.parse({
      ...current,
      ...patch,
      apiKey: patch.apiKey && patch.apiKey.length > 0 ? patch.apiKey : fallbackKey,
    });
  };

  // Test connectivity using the current settings merged with any provided overrides.
  app.post('/settings/test', { schema: docSchema({ tags: ['settings'], summary: 'Test LLM connectivity with overrides', body: LlmSettingsUpdateSchema }) }, async (req) => runHealthCheck(dryRunSettings(req.body)));

  // List models from the endpoint. Accepts an optional override body (same shape
  // as the test route) so the UI can list against the values currently typed into
  // the form WITHOUT having to save them first. POST (not GET) so a body is allowed.
  app.post('/settings/models', { schema: docSchema({ tags: ['settings'], summary: 'List models from the endpoint', body: LlmSettingsUpdateSchema }) }, async (req) => {
    try {
      const models = await getAdapter(dryRunSettings(req.body)).listModels(AbortSignal.timeout(10_000));
      return { ok: true, models };
    } catch (err) {
      return { ok: false, models: [], error: (err as Error).message };
    }
  });

  // Build the REAL prompt for each common interaction and report its size. When
  // `live` is set, token counts are the model's exact usage.prompt_tokens.
  app.post('/settings/prompt-estimate', { schema: docSchema({ tags: ['settings'], summary: 'Estimate real prompt sizes', body: PromptEstimateRequestSchema }) }, async (req) => {
    const input = parseInput(PromptEstimateRequestSchema, req.body ?? {});
    return estimatePrompts(input);
  });
}
