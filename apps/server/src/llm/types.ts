/** LLM adapter contract. Adapters are dumb transports: they send exactly what
 * they are given and return raw text. Structured-output policy, retries, and
 * validation live in `structured.ts` — never in the adapter. */

import type { LlmModelInfo } from '@dsim/shared';
export type { LlmModelInfo };

/** A plain-text part of a multimodal message. */
export interface ChatTextPart {
  type: 'text';
  text: string;
}

/** An image part of a multimodal message (OpenAI-compatible `image_url` shape).
 * `url` may be a remote URL or a `data:` URL (base64). Vision-capable models
 * read these; text-only models ignore/reject them. */
export interface ChatImagePart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export type ChatContentPart = ChatTextPart | ChatImagePart;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** Plain text, OR an array of content parts for multimodal (vision) input.
   * The adapter serializes this straight through, so the array form requires a
   * vision-capable model + an endpoint that accepts the parts shape. */
  content: string | ChatContentPart[];
}

export type ResponseFormat =
  | { type: 'json_schema'; json_schema: { name: string; schema: unknown; strict?: boolean } }
  | { type: 'json_object' }
  | { type: 'text' };

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: ResponseFormat;
}

/** Token accounting reported by the endpoint (OpenAI-compatible `usage`).
 * camelCased from the wire's snake_case. Fields are optional because not every
 * local server reports them. */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** Per-response generation stats some endpoints report (notably LM Studio's
 * native API). All optional — absent on servers that don't measure them. */
export interface GenerationStats {
  tokensPerSecond?: number;
  timeToFirstTokenSec?: number;
  generationTimeSec?: number;
}

export interface ChatResult {
  content: string;
  finishReason?: string;
  /** The endpoint's `usage` block, when it reports one. `promptTokens` is the
   * exact prefill size of the request — used by the prompt-size estimator. */
  usage?: TokenUsage;
  /** Generation telemetry (tokens/sec, time-to-first-token), when reported. */
  stats?: GenerationStats;
}

export interface ChatAdapter {
  readonly name: string;
  /** Single-shot completion. */
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult>;
  /** Streamed completion. Invokes `onDelta` for each incremental token chunk. */
  streamChat(
    req: ChatRequest,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult>;
  /** List models advertised by the endpoint, if supported. Returns at least an
   * `id` per model; LM Studio's native adapter enriches each with loaded state,
   * context length, etc. */
  listModels(signal?: AbortSignal): Promise<LlmModelInfo[]>;
}
