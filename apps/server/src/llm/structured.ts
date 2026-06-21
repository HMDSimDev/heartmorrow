import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LlmSettings, StructuredResult } from '@dsim/shared';
import { parseJsonStrict, JsonParseError } from '../lib/json';
import { getAdapter } from './provider';
import type { ChatAdapter, ChatMessage, ResponseFormat, TokenUsage } from './types';

/**
 * Central structured-output caller. This is the ONLY way game-state-affecting
 * LLM output enters the system.
 *
 * Behavior (per spec, deliberately strict):
 *  1. Ask the model for JSON using the configured structured-output mode.
 *  2. Parse the response STRICTLY (`JSON.parse`). No regex extraction. No
 *     partial-JSON repair. No prose stripping. No "best guess" of fields.
 *  3. Validate against the Zod schema.
 *  4. On parse OR validation failure, RE-SUBMIT to the model with a stricter
 *     repair prompt that includes the original task, the JSON schema, the
 *     validation errors, and the model's invalid response — asking it to
 *     regenerate the entire response (not to explain itself).
 *  5. Lower the temperature on each retry.
 *  6. After `maxRetries` retries, return a typed FAILURE. Callers must not
 *     mutate game state on failure.
 */

export interface StructuredCallOptions {
  settings: LlmSettings;
  /** Human description of the task, embedded in repair prompts for context. */
  task: string;
  /** Name used for the JSON schema (json_schema mode). */
  schemaName?: string;
  /** Override the starting temperature (defaults to settings.temperature). */
  baseTemperature?: number;
  /** Override the retry count (defaults to settings.maxRetries). */
  maxRetries?: number;
  /** Override the output token budget (defaults to settings.maxTokens). Needed
   * for tasks whose schema permits long output (e.g. the chronicle fold). */
  maxTokens?: number;
  /** Inject an adapter (used by tests). Defaults to one built from settings. */
  adapter?: ChatAdapter;
  signal?: AbortSignal;
  /** Optional logger for retry diagnostics. */
  log?: (message: string) => void;
  /**
   * Optional per-attempt telemetry hook (used by the Heartmorrow Bench). Fires once
   * for EVERY model call this function makes — including retries and response-format
   * downgrades — with the round-trip latency, the endpoint's reported usage (when
   * any), and the prompt/completion character counts. Purely observational: it never
   * affects control flow. Production callers omit it.
   */
  onAttempt?: (info: {
    /** 1-based index of this model call within the structured call. */
    call: number;
    latencyMs: number;
    usage?: TokenUsage;
    /** Transport-level success (the call returned content, before parse/validation). */
    ok: boolean;
    promptChars: number;
    completionChars: number;
  }) => void;
}

