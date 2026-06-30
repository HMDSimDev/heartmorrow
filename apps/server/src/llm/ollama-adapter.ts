import type { LlmModelInfo, OllamaThink } from '@dsim/shared';
import { llmFetch } from './errors';
import { joinUrl } from './openai-adapter';
import type {
  ChatAdapter,
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatResult,
  GenerationStats,
  TokenUsage,
} from './types';

/**
 * Adapter for Ollama's NATIVE API (https://docs.ollama.com/api), `POST /api/chat`.
 *
 * Ollama also exposes an OpenAI-compatible surface at `/v1/chat/completions` (use
 * the `chat_completions` mode for that). This native adapter exists for the things
 * that surface ONLY here:
 *  - `think` — toggle a model's reasoning trace on/off, or set a level
 *    (low/medium/high/max) for models that tune trace length (e.g. gpt-oss).
 *  - richer model listing via `/api/tags` (+ `/api/ps` for loaded state).
 *
 * Wire differences from the OpenAI shape (why this isn't a subclass):
 *  - sampling lives under a nested `options` object, and the token cap is
 *    `num_predict` (not `max_tokens`);
 *  - `messages[].images` is an array of RAW base64 strings (no `data:` prefix);
 *  - `format` is `"json"` or a RAW JSON-schema object (not OpenAI's
 *    `{ type, json_schema }` wrapper);
 *  - streaming is newline-delimited JSON (NDJSON), not SSE `data:` frames;
 *  - timings are reported in nanoseconds on the final chunk.
 *
 * Only the SERVER constructs and uses this. The browser never holds the API key
 * or talks to the model endpoint directly.
 */

export interface OllamaAdapterConfig {
  /** The Ollama server ROOT, e.g. `http://localhost:11434`. A trailing `/v1` or
   *  `/api` (a common paste from the OpenAI-compatible URL) is tolerated/stripped. */
  baseUrl: string;
  /** Optional bearer token (local Ollama needs none; cloud/proxies may). */
  apiKey: string;
  model: string;
  /** Maps to the request's `think` field; 'default' omits it. See {@link OllamaThink}. */
  think?: OllamaThink;
  /** Shared sampling knobs, mapped to Ollama's nested `options`. Each is sent only
   *  when set, so the server keeps its own default otherwise. */
  sampling?: {
    topP?: number | null;
    topK?: number | null;
    minP?: number | null;
    frequencyPenalty?: number | null;
    presencePenalty?: number | null;
    repeatPenalty?: number | null;
  };
}

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
}

/** Pull the raw base64 payload out of a `data:<mime>;base64,<data>` URL. Ollama's
 *  `images` field takes base64 only (no scheme/prefix), and has no remote-URL form,
 *  so non-data URLs are dropped — there's nothing valid to send for them. */
function base64FromDataUrl(url: string): string | undefined {
  const m = /^data:[^;,]+;base64,(.*)$/s.exec(url);
  return m ? m[1] : undefined;
}

/** Convert our OpenAI-style message into Ollama's `{ role, content, images }`. */
function toOllamaMessage(msg: ChatMessage): OllamaMessage {
  if (typeof msg.content === 'string') return { role: msg.role, content: msg.content };
  const texts: string[] = [];
  const images: string[] = [];
  for (const part of msg.content as ChatContentPart[]) {
    if (part.type === 'text') {
      texts.push(part.text);
    } else {
      const b64 = base64FromDataUrl(part.image_url.url);
      if (b64) images.push(b64);
    }
  }
  const out: OllamaMessage = { role: msg.role, content: texts.join('\n') };
  if (images.length) out.images = images;
  return out;
}

/** Translate the `ollamaThink` setting into the wire `think` value (or undefined to
 *  omit). 'default' → omit; off/on → boolean; a level → that string. */
function thinkValue(think: OllamaThink | undefined): boolean | string | undefined {
  switch (think) {
    case undefined:
    case 'default':
      return undefined;
    case 'off':
      return false;
    case 'on':
      return true;
    default:
      return think; // 'low' | 'medium' | 'high' | 'max'
  }
}

/** Map our ResponseFormat onto Ollama's `format` field: a raw JSON schema for
 *  json_schema, the literal `"json"` for json_object, nothing for text. */
function toOllamaFormat(rf: ChatRequest['responseFormat']): unknown {
  if (!rf || rf.type === 'text') return undefined;
  if (rf.type === 'json_object') return 'json';
  return rf.json_schema.schema; // json_schema → the schema object itself
}

const NS_PER_SEC = 1e9;

/** Shape of an Ollama chat response (the non-streaming body, and the final
 *  streamed chunk, carry the same fields). All optional — older builds omit some. */
interface OllamaChatPayload {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

function usageFrom(d: OllamaChatPayload): TokenUsage | undefined {
  const promptTokens = d.prompt_eval_count;
  const completionTokens = d.eval_count;
  if (promptTokens == null && completionTokens == null) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens != null && completionTokens != null ? promptTokens + completionTokens : undefined,
  };
}

/** Ollama reports nanosecond timings on the final chunk — turn them into the same
 *  GenerationStats (real decode tok/s, time-to-first-token) the bench consumes. */
function statsFrom(d: OllamaChatPayload): GenerationStats | undefined {
  const out: GenerationStats = {};
  if (typeof d.eval_count === 'number' && typeof d.eval_duration === 'number' && d.eval_duration > 0) {
    out.tokensPerSecond = d.eval_count / (d.eval_duration / NS_PER_SEC);
    out.generationTimeSec = d.eval_duration / NS_PER_SEC;
  }
  const ttftNs = (d.load_duration ?? 0) + (d.prompt_eval_duration ?? 0);
  if (ttftNs > 0) out.timeToFirstTokenSec = ttftNs / NS_PER_SEC;
  return out.tokensPerSecond != null || out.timeToFirstTokenSec != null || out.generationTimeSec != null
    ? out
    : undefined;
}

