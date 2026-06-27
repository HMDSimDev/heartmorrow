import type { LlmModelInfo } from '@dsim/shared';
import { llmFetch } from './errors';
import { joinUrl } from './openai-adapter';
import type {
  ChatAdapter,
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatResult,
} from './types';

/**
 * Adapter for any Anthropic-Messages-compatible endpoint — api.anthropic.com,
 * a self-hosted proxy/gateway (LiteLLM, Bedrock/Vertex shims), or a local server
 * that speaks the `/v1/messages` shape. It is the Anthropic-side mirror of
 * {@link OpenAiCompatibleAdapter}: a dumb transport that translates our
 * OpenAI-style {@link ChatRequest} into the Anthropic wire format and back.
 *
 * Only the SERVER constructs and uses this. The browser never holds the API key
 * or talks to the model endpoint directly.
 *
 * Deliberately raw `fetch` (not the official SDK) to stay symmetric with the
 * OpenAI-compatible adapter and to send exactly what it is given — so it works
 * against arbitrary compatible endpoints regardless of a specific model's
 * parameter quirks. (Note: the newest first-party Claude models reject
 * `temperature`/`top_p`; point those at a compatible gateway, or leave the
 * advanced-sampling fields and temperature at defaults, if you hit a 400.)
 */

export interface AnthropicAdapterConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** `anthropic-version` header value (e.g. "2023-06-01"). */
  anthropicVersion: string;
  /** Subset of the shared sampling knobs Anthropic understands. Others (min_p,
   * frequency/presence/repeat penalty) have no Messages-API equivalent and are
   * intentionally dropped. */
  sampling?: {
    topP?: number | null;
    topK?: number | null;
  };
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: AnthropicImageSource };
type AnthropicImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

/** Map a `data:<mime>;base64,<data>` or remote URL into an Anthropic image source. */
function toImageSource(part: Extract<ChatContentPart, { type: 'image_url' }>): AnthropicImageSource {
  const url = part.image_url.url;
  const dataMatch = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (dataMatch) {
    return { type: 'base64', media_type: dataMatch[1]!, data: dataMatch[2]! };
  }
  return { type: 'url', url };
}

function toBlocks(content: ChatMessage['content']): AnthropicContentBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  return content.map((part) =>
    part.type === 'text'
      ? ({ type: 'text', text: part.text } as const)
      : ({ type: 'image', source: toImageSource(part) } as const),
  );
}

/** Flatten any text out of a system message's content (system is a top-level
 * string in the Anthropic API, never a role inside `messages`). */
function systemText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ChatContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n');
}

/**
 * Split our flat message list into Anthropic's (system, messages) pair. System
 * messages are pulled out and concatenated; the rest are converted to content
 * blocks with consecutive same-role turns merged (the structured-output caller
 * appends several `user` messages in a row, which the Messages API rejects
 * unless they're combined into one turn).
 */
function buildMessages(messages: ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = systemText(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    const blocks = toBlocks(msg.content);
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === msg.role) {
      last.content.push(...blocks);
    } else {
      out.push({ role: msg.role, content: blocks });
    }
  }
  return { system: systemParts.join('\n\n'), messages: out };
}

export class AnthropicAdapter implements ChatAdapter {
  readonly name = 'anthropic';

  constructor(private readonly cfg: AnthropicAdapterConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': this.cfg.anthropicVersion,
    };
    if (this.cfg.apiKey) h['x-api-key'] = this.cfg.apiKey;
    return h;
  }

  private body(req: ChatRequest, stream: boolean): string {
    const { system, messages } = buildMessages(req.messages);
    const payload: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      max_tokens: req.maxTokens ?? 1024,
      stream,
    };
    if (system) payload.system = system;
    // Anthropic's temperature range is [0, 1]; our shared setting is [0, 2].
    if (req.temperature != null) payload.temperature = Math.min(1, Math.max(0, req.temperature));
    const s = this.cfg.sampling;
    if (s) {
      if (s.topP != null) payload.top_p = s.topP;
      if (s.topK != null) payload.top_k = s.topK;
    }
    // Structured output: only json_schema maps cleanly onto Anthropic's
    // output_config.format. json_object / text have no native equivalent — the
    // structured layer drives those purely via prompt + strict parse instead.
    if (req.responseFormat?.type === 'json_schema') {
      payload.output_config = {
        format: { type: 'json_schema', schema: req.responseFormat.json_schema.schema },
      };
    }
    return JSON.stringify(payload);
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const res = await llmFetch(
      joinUrl(this.cfg.baseUrl, 'messages'),
      { method: 'POST', headers: this.headers(), body: this.body(req, false), signal },
      this.cfg.baseUrl,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM endpoint returned ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    const usage = data.usage;
    return {
      content: text,
      finishReason: data.stop_reason,
      usage: usage
        ? {
            promptTokens: usage.input_tokens,
            completionTokens: usage.output_tokens,
            totalTokens:
              usage.input_tokens != null && usage.output_tokens != null
                ? usage.input_tokens + usage.output_tokens
                : undefined,
          }
        : undefined,
    };
  }

  async streamChat(
    req: ChatRequest,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const res = await llmFetch(
      joinUrl(this.cfg.baseUrl, 'messages'),
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
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    // Anthropic SSE: pairs of `event: <name>` / `data: {json}` lines. We key off
    // the JSON `type` field and ignore the `event:` line, so plain `data:`-only
    // streams (some proxies) work too.
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload) as {
          type?: string;
          delta?: { type?: string; text?: string; stop_reason?: string };
          message?: { usage?: { input_tokens?: number } };
          usage?: { output_tokens?: number };
        };
        if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
          const text = json.delta.text ?? '';
          if (text) {
            content += text;
            onDelta(text);
          }
        } else if (json.type === 'message_start') {
          promptTokens = json.message?.usage?.input_tokens;
        } else if (json.type === 'message_delta') {
          if (json.delta?.stop_reason) finishReason = json.delta.stop_reason;
          if (json.usage?.output_tokens != null) completionTokens = json.usage.output_tokens;
        }
      } catch {
        // Ignore keepalive / non-JSON lines.
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

    return {
      content,
      finishReason,
      usage:
        promptTokens != null || completionTokens != null
          ? {
              promptTokens,
              completionTokens,
              totalTokens:
                promptTokens != null && completionTokens != null
                  ? promptTokens + completionTokens
                  : undefined,
            }
          : undefined,
    };
  }

  async listModels(signal?: AbortSignal): Promise<LlmModelInfo[]> {
    const res = await llmFetch(
      joinUrl(this.cfg.baseUrl, 'models'),
      { method: 'GET', headers: this.headers(), signal },
      this.cfg.baseUrl,
    );
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
