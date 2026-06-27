import type { LlmSettings, LlmHealthResult } from '@dsim/shared';
import { getAdapter } from './provider';
import { describeLlmError } from './errors';

/**
 * Health check / test-prompt used by the Settings page. Tries to list models
 * (best effort) and sends a tiny chat prompt to confirm the endpoint responds.
 */
export async function runHealthCheck(settings: LlmSettings): Promise<LlmHealthResult> {
  const adapter = getAdapter(settings);

  let models: string[] | undefined;
  try {
    const timeout = AbortSignal.timeout(10_000);
    models = (await adapter.listModels(timeout)).map((m) => m.id);
  } catch {
    // Not all endpoints support /models; ignore.
  }

  const started = Date.now();
  try {
    const timeout = AbortSignal.timeout(30_000);
    const result = await adapter.chat(
      {
        messages: [
          { role: 'system', content: 'You are a connectivity test. Reply with a single short word.' },
          { role: 'user', content: 'Reply with the single word: pong' },
        ],
        temperature: 0,
        maxTokens: 16,
      },
      timeout,
    );
    const latencyMs = Date.now() - started;
    const sample = result.content.trim().slice(0, 200);
    // Surface LM Studio's per-response telemetry when the endpoint reports it.
    const tps = result.stats?.tokensPerSecond;
    const speed = typeof tps === 'number' ? ` · ${tps.toFixed(1)} tok/s` : '';
    return {
      ok: true,
      message: `Connected to ${settings.baseUrl} (model: ${settings.model})${speed}.`,
      latencyMs,
      sample: sample.length > 0 ? sample : '(empty reply)',
      models,
    };
  } catch (err) {
    return {
      ok: false,
      message: describeLlmError(err, settings.baseUrl),
      models,
    };
  }
}