export class OllamaAdapter implements ChatAdapter {
  readonly name = 'ollama';

  constructor(private readonly cfg: OllamaAdapterConfig) {}

  /** The server root, with a trailing `/v1` or `/api` segment stripped so a URL
   *  copied from the OpenAI-compatible config still resolves correctly. */
  private root(): string {
    return this.cfg.baseUrl.replace(/\/+$/, '').replace(/\/(v1|api)$/i, '');
  }

  private url(path: string): string {
    return joinUrl(this.root(), path);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) h.Authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  private options(req: ChatRequest): Record<string, unknown> {
    const o: Record<string, unknown> = {
      temperature: req.temperature ?? 0.8,
      num_predict: req.maxTokens ?? 1024,
    };
    const s = this.cfg.sampling;
    if (s) {
      if (s.topP != null) o.top_p = s.topP;
      if (s.topK != null) o.top_k = s.topK;
      if (s.minP != null) o.min_p = s.minP;
      if (s.frequencyPenalty != null) o.frequency_penalty = s.frequencyPenalty;
      if (s.presencePenalty != null) o.presence_penalty = s.presencePenalty;
      if (s.repeatPenalty != null) o.repeat_penalty = s.repeatPenalty;
    }
    return o;
  }

  private body(req: ChatRequest, stream: boolean): string {
    const payload: Record<string, unknown> = {
      model: this.cfg.model,
      messages: req.messages.map(toOllamaMessage),
      stream,
      options: this.options(req),
    };
    const format = toOllamaFormat(req.responseFormat);
    if (format !== undefined) payload.format = format;
    const think = thinkValue(this.cfg.think);
    if (think !== undefined) payload.think = think;
    return JSON.stringify(payload);
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const res = await llmFetch(
      this.url('api/chat'),
      { method: 'POST', headers: this.headers(), body: this.body(req, false), signal },
      this.cfg.baseUrl,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM endpoint returned ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as OllamaChatPayload;
    const content = data.message?.content ?? '';
    // When the model streamed everything into the reasoning trace (empty content),
    // surface the thinking so the reply isn't reported as empty.
    const thinking = data.message?.thinking ?? '';
    return {
      content: content.trim() ? content : thinking,
      finishReason: data.done_reason,
      usage: usageFrom(data),
      stats: statsFrom(data),
    };
  }

  async streamChat(
    req: ChatRequest,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const res = await llmFetch(
      this.url('api/chat'),
      { method: 'POST', headers: this.headers(), body: this.body(req, true), signal },
      this.cfg.baseUrl,
    );
    if (!res.ok || !res.body) {
      const text = res.body ? await res.text().catch(() => '') : '';
      throw new Error(`LLM endpoint returned ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let contentChars = 0;
    let thinking = ''; // captured from `message.thinking` deltas (not streamed out)
    let finishReason: string | undefined;
    let final: OllamaChatPayload | undefined; // the `done: true` chunk (usage/stats)

    // Ollama streams NDJSON: one complete JSON object per line.
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const json = JSON.parse(trimmed) as OllamaChatPayload;
        const delta = json.message?.content;
        if (delta) {
          content += delta;
          contentChars += delta.length;
          onDelta(delta);
        }
        const tDelta = json.message?.thinking;
        if (typeof tDelta === 'string') thinking += tDelta;
        if (json.done_reason) finishReason = json.done_reason;
        if (json.done) final = json;
      } catch {
        // Ignore a partial/non-JSON line (e.g. a split chunk we'll see completed next).
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
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);

    // Reasoning-only fallback: nothing landed in content, so surface the trace.
    if (contentChars === 0 && thinking) {
      content = thinking;
      onDelta(thinking);
    }

    return {
      content,
      finishReason,
      usage: final ? usageFrom(final) : undefined,
      stats: final ? statsFrom(final) : undefined,
    };
  }

  /** Names of models currently loaded into memory, via `/api/ps`. Best-effort: a
   *  failure (older server, transient error) just means no entries are flagged. */
  private async loadedNames(signal?: AbortSignal): Promise<Set<string> | undefined> {
    try {
      const res = await llmFetch(this.url('api/ps'), { method: 'GET', headers: this.headers(), signal }, this.cfg.baseUrl);
      if (!res.ok) return undefined;
      const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      const names = (data.models ?? [])
        .map((m) => m.name ?? m.model)
        .filter((n): n is string => typeof n === 'string');
      return new Set(names);
    } catch {
      return undefined;
    }
  }

  async listModels(signal?: AbortSignal): Promise<LlmModelInfo[]> {
    const res = await llmFetch(
      this.url('api/tags'),
      { method: 'GET', headers: this.headers(), signal },
      this.cfg.baseUrl,
    );
    if (!res.ok) {
      throw new Error(`Model listing returned ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as {
      models?: Array<{
        name?: string;
        model?: string;
        details?: { family?: string; quantization_level?: string };
      }>;
    };
    const loaded = await this.loadedNames(signal);
    return (data.models ?? []).flatMap((m) => {
      const id = m.name ?? m.model;
      if (typeof id !== 'string') return [];
      return [
        {
          id,
          loaded: loaded ? loaded.has(id) : undefined,
          quantization:
            typeof m.details?.quantization_level === 'string' ? m.details.quantization_level : undefined,
          type: typeof m.details?.family === 'string' ? m.details.family : undefined,
        },
      ];
    });
  }
}
