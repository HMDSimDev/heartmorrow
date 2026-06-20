import type { LlmSettings } from '@dsim/shared';
import type { ChatAdapter } from './types';
import { OpenAiCompatibleAdapter } from './openai-adapter';

/**
 * Optional adapter override. When set (used by tests), every consumer that
 * resolves an adapter through `getAdapter` gets this one instead of a real
 * network adapter. Production code never sets this.
 */
let adapterOverride: ChatAdapter | null = null;

export function setAdapterOverride(adapter: ChatAdapter | null): void {
  adapterOverride = adapter;
}

/**
 * Build a chat adapter from the current LLM settings.
 *
 * The `endpointMode` setting selects the transport. Today only
 * `chat_completions` is implemented; `responses` is reserved — the adapter
 * interface (`ChatAdapter`) is intentionally transport-agnostic so a
 * `ResponsesAdapter` hitting `/v1/responses` can be added later without
 * touching the structured-output / retry logic.
 */
export function getAdapter(settings: LlmSettings): ChatAdapter {
  if (adapterOverride) return adapterOverride;
  switch (settings.endpointMode) {
    case 'responses':
      // Not yet implemented. Fall back to chat/completions so the app keeps
      // working; swap in a ResponsesAdapter here when ready.
      return new OpenAiCompatibleAdapter({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
      });
    case 'chat_completions':
    default:
      return new OpenAiCompatibleAdapter({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
      });
  }
}