/** Total characters across a message list (text parts only; image data excluded). */
function messagesChars(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => {
    if (typeof m.content === 'string') return n + m.content.length;
    return n + m.content.reduce((a, p) => a + (p.type === 'text' ? p.text.length : 0), 0);
  }, 0);
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `- ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}

function buildResponseFormat(
  mode: LlmSettings['structuredMode'],
  schemaName: string,
  jsonSchema: unknown,
): ResponseFormat {
  switch (mode) {
    case 'json_schema':
      // strict:false maximizes compatibility with local servers (LM Studio,
      // llama.cpp grammars) that don't require every property to be "required".
      return { type: 'json_schema', json_schema: { name: schemaName, schema: jsonSchema, strict: false } };
    case 'json_object':
      return { type: 'json_object' };
    case 'prompt_only':
    default:
      return { type: 'text' };
  }
}

/**
 * Ordered list of structured-output modes to try, starting from the configured
 * one. If a server rejects the format (e.g. newer LM Studio rejects
 * 'json_object'), we downgrade through the chain until one is accepted.
 * 'prompt_only' sends no response_format at all, so it is universally accepted.
 */
function buildModeChain(start: LlmSettings['structuredMode']): LlmSettings['structuredMode'][] {
  switch (start) {
    case 'json_schema':
      return ['json_schema', 'json_object', 'prompt_only'];
    case 'json_object':
      return ['json_object', 'json_schema', 'prompt_only'];
    case 'prompt_only':
    default:
      return ['prompt_only'];
  }
}

/** Heuristic: did the server reject the request specifically over the structured
 * -output directive? Covers the OpenAI `response_format` field and Anthropic's
 * `output_config` / schema, so an unsupported grammar downgrades the mode chain
 * (json_schema → json_object → prompt_only) instead of failing outright. */
function isResponseFormatError(message: string): boolean {
  return /response[_ ]?format|output[_ ]?config|json[_ ]?schema/i.test(message);
}

/**
 * The per-attempt "base instruction" appended to the messages. In json_schema mode
 * the server's grammar already enforces the shape, so when `omitSchema` is set we
 * send only a short "JSON only" directive and skip the (redundant, token-heavy)
 * schema dump. Every other mode MUST include the schema text — it is the only thing
 * describing the required shape there.
 */
function buildBaseInstruction(
  mode: LlmSettings['structuredMode'],
  omitSchema: boolean,
  schemaText: string,
): ChatMessage {
  if (mode === 'json_schema' && omitSchema) {
    return {
      role: 'user',
      content:
        `Respond with ONLY a single JSON object. ` +
        `Do not include code fences, comments, or any prose outside the JSON.`,
    };
  }
  return {
    role: 'user',
    content:
      `Respond with ONLY a single JSON object that strictly conforms to this JSON schema.\n` +
      `Do not include code fences, comments, or any prose outside the JSON.\n\n` +
      `JSON schema:\n${schemaText}`,
  };
}

export async function callStructuredLlm<S extends z.ZodTypeAny>(
  schema: S,
  messages: ChatMessage[],
  options: StructuredCallOptions,
): Promise<StructuredResult<z.output<S>>> {
  const { settings, task } = options;
  const schemaName = options.schemaName ?? 'Result';
  const maxRetries = options.maxRetries ?? settings.maxRetries;
  const baseTemp = options.baseTemperature ?? settings.temperature;
  const adapter = options.adapter ?? getAdapter(settings);

  const jsonSchema = zodToJsonSchema(schema, { name: schemaName, $refStrategy: 'none' });
  const schemaText = JSON.stringify(jsonSchema, null, 2);

  // Adaptive structured-output mode: start from the configured mode and
  // downgrade if the server rejects the response_format.
  const modeChain = buildModeChain(settings.structuredMode);
  let modeIdx = 0;
  let formatFallbacks = 0;
  const maxFormatFallbacks = modeChain.length - 1;

  let lastError = 'No attempts were made.';
  let lastRaw: string | undefined;
  let callIndex = 0; // counts every model call (incl. retries + format downgrades)

  const totalAttempts = maxRetries + 1; // 1 initial call + N retries
  let attempt = 0;
  while (attempt < totalAttempts) {
    // Stop before each call if the caller aborted (e.g. the bench user hit Cancel) —
    // works even for adapters that don't propagate the signal to their transport.
    if (options.signal?.aborted) {
      return { ok: false, error: 'Aborted.', attempts: attempt, lastRaw };
    }
    const mode = modeChain[modeIdx]!;
    const responseFormat = buildResponseFormat(mode, schemaName, jsonSchema);
    const temperature = Math.max(0, baseTemp - attempt * 0.2);

    // Built per attempt because the mode can downgrade across retries (and the
    // omit-schema optimization only applies while we're actually in json_schema mode).
    const baseInstruction = buildBaseInstruction(mode, settings.omitSchemaInPrompt, schemaText);
    const attemptMessages: ChatMessage[] = [...messages, baseInstruction];
    if (attempt > 0) {
      attemptMessages.push({
        role: 'user',
        content:
          `Your previous response did NOT satisfy the required schema and was rejected.\n\n` +
          `TASK:\n${task}\n\n` +
          `REQUIRED JSON SCHEMA:\n${schemaText}\n\n` +
          `VALIDATION ERRORS:\n${lastError}\n\n` +
          `YOUR INVALID RESPONSE:\n${lastRaw ?? '(none / not valid JSON)'}\n\n` +
          `Regenerate the ENTIRE response as one JSON object that strictly matches the schema. ` +
          `Output ONLY the JSON. Do not explain yourself.`,
      });
    }

    let content: string;
    callIndex += 1;
    const callStarted = Date.now();
    try {
      const result = await adapter.chat(
        { messages: attemptMessages, temperature, maxTokens: options.maxTokens ?? settings.maxTokens, responseFormat },
        options.signal,
      );
      content = result.content;
      lastRaw = content;
      options.onAttempt?.({
        call: callIndex,
        latencyMs: Date.now() - callStarted,
        usage: result.usage,
        ok: true,
        promptChars: messagesChars(attemptMessages),
        completionChars: content.length,
      });
    } catch (err) {
      options.onAttempt?.({
        call: callIndex,
        latencyMs: Date.now() - callStarted,
        usage: undefined,
        ok: false,
        promptChars: messagesChars(attemptMessages),
        completionChars: 0,
      });
      const message = (err as Error).message;
      // If the caller aborted (e.g. the bench user hit Cancel / disconnected),
      // stop immediately rather than spending the remaining retry budget.
      if (options.signal?.aborted || (err as Error).name === 'AbortError') {
        return { ok: false, error: `Aborted: ${message}`, attempts: attempt + 1, lastRaw };
      }
      lastError = `Transport error: ${message}`;
      // A transport failure produced no model reply — clear any stale reply from an
      // earlier attempt so the repair prompt shows "(none / not valid JSON)" rather
      // than pairing this transport error with an unrelated prior response.
      lastRaw = undefined;
      // Unsupported response_format → downgrade and retry WITHOUT spending a
      // content-retry attempt (the model never got a chance to answer).
      if (isResponseFormatError(message) && formatFallbacks < maxFormatFallbacks) {
        modeIdx += 1;
        formatFallbacks += 1;
        options.log?.(
          `[structured:${schemaName}] response_format '${mode}' rejected; downgrading to '${modeChain[modeIdx]}'.`,
        );
        continue;
      }
      options.log?.(`[structured:${schemaName}] attempt ${attempt + 1}/${totalAttempts} transport error: ${lastError}`);
      attempt += 1;
      continue;
    }

    // STRICT parse — no salvage.
    let parsed: unknown;
    try {
      parsed = parseJsonStrict(content);
    } catch (err) {
      lastError =
        err instanceof JsonParseError ? err.message : `JSON parse failed: ${(err as Error).message}`;
      options.log?.(`[structured:${schemaName}] attempt ${attempt + 1}/${totalAttempts} parse failed: ${lastError}`);
      attempt += 1;
      continue;
    }

    const validation = schema.safeParse(parsed);
    if (validation.success) {
      return { ok: true, data: validation.data, attempts: attempt + 1 };
    }
    lastError = formatZodError(validation.error);
    options.log?.(`[structured:${schemaName}] attempt ${attempt + 1}/${totalAttempts} validation failed:\n${lastError}`);
    attempt += 1;
  }

  return {
    ok: false,
    error: `Structured output failed after ${totalAttempts} attempt(s). Last error:\n${lastError}`,
    attempts: totalAttempts,
    lastRaw,
  };
}
