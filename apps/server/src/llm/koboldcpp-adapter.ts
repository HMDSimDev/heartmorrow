import type { KoboldTemplate, LlmModelInfo } from '@dsim/shared';
import { llmFetch } from './errors';
import { joinUrl } from './openai-adapter';
import type { ChatAdapter, ChatContentPart, ChatMessage, ChatRequest, ChatResult } from './types';

/**
 * Adapter for KoboldCpp's NATIVE API (https://lite.koboldai.net/koboldcpp_api),
 * `POST /api/v1/generate` with SSE streaming at `/api/extra/generate/stream`.
 *
 * Unlike every other adapter here, KoboldCpp's native API is a raw TEXT-COMPLETION
 * endpoint: it takes a single `prompt` string and returns `results[0].text` — it has
 * no concept of chat roles. So this adapter RENDERS the role-tagged {@link ChatMessage}
 * list into one prompt using a configurable instruction template (see
 * {@link KoboldTemplate}), the way KoboldAI Lite / SillyTavern do, and emits matching
 * stop sequences so the model can't run on into a hallucinated next turn.
 *
 * Why bother (vs KoboldCpp's OpenAI-compatible `/v1` endpoint): the native API is what
 * the Kobold ecosystem targets, it exposes the full sampler set (rep_pen, sampler_order,
 * etc.), and it accepts a GBNF `grammar` — which we use to constrain structured output
 * to valid JSON.
 *
 * Only the SERVER constructs and uses this. The browser never holds the API key or
 * talks to the model endpoint directly.
 */

export interface KoboldcppAdapterConfig {
  /** The KoboldCpp server ROOT, e.g. `http://localhost:5001`. A trailing `/v1` or
   *  `/api` is tolerated/stripped. */
  baseUrl: string;
  /** Optional API key (KoboldCpp `--password`), sent as a bearer token when set. */
  apiKey: string;
  /** Cosmetic only — KoboldCpp serves one loaded model and ignores this. */
  model: string;
  /** Instruction template used to render messages into the prompt. */
  template?: KoboldTemplate;
  sampling?: {
    topP?: number | null;
    topK?: number | null;
    minP?: number | null;
    frequencyPenalty?: number | null;
    presencePenalty?: number | null;
    repeatPenalty?: number | null;
  };
}

/** KoboldCpp keeps the LAST `max_context_length - max_length` prompt tokens and
 *  clamps this to the model's loaded context size, so a generous value just means
 *  "use the whole window" without forcing needless left-truncation. */
const MAX_CONTEXT = 32_768;

/** Canonical llama.cpp "any valid JSON object" GBNF grammar. Used to constrain
 *  structured output to well-formed JSON (the schema's SHAPE still comes from the
 *  prompt that the structured-output layer assembles). */
const JSON_GBNF = `root   ::= object
value  ::= object | array | string | number | ("true" | "false" | "null") ws
object ::= "{" ws ( string ":" ws value ("," ws string ":" ws value)* )? "}" ws
array  ::= "[" ws ( value ("," ws value)* )? "]" ws
string ::= "\\"" ( [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\bfnrt/] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F]) )* "\\"" ws
number ::= ("-"? ([0-9] | [1-9] [0-9]*)) ("." [0-9]+)? ([eE] [-+]? [0-9]+)? ws
ws ::= ([ \\t\\n] ws)?`;

/** Flatten one message's content into text + any base64 image payloads. KoboldCpp's
 *  `images` field takes raw base64 (no `data:` prefix) and has no remote-URL form,
 *  so non-data URLs are dropped. */
