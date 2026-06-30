import { z } from 'zod';

/**
 * LLM provider settings. These configure how the SERVER talks to an
 * OpenAI-API-compatible endpoint. The browser never reads or uses these to
 * call the model directly — it only edits them via the server's settings API.
 */

export const StructuredOutputModeSchema = z.enum([
  'json_schema', // response_format: { type: 'json_schema', json_schema: {...} }
  'json_object', // response_format: { type: 'json_object' } + schema described in prompt
  'prompt_only', // no response_format; schema described in prompt only
]);
export type StructuredOutputMode = z.infer<typeof StructuredOutputModeSchema>;

export const EndpointModeSchema = z.enum([
  'chat_completions', // POST {baseUrl}/chat/completions — OpenAI-compatible (LM Studio /v1, Ollama, llama.cpp, vLLM)
  'responses', // POST {baseUrl}/responses  (reserved — adapter interface left open)
  'anthropic', // POST {baseUrl}/messages — Anthropic Messages API shape (api.anthropic.com or any compatible proxy/gateway)
  'lmstudio', // POST {baseUrl}/chat/completions on LM Studio's NATIVE REST API (baseUrl ending /api/v0) — richer model metadata + per-response stats
  'ollama', // POST {baseUrl}/api/chat on Ollama's NATIVE API (baseUrl = server root) — thinking toggle + reasoning level, /api/tags listing
  'koboldcpp', // POST {baseUrl}/api/v1/generate on KoboldCpp's NATIVE API (baseUrl = server root) — a text-completion API; messages are rendered with a chat template
]);
export type EndpointMode = z.infer<typeof EndpointModeSchema>;

/**
 * Ollama's `think` request control (endpointMode 'ollama' only). Maps to the
 * native API's `think` field, which toggles a model's reasoning trace and — for
 * models that expose trace LEVELS (e.g. gpt-oss) — tunes its depth:
 *  - `default`  → omit the field entirely (the model's own behavior; the only
 *                 safe choice for models that don't support thinking, which
 *                 otherwise reject the parameter)
 *  - `off`/`on` → `think: false` / `think: true`
 *  - `low`…`max`→ the level string (ignored as a boolean by level-only models)
 * Ignored by every other endpoint mode.
 */
export const OllamaThinkSchema = z.enum(['default', 'off', 'on', 'low', 'medium', 'high', 'max']);
export type OllamaThink = z.infer<typeof OllamaThinkSchema>;

/**
 * Instruction template used to render chat messages into a single prompt for the
 * KoboldCpp native API (endpointMode 'koboldcpp' only). KoboldCpp's `/api/v1/generate`
 * is a raw TEXT-COMPLETION endpoint — it has no notion of roles — so the front end
 * owns the prompt format. Pick the one matching your loaded model's training format:
 *  - `alpaca`  → `### Instruction:` / `### Response:` (broadly compatible default)
 *  - `chatml`  → `<|im_start|>role … <|im_end|>` (Qwen, many finetunes)
 *  - `llama3`  → `<|start_header_id|>role<|end_header_id|>` (Llama 3/3.x Instruct)
 *  - `vicuna`  → `USER:` / `ASSISTANT:`
 *  - `mistral` → `[INST] … [/INST]` (system folded into the first instruction)
 *  - `plain`   → no role markers, messages joined as-is (base models / custom)
 * Ignored by every other endpoint mode.
 */
export const KoboldTemplateSchema = z.enum(['alpaca', 'chatml', 'llama3', 'vicuna', 'mistral', 'plain']);
export type KoboldTemplate = z.infer<typeof KoboldTemplateSchema>;

/**
 * One model advertised by the endpoint's listing. `id` is always present; the
 * remaining fields are best-effort enrichment only LM Studio's native
 * `/api/v0/models` provides (OpenAI-compatible and Anthropic listings return
 * just the id). The Settings model picker annotates entries with whatever is set.
 */
export const LlmModelInfoSchema = z.object({
  id: z.string(),
  /** LM Studio: is the model currently loaded into memory (vs merely downloaded)? */
  loaded: z.boolean().optional(),
  /** Max context window in tokens, when the endpoint reports it. */
  contextLength: z.number().int().positive().optional(),
  /** Quantization label (e.g. "Q4_K_M"), when reported. */
  quantization: z.string().optional(),
  /** Model family/role (e.g. "llm", "vlm", "embeddings"), when reported. */
  type: z.string().optional(),
});
export type LlmModelInfo = z.infer<typeof LlmModelInfoSchema>;

