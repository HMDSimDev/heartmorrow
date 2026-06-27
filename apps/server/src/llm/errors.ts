/**
 * Turn a raw transport error from talking to a model endpoint into a message a
 * player can act on.
 *
 * The most common real failure for this local-first app is "the model server
 * isn't running" — which Node's fetch surfaces as the useless
 * `TypeError: fetch failed`. Left alone, that exact string rides all the way to
 * the date screen (via the SSE error event), the phone, character generation,
 * and the Settings test. These helpers convert it once, at the source, into
 * something that points the player at the fix.
 */

/** Connection-level error codes that mean "the endpoint is not reachable". */
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

/** Pull a transport error code out of a fetch `cause` (which may be an
 * AggregateError holding several per-address attempts). */
function transportCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== 'object') return undefined;
  const c = cause as { code?: unknown; errors?: unknown };
  if (typeof c.code === 'string') return c.code;
  if (Array.isArray(c.errors)) {
    for (const inner of c.errors) {
      const code = (inner as { code?: unknown } | null)?.code;
      if (typeof code === 'string') return code;
    }
  }
  return undefined;
}

/**
 * Describe a model-endpoint failure for a human. Recognises connection failures
 * and timeouts; otherwise passes through the error's own message (which for an
 * HTTP non-2xx is already informative, e.g. `LLM endpoint returned 500 …`),
 * falling back to a generic line so the result is never empty.
 */
export function describeLlmError(err: unknown, baseUrl: string): string {
  const e = err as { name?: string; message?: string; cause?: unknown } | null;
  const message = typeof e?.message === 'string' ? e.message : '';
  const code = transportCode(e?.cause);

  const timedOut =
    e?.name === 'TimeoutError' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'ETIMEDOUT' ||
    /\btimed?\s*out\b|\btimeout\b/i.test(message);
  if (timedOut) {
    return `The AI endpoint at ${baseUrl} didn't respond in time — it may be slow to load the model, or unreachable.`;
  }

  const unreachable = (code && CONNECTION_CODES.has(code)) || /fetch failed/i.test(message);
  if (unreachable) {
    return `Couldn't reach the AI endpoint at ${baseUrl}. Make sure your model server is running, then check Settings → LLM.`;
  }

  return message || 'The AI endpoint returned an unexpected error.';
}

/**
 * `fetch` for a model endpoint, with transport failures re-thrown carrying an
 * actionable message from {@link describeLlmError}.
 *
 * A genuine caller-initiated cancel (an `AbortError` whose signal was aborted,
 * and which is NOT a timeout) is re-thrown UNCHANGED so upstream
 * `signal.aborted` / AbortError handling keeps working — only real transport
 * failures and timeouts are rewritten.
 */
export async function llmFetch(url: string, init: RequestInit = {}, baseUrl: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const signal = init.signal as (AbortSignal & { reason?: unknown }) | null | undefined;
    const reason = signal?.reason as { name?: string } | undefined;
    const timedOut = (err as { name?: string } | null)?.name === 'TimeoutError' || reason?.name === 'TimeoutError';
    // Preserve a deliberate cancel (client disconnect, user abort) verbatim.
    if (signal?.aborted && !timedOut) throw err;
    // For a timeout, the AbortSignal.timeout reason carries the TimeoutError name
    // that describeLlmError keys off of; prefer it when the thrown error doesn't.
    throw new Error(describeLlmError(timedOut ? (reason ?? err) : err, baseUrl));
  }
}