function splitContent(content: ChatMessage['content']): { text: string; images: string[] } {
  if (typeof content === 'string') return { text: content, images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  for (const part of content as ChatContentPart[]) {
    if (part.type === 'text') {
      texts.push(part.text);
    } else {
      const m = /^data:[^;,]+;base64,(.*)$/s.exec(part.image_url.url);
      if (m) images.push(m[1]!);
    }
  }
  return { text: texts.join('\n'), images };
}

interface Turn {
  role: ChatMessage['role'];
  text: string;
  images: string[];
}

/** Per-template role wrappers + the trailing cue that elicits an assistant turn, plus
 *  the stop sequences that bound the reply. (`mistral` is handled separately.) */
type Wrap = {
  sys: (s: string) => string;
  user: (s: string) => string;
  asst: (s: string) => string;
  cue: string;
  stops: string[];
};

const WRAPS: Record<Exclude<KoboldTemplate, 'mistral'>, Wrap> = {
  alpaca: {
    sys: (s) => `${s}\n\n`,
    user: (s) => `### Instruction:\n${s}\n\n`,
    asst: (s) => `### Response:\n${s}\n\n`,
    cue: '### Response:\n',
    stops: ['### Instruction:'],
  },
  chatml: {
    sys: (s) => `<|im_start|>system\n${s}<|im_end|>\n`,
    user: (s) => `<|im_start|>user\n${s}<|im_end|>\n`,
    asst: (s) => `<|im_start|>assistant\n${s}<|im_end|>\n`,
    cue: '<|im_start|>assistant\n',
    stops: ['<|im_end|>', '<|im_start|>'],
  },
  llama3: {
    sys: (s) => `<|start_header_id|>system<|end_header_id|>\n\n${s}<|eot_id|>`,
    user: (s) => `<|start_header_id|>user<|end_header_id|>\n\n${s}<|eot_id|>`,
    asst: (s) => `<|start_header_id|>assistant<|end_header_id|>\n\n${s}<|eot_id|>`,
    cue: '<|start_header_id|>assistant<|end_header_id|>\n\n',
    stops: ['<|eot_id|>', '<|start_header_id|>'],
  },
  vicuna: {
    sys: (s) => `${s}\n\n`,
    user: (s) => `USER: ${s}\n`,
    asst: (s) => `ASSISTANT: ${s}\n`,
    cue: 'ASSISTANT: ',
    stops: ['USER:'],
  },
  plain: {
    sys: (s) => `${s}\n\n`,
    user: (s) => `${s}\n\n`,
    asst: (s) => `${s}\n\n`,
    cue: '',
    stops: [],
  },
};

/** Mistral `[INST] … [/INST]` rendering: no system role, so system text is folded into
 *  the first instruction; assistant turns are closed with `</s>`. */
function renderMistral(turns: Turn[]): { prompt: string; stops: string[] } {
  const sys = turns
    .filter((t) => t.role === 'system')
    .map((t) => t.text)
    .filter(Boolean)
    .join('\n\n');
  let prompt = '';
  let pendingSys = sys;
  for (const t of turns) {
    if (t.role === 'system') continue;
    if (t.role === 'user') {
      const body = pendingSys ? `${pendingSys}\n\n${t.text}` : t.text;
      prompt += `[INST] ${body} [/INST]`;
      pendingSys = '';
    } else {
      prompt += ` ${t.text}</s>`;
    }
  }
  // No user turn ever consumed the system text (degenerate input) — emit it alone.
  if (pendingSys) prompt = `[INST] ${pendingSys} [/INST]${prompt}`;
  return { prompt, stops: ['[INST]'] };
}

/** Render the message list into a prompt + image list + stop sequences for the
 *  chosen template. Exported for unit testing. */
export function buildKoboldPrompt(
  template: KoboldTemplate,
  messages: ChatMessage[],
): { prompt: string; images: string[]; stops: string[] } {
  const turns: Turn[] = messages.map((m) => ({ role: m.role, ...splitContent(m.content) }));
  const present = turns.filter((t) => t.text.length > 0 || t.images.length > 0);
  const images = present.flatMap((t) => t.images);

  if (template === 'mistral') {
    return { ...renderMistral(present), images };
  }
  const w = WRAPS[template];
  let prompt = '';
  for (const t of present) {
    if (t.role === 'system') prompt += w.sys(t.text);
    else if (t.role === 'user') prompt += w.user(t.text);
    else prompt += w.asst(t.text);
  }
  // Append the assistant cue unless the conversation already ends on an assistant turn.
  if (present.at(-1)?.role !== 'assistant') prompt += w.cue;
  return { prompt, images, stops: w.stops };
}

export class KoboldcppAdapter implements ChatAdapter {
  readonly name = 'koboldcpp';

  constructor(private readonly cfg: KoboldcppAdapterConfig) {}

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

  private body(req: ChatRequest): string {
    const template = this.cfg.template ?? 'alpaca';
    const { prompt, images, stops } = buildKoboldPrompt(template, req.messages);
    const payload: Record<string, unknown> = {
      prompt,
      max_length: req.maxTokens ?? 1024,
      max_context_length: MAX_CONTEXT,
      temperature: req.temperature ?? 0.8,
      trim_stop: true,
      quiet: true,
    };
    if (stops.length) payload.stop_sequence = stops;
    if (images.length) payload.images = images;
    const s = this.cfg.sampling;
    if (s) {
      if (s.topP != null) payload.top_p = s.topP;
      if (s.topK != null) payload.top_k = s.topK;
      if (s.minP != null) payload.min_p = s.minP;
      // KoboldCpp's repetition control is `rep_pen` (same concept as repeat_penalty);
      // it also supports `presence_penalty`. It has no `frequency_penalty` field.
      if (s.repeatPenalty != null) payload.rep_pen = s.repeatPenalty;
      if (s.presencePenalty != null) payload.presence_penalty = s.presencePenalty;
    }
    // Structured output: constrain decoding to valid JSON via GBNF. The schema's shape
    // is described in the prompt by the structured-output layer; this guarantees the
    // output at least PARSES, so strict-parse + Zod validation (+ retry) can do the rest.
    if (req.responseFormat && req.responseFormat.type !== 'text') {
      payload.grammar = JSON_GBNF;
    }
    return JSON.stringify(payload);
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const res = await llmFetch(
      this.url('api/v1/generate'),
      { method: 'POST', headers: this.headers(), body: this.body(req), signal },
      this.cfg.baseUrl,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM endpoint returned ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as { results?: Array<{ text?: string; finish_reason?: string }> };
    const first = data.results?.[0];
    // KoboldCpp's native generate response reports neither token usage nor timings,
    // so usage/stats are left undefined (the bench then estimates from char counts).
    return { content: first?.text ?? '', finishReason: first?.finish_reason };
  }

  async streamChat(
    req: ChatRequest,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const res = await llmFetch(
      this.url('api/extra/generate/stream'),
      {
        method: 'POST',
        headers: { ...this.headers(), Accept: 'text/event-stream' },
        body: this.body(req),
        signal,
      },
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

    // KoboldCpp SSE: `event: message` / `data: {"token": "…", "finish_reason": …}`
    // frames separated by blank lines. We key off the `data:` JSON and ignore the
    // `event:` line (matching how the OpenAI/Anthropic streamers are tolerant).
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload) as { token?: string; finish_reason?: string | null };
        if (json.token) {
          content += json.token;
          onDelta(json.token);
        }
        if (json.finish_reason) finishReason = json.finish_reason;
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

    return { content, finishReason };
  }

  /** Best-effort context length the server reports via `/api/extra/true_max_context_length`. */
  private async contextLength(signal?: AbortSignal): Promise<number | undefined> {
    try {
      const res = await llmFetch(
        this.url('api/extra/true_max_context_length'),
        { method: 'GET', headers: this.headers(), signal },
        this.cfg.baseUrl,
      );
      if (!res.ok) return undefined;
      const data = (await res.json()) as { value?: number };
      return typeof data.value === 'number' ? data.value : undefined;
    } catch {
      return undefined;
    }
  }

  /** KoboldCpp serves a single loaded model. `/api/v1/model` reports it as
   *  `"koboldcpp/<name>"`; we strip the backend prefix and enrich with context length. */
  async listModels(signal?: AbortSignal): Promise<LlmModelInfo[]> {
    const res = await llmFetch(
      this.url('api/v1/model'),
      { method: 'GET', headers: this.headers(), signal },
      this.cfg.baseUrl,
    );
    if (!res.ok) {
      throw new Error(`Model listing returned ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { result?: string };
    const raw = typeof data.result === 'string' ? data.result : '';
    if (!raw) return [];
    const contextLength = await this.contextLength(signal);
    return [{ id: raw.replace(/^koboldcpp\//, ''), loaded: true, contextLength }];
  }
}
