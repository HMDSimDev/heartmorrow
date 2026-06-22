import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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

  // A blank baseUrl falls back to the stored image config, so the UI can probe a
  // saved endpoint without re-typing it.
  const ImageBody = z.object({ baseUrl: z.string().optional() });
  const imageRoot = (baseUrl?: string) =>
    (baseUrl && baseUrl.trim().length > 0 ? baseUrl.trim() : getLlmSettings().image.baseUrl).replace(/\/+$/, '');

  // Fetch the sampler names an AUTOMATIC1111 / SD WebUI server advertises via its
  // `/sdapi/v1/samplers` listing. Shared by the test + list-samplers routes.
  const fetchSamplers = async (root: string): Promise<string[]> => {
    const res = await fetch(`${root}/sdapi/v1/samplers`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Endpoint returned ${res.status} ${res.statusText}.`);
    const body = (await res.json()) as Array<{ name?: string }>;
    return Array.isArray(body) ? body.map((s) => s?.name).filter((n): n is string => !!n) : [];
  };

  // Test connectivity to an SD txt2img endpoint. We hit the cheap samplers listing
  // (no image is generated) and report how many the server advertised.
  app.post(
    '/settings/image/test',
    { schema: docSchema({ tags: ['settings'], summary: 'Test the image-generation (SD) endpoint', body: ImageBody }) },
    async (req) => {
      const { baseUrl } = parseInput(ImageBody, req.body ?? {});
      const started = Date.now();
      try {
        const names = await fetchSamplers(imageRoot(baseUrl));
        return {
          ok: true,
          message: `Reached the SD endpoint — ${names.length} sampler${names.length === 1 ? '' : 's'} available.`,
          latencyMs: Date.now() - started,
          sample: names.slice(0, 8).join(', '),
        };
      } catch (err) {
        return { ok: false, message: (err as Error).message || 'Could not reach the endpoint.', latencyMs: Date.now() - started };
      }
    },
  );

  // List the samplers from the SD endpoint so the UI can offer them as a picker
  // (with freeform entry). Mirrors the LLM `/settings/models` route's shape.
  app.post(
    '/settings/image/samplers',
    { schema: docSchema({ tags: ['settings'], summary: 'List samplers from the SD endpoint', body: ImageBody }) },
    async (req) => {
      const { baseUrl } = parseInput(ImageBody, req.body ?? {});
      try {
        return { ok: true, samplers: await fetchSamplers(imageRoot(baseUrl)) };
      } catch (err) {
        return { ok: false, samplers: [], error: (err as Error).message };
      }
    },
  );

  // Build the REAL prompt for each common interaction and report its size. When
  // `live` is set, token counts are the model's exact usage.prompt_tokens.
  app.post('/settings/prompt-estimate', { schema: docSchema({ tags: ['settings'], summary: 'Estimate real prompt sizes', body: PromptEstimateRequestSchema }) }, async (req) => {
    const input = parseInput(PromptEstimateRequestSchema, req.body ?? {});
    return estimatePrompts(input);
  });
}
