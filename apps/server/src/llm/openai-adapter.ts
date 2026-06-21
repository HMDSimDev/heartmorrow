import type { LlmModelInfo } from '@dsim/shared';
import type { ChatAdapter, ChatRequest, ChatResult, GenerationStats } from './types';

/**
 * Adapter for any OpenAI-API-compatible endpoint (LM Studio, Ollama,
 * llama.cpp server, vLLM, text-generation-webui, etc.) using the
 * `/chat/completions` shape.
 *
 * Only the SERVER constructs and uses this. The browser never holds the API
 * key or talks to the model endpoint directly.
 */

export interface OpenAiAdapterConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Optional advanced sampling knobs, applied to every request when set. Each is
   * omitted from the payload when null/undefined so the endpoint keeps its own
   * default (and strict OpenAI-proper servers aren't sent fields they reject).
   * Per-request `temperature`/`maxTokens` still come from the ChatRequest.
   */
  sampling?: {
    topP?: number | null;
    topK?: number | null;
    minP?: number | null;
    frequencyPenalty?: number | null;
    presencePenalty?: number | null;
    repeatPenalty?: number | null;
  };
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Map an LM-Studio-style `stats` block (also emitted by some other servers)
 * to our camelCased GenerationStats. Returns undefined when nothing is present. */
export function parseGenerationStats(stats: unknown): GenerationStats | undefined {
  if (!stats || typeof stats !== 'object') return undefined;
  const s = stats as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const out: GenerationStats = {
    tokensPerSecond: num(s.tokens_per_second),
    timeToFirstTokenSec: num(s.time_to_first_token),
    generationTimeSec: num(s.generation_time),
  };
  return out.tokensPerSecond != null || out.timeToFirstTokenSec != null || out.generationTimeSec != null
    ? out
    : undefined;
}

export class OpenAiCompatibleAdapter implements ChatAdapter {
  readonly name: string = 'openai-compatible';

  constructor(protected readonly cfg: OpenAiAdapterConfig) {}

  protected headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) h.Authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  private body(req: ChatRequest, stream: boolean): string {
    const payload: Record<string, unknown> = {
      model: this.cfg.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.8,
      max_tokens: req.maxTokens ?? 1024,
      stream,
    };
    if (req.responseFormat && req.responseFormat.type !== 'text') {
      payload.response_format = req.responseFormat;
    }
    // Advanced sampling knobs: send each only when explicitly set, under its
    // OpenAI-compatible field name. Omitting null/undefined keeps the endpoint's
    // own default and avoids tripping strict servers that reject these fields.
    const s = this.cfg.sampling;
    if (s) {
      if (s.topP != null) payload.top_p = s.topP;
      if (s.topK != null) payload.top_k = s.topK;
      if (s.minP != null) payload.min_p = s.minP;
      if (s.frequencyPenalty != null) payload.frequency_penalty = s.frequencyPenalty;
      if (s.presencePenalty != null) payload.presence_penalty = s.presencePenalty;
      if (s.repeatPenalty != null) payload.repeat_penalty = s.repeatPenalty;
    }
    return JSON.stringify(payload);
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const res = await fetch(joinUrl(this.cfg.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: this.body(req, false),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM endpoint returned ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; reasoning_content?: string; reasoning?: string };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      // LM Studio's native /api/v0 chat response carries a `stats` block; plain
      // OpenAI servers omit it (so this stays undefined there).
      stats?: unknown;
    };
    const choice = data.choices?.[0];
    const message = choice?.message;
    const primary = message?.content ?? '';
    // Some models leave `content` empty and put their text in `reasoning_content`
    // (or `reasoning`). Fall back to those so we don't report an empty reply.
    const fallback = message?.reasoning_content ?? message?.reasoning ?? '';
    return {
      content: primary.trim() ? primary : fallback,
      finishReason: choice?.finish_reason,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
      stats: parseGenerationStats(data.stats),
    };
  }

  async streamChat(
    req: ChatRequest,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const res = await fetch(joinUrl(this.cfg.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: this.body(req, true),
      signal,
    });
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text().catch(() => '') : '';
      throw new Error(`LLM endpoint returned ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let contentChars = 0;
    let reasoning = ''; // captured from reasoning_content/reasoning deltas
    let finishReason: string | undefined;

    // OpenAI streaming format: lines of `data: {json}` separated by blank lines,
    // terminated by `data: [DONE]`.
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{
            delta?: { content?: string; reasoning_content?: string; reasoning?: string };
            finish_reason?: string;
          }>;
        };
        const choice = json.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          content += delta;
          contentChars += delta.length;
          onDelta(delta);
        }
        const reasoningDelta = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
        if (typeof reasoningDelta === 'string') reasoning += reasoningDelta;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      } catch {
        // Ignore non-JSON keepalive lines.
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }
    // Flush any remaining bytes + process a final line that lacked a trailing
    // newline (some local servers do this before closing the connection).
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);

    // If the model streamed everything into reasoning_content (empty content),
    // surface that as the reply so it isn't reported as empty.
    if (contentChars === 0 && reasoning) {
      content = reasoning;
      onDelta(reasoning);
    }

    return { content, finishReason };
  }

  async listModels(signal?: AbortSignal): Promise<LlmModelInfo[]> {
    const res = await fetch(joinUrl(this.cfg.baseUrl, 'models'), {
      method: 'GET',
      headers: this.headers(),
      signal,
    });
    if (!res.ok) {
      throw new Error(`Model listing returned ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
      .map((id) => ({ id }));
  }
}