/**
 * The fields that define HOW to reach one model on one endpoint — the wire
 * protocol, the credentials, the model name, and every generation/decoding knob.
 * Factored out so the base settings AND each per-role override (see
 * {@link LlmRoleConnectionSchema}) share a single source of truth: a role override
 * is just one of these connections plus an `enabled` flag. The GAME-level toggles
 * (NSFW / rapport cadence / tragic outcomes) live on {@link LlmSettingsSchema} only
 * — they are global, never per-role.
 */
const llmConnectionShape = {
  baseUrl: z
    .string()
    .url('Base URL must be a valid URL, e.g. http://localhost:1234/v1')
    .default('http://localhost:1234/v1'),
  apiKey: z.string().default(''),
  model: z.string().min(1, 'Model name is required').default('local-model'),
  temperature: z.number().min(0).max(2).default(0.8),
  maxTokens: z.number().int().positive().max(32_000).default(2048),
  /**
   * Advanced sampling knobs. Each is nullable and defaults to `null`, which means
   * "leave it out of the request" — so the endpoint applies its own default and
   * strict OpenAI-proper servers (which reject `top_k`/`min_p`/`repeat_penalty`)
   * keep working unless the user opts in. When set, the server sends the matching
   * OpenAI-compatible field (`top_p`, `top_k`, `min_p`, `frequency_penalty`,
   * `presence_penalty`, `repeat_penalty`). Support varies by backend: top_k/min_p/
   * repeat_penalty are honored by llama.cpp / LM Studio / Ollama / vLLM but ignored
   * (or rejected) by the official OpenAI API.
   */
  topP: z.number().min(0).max(1).nullable().default(null),
  topK: z.number().int().min(0).max(500).nullable().default(null),
  minP: z.number().min(0).max(1).nullable().default(null),
  frequencyPenalty: z.number().min(-2).max(2).nullable().default(null),
  presencePenalty: z.number().min(-2).max(2).nullable().default(null),
  repeatPenalty: z.number().min(0).max(2).nullable().default(null),
  structuredMode: StructuredOutputModeSchema.default('json_schema'),
  /**
   * When true AND structuredMode is 'json_schema', skip dumping the JSON schema
   * text into the prompt. In json_schema mode the server's grammar ALREADY enforces
   * the shape, so the in-prompt copy is redundant token bloat — skipping it shrinks
   * the prompt (faster prefill) without weakening conformance. NO effect in
   * json_object/prompt_only modes (there the schema text is the only thing that
   * describes the required shape, so it is always kept). Off by default. Exposed as
   * a toggle so it can be A/B tested against generation latency.
   */
  omitSchemaInPrompt: z.boolean().default(false),
  endpointMode: EndpointModeSchema.default('chat_completions'),
  /**
   * `anthropic-version` request header, only used when `endpointMode` is
   * 'anthropic'. The Messages API requires it; bump this if you target a newer
   * API revision. Ignored by every other endpoint mode.
   */
  anthropicVersion: z.string().default('2023-06-01'),
  /**
   * Ollama reasoning control, only used when `endpointMode` is 'ollama' (see
   * {@link OllamaThinkSchema}). Defaults to 'default' (the field is omitted), so an
   * existing install and every non-Ollama endpoint behave exactly as before.
   */
  ollamaThink: OllamaThinkSchema.default('default'),
  /**
   * Chat-template preset for the KoboldCpp native API, only used when `endpointMode`
   * is 'koboldcpp' (see {@link KoboldTemplateSchema}). Defaults to 'alpaca'. Ignored
   * by every other endpoint mode, so an existing install is unaffected.
   */
  koboldTemplate: KoboldTemplateSchema.default('alpaca'),
  maxRetries: z.number().int().min(0).max(10).default(3),
} as const;

/** The connection-shape keys, used to project a role override onto base settings. */
const LLM_CONNECTION_KEYS = Object.keys(llmConnectionShape) as (keyof typeof llmConnectionShape)[];

/**
 * A per-role connection override. Same full set of connection/generation params as
 * the base config, plus `enabled`: when false (the default) the role inherits the
 * base config entirely; when true, ALL of these fields replace the base ones for
 * that role's calls. This is what lets, say, the evaluator run on a small local
 * model via LM Studio while prose runs on Anthropic — fully independent endpoints,
 * credentials, models, and decoding params.
 */
export const LlmRoleConnectionSchema = z.object({
  enabled: z.boolean().default(false),
  ...llmConnectionShape,
});
export type LlmRoleConnection = z.infer<typeof LlmRoleConnectionSchema>;

