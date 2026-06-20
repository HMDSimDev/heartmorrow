/**
 * Strict JSON handling for structured LLM output.
 *
 * IMPORTANT: We do NOT attempt regex extraction, partial-JSON repair, or
 * "best guess" salvage of malformed model output. We parse strictly. If the
 * model wrapped JSON in prose or produced invalid JSON, parsing fails and the
 * caller's job is to RE-PROMPT the model — never to hack the string into shape.
 */
export class JsonParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'JsonParseError';
  }
}

/** Parse text as JSON strictly. Throws `JsonParseError` on any failure. */
export function parseJsonStrict(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new JsonParseError('Empty response (no JSON).', text);
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new JsonParseError(
      `Response was not valid JSON: ${(err as Error).message}`,
      text,
    );
  }
}
