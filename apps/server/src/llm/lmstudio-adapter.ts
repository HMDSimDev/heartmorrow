import type { LlmModelInfo } from '@dsim/shared';
import { OpenAiCompatibleAdapter, joinUrl } from './openai-adapter';

/**
 * Adapter for LM Studio's NATIVE REST API (https://lmstudio.ai/docs/developer/rest).
 *
 * The chat/streaming surface is OpenAI-compatible (LM Studio mirrors the
 * `/chat/completions` request/response shape and additionally returns a `stats`
 * block, which the base adapter already parses), so we inherit those wholesale.
 * The native API only differs in its model listing: `/api/v0/models` advertises
 * richer per-model metadata (loaded state, context length, quantization, type)
 * than the bare `{id}` list the OpenAI-compatible `/v1/models` returns.
 *
 * The configured `baseUrl` should point at the native root, e.g.
 * `http://localhost:1234/api/v0` — chat then hits `…/api/v0/chat/completions`
 * and listing hits `…/api/v0/models`.
 */
export class LmStudioAdapter extends OpenAiCompatibleAdapter {
  override readonly name = 'lmstudio';

  override async listModels(signal?: AbortSignal): Promise<LlmModelInfo[]> {
    const res = await fetch(joinUrl(this.cfg.baseUrl, 'models'), {
      method: 'GET',
      headers: this.headers(),
      signal,
    });
    if (!res.ok) {
      throw new Error(`Model listing returned ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      data?: Array<{
        id?: string;
        type?: string;
        state?: string; // "loaded" | "not-loaded"
        quantization?: string;
        max_context_length?: number;
      }>;
    };
    return (data.data ?? [])
      .filter((m): m is { id: string } & typeof m => typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        loaded: m.state === 'loaded',
        contextLength: typeof m.max_context_length === 'number' ? m.max_context_length : undefined,
        quantization: typeof m.quantization === 'string' ? m.quantization : undefined,
        type: typeof m.type === 'string' ? m.type : undefined,
      }));
  }
}