/**
 * Optional per-role endpoint/model overrides. A "role" is the JOB a model call is
 * doing: `evaluator` (the relationship judges — session eval, per-turn / text
 * judge, DTR, gift, walkout, breakup, farewell) and `vision` (image-based
 * generation). `prose` (everything that writes player-facing text) always uses the
 * base config and so has no override slot. Both default to disabled, so an existing
 * install behaves exactly as before until a role is explicitly turned on.
 */
export const LlmRoleOverridesSchema = z
  .object({
    evaluator: LlmRoleConnectionSchema.default({}),
    vision: LlmRoleConnectionSchema.default({}),
  })
  .default({});
export type LlmRoleOverrides = z.infer<typeof LlmRoleOverridesSchema>;

/** The roles a model call can take. `prose` is the default (base config). */
export type LlmRole = 'prose' | 'evaluator' | 'vision';

/**
 * Image-generation endpoint settings. Independent of the LLM connection above:
 * this points at an AUTOMATIC1111 / Stable Diffusion WebUI compatible server and
 * is called via its `POST {baseUrl}/sdapi/v1/txt2img` API (the same shape vLLM-style
 * SD forks and many extensions expose). The fields below mirror that payload's
 * common knobs, so a saved config can be dropped straight into a txt2img request.
 * `enabled` defaults false, so an install without an SD server is unaffected.
 */
export const ImageGenSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z
      .string()
      .url('Base URL must be a valid URL, e.g. http://127.0.0.1:7861')
      .default('http://127.0.0.1:7861'),
    negativePrompt: z.string().default('blurry, low quality, distorted'),
    steps: z.number().int().min(1).max(150).default(20),
    width: z.number().int().min(64).max(2048).default(1024),
    height: z.number().int().min(64).max(2048).default(1024),
    samplerName: z.string().min(1).default('Euler'),
    cfgScale: z.number().min(1).max(30).default(7),
  })
  .default({});
export type ImageGenSettings = z.infer<typeof ImageGenSettingsSchema>;

export const LlmSettingsSchema = z.object({
  ...llmConnectionShape,
  /**
   * Optional vision-capable model used for image-based generation (e.g. building a
   * character template from a portrait) when no full `vision` role override is
   * enabled. Reuses the base baseUrl + apiKey + endpoint. When blank, image calls
   * fall back to `model` — so a single multimodal model needs no extra config. For
   * a vision model on a DIFFERENT endpoint, enable `roleOverrides.vision` instead.
   */
  visionModel: z.string().default(''),
  /**
   * When true, the SERVER permits mature/explicit content in date dialogue —
   * but ONLY once the relationship is advanced enough (see `intimacyAllowed`);
   * propositioning a stranger/acquaintance still triggers a walkout. OFF by
   * default; the UI gates enabling behind an age + content acknowledgment.
   */
  nsfwEnabled: z.boolean().default(false),
  /**
   * Live date dynamics cadence: how often the per-turn rapport judge runs during
   * a date. 'every' judges each message (most responsive, an extra small model
   * call per turn); 'periodic' judges less often to keep replies snappy.
   */
  rapportCadence: z.enum(['every', 'periodic']).default('every'),
  /**
   * Opt-in to dark tragic outcomes (a character's self-harm as the consequence of
   * sustained, severe mistreatment). Requires `nsfwEnabled` to even be toggleable.
   * OFF by default; when off, the entire mechanic has zero footprint. Gated in the
   * UI behind an explicit content-warning acknowledgment with crisis resources.
   */
  tragicOutcomesEnabled: z.boolean().default(false),
  /** Optional per-role endpoint/model overrides (evaluator, vision). See
   *  {@link LlmRoleOverridesSchema}; absent/disabled → the base config is used. */
  roleOverrides: LlmRoleOverridesSchema,
  /** AUTOMATIC1111 / Stable Diffusion txt2img endpoint for image generation.
   *  Independent of the LLM connection; see {@link ImageGenSettingsSchema}. */
  image: ImageGenSettingsSchema,
});
export type LlmSettings = z.infer<typeof LlmSettingsSchema>;

/** Partial update for the settings PATCH endpoint. */
export const LlmSettingsUpdateSchema = LlmSettingsSchema.partial();
export type LlmSettingsUpdate = z.infer<typeof LlmSettingsUpdateSchema>;

export const DEFAULT_LLM_SETTINGS: LlmSettings = LlmSettingsSchema.parse({});

/**
 * Resolve the EFFECTIVE settings for a given model-call role. `prose` (and any
 * call that doesn't specify a role) uses the base config unchanged. `evaluator`
 * and `vision` use their full override connection when it is enabled; otherwise
 * they fall back to the base config — with `vision` additionally honoring the
 * legacy `visionModel` (a model-only override on the base endpoint). The returned
 * object is a complete `LlmSettings`, so it drops straight into `getAdapter` and
 * the structured caller. Pure: never mutates its input.
 */
export function resolveLlmRole(settings: LlmSettings, role: LlmRole): LlmSettings {
  if (role === 'prose') return settings;
  const override = settings.roleOverrides[role];
  if (override.enabled) {
    const connection: Partial<LlmSettings> = {};
    for (const key of LLM_CONNECTION_KEYS) {
      // Copy each connection/generation field off the override onto the base.
      (connection as Record<string, unknown>)[key] = override[key];
    }
    return { ...settings, ...connection };
  }
  if (role === 'vision') {
    return { ...settings, model: settings.visionModel.trim() || settings.model };
  }
  return settings;
}

/**
 * Settings as returned to the browser: every API key (base + each role override)
 * is blanked, with a parallel `*Set` flag so the UI can show "a key is set" without
 * ever receiving the secret. The client echoes a blank key to keep the stored one.
 */
export type RedactedLlmSettings = LlmSettings & {
  apiKeySet: boolean;
  roleApiKeySet: Record<'evaluator' | 'vision', boolean>;
};

/** Result of a health-check / test-prompt request from the Settings UI. */
export const LlmHealthResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  /** Round-trip latency in ms for the test call, if it completed. */
  latencyMs: z.number().optional(),
  /** Echoed sample of the model's reply text, when available. */
  sample: z.string().optional(),
  /** Models reported by /v1/models, when the endpoint supports listing. */
  models: z.array(z.string()).optional(),
});
export type LlmHealthResult = z.infer<typeof LlmHealthResultSchema>;

// --- Prompt size estimator (Debug page) -------------------------------------

/** Request body for the prompt-size estimator. */
export const PromptEstimateRequestSchema = z.object({
  /** Character whose real data is used to assemble the prompts. Null → the server
   *  picks a representative one (the first character it can find). */
  characterId: z.string().nullable().default(null),
  /** When true, each assembled prompt is sent to the model (max_tokens: 1) so the
   *  reported token count is the model's EXACT `usage.prompt_tokens`. When false (or
   *  if the endpoint can't be reached) counts fall back to a chars/4 estimate. */
  live: z.boolean().default(true),
  /** When true, pad the conversation/text history to the runtime caps with
   *  representative filler so the numbers reflect a near-worst-case full window
   *  rather than whatever short transcript happens to exist today. */
  simulateFull: z.boolean().default(false),
});
export type PromptEstimateRequest = z.infer<typeof PromptEstimateRequestSchema>;

/** One measured interaction (a real assembled prompt for, e.g., a date reply). */
export const PromptEstimateSchema = z.object({
  /** Stable key for the interaction (e.g. 'dating_dialogue'). */
  key: z.string(),
  /** Human label shown in the UI. */
  label: z.string(),
  /** One-line description of when this prompt is sent. */
  description: z.string(),
  /** Number of chat messages in the assembled request. */
  messageCount: z.number().int(),
  /** Total characters of text across all messages (image payloads excluded). */
  chars: z.number().int(),
  /** Prompt token count: the model's exact `usage.prompt_tokens` when measured
   *  live, otherwise a chars/4 estimate. */
  promptTokens: z.number().int(),
  /** How `promptTokens` was derived. */
  method: z.enum(['exact', 'estimated']),
  /** Output token budget this interaction reserves (settings.maxTokens, or a
   *  per-task override). Prompt + this is what must fit the context window. */
  maxResponseTokens: z.number().int(),
  /** Optional per-row note (e.g. a live-measurement failure that fell back). */
  note: z.string().optional(),
});
export type PromptEstimate = z.infer<typeof PromptEstimateSchema>;

/** Full estimator response: the measured interactions plus the context they were built in. */
export const PromptEstimateResultSchema = z.object({
  /** The model the counts were measured against. */
  model: z.string(),
  /** The character whose data was used, if any. */
  characterId: z.string().nullable(),
  characterName: z.string().nullable(),
  /** True when counts are the model's exact usage; false when they are estimates. */
  live: z.boolean(),
  /** Whether the history was padded to the runtime caps (worst-case). */
  simulateFull: z.boolean(),
  estimates: z.array(PromptEstimateSchema),
  /** Set when a live run couldn't reach the endpoint and fell back to estimates. */
  error: z.string().optional(),
});
export type PromptEstimateResult = z.infer<typeof PromptEstimateResultSchema>;
