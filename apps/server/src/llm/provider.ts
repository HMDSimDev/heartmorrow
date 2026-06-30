import type { LlmSettings } from '@dsim/shared';
import type { ChatAdapter } from './types';
import { OpenAiCompatibleAdapter } from './openai-adapter';
import { AnthropicAdapter } from './anthropic-adapter';
import { LmStudioAdapter } from './lmstudio-adapter';
import { OllamaAdapter } from './ollama-adapter';
import { KoboldcppAdapter } from './koboldcpp-adapter';

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
 * The `endpointMode` setting selects the transport. The adapter interface
 * (`ChatAdapter`) is intentionally transport-agnostic so each mode can hit a
 * different wire format without touching the structured-output / retry logic:
 *  - `chat_completions` — OpenAI-compatible `/chat/completions`
 *  - `lmstudio`         — LM Studio's native `/api/v0` (OpenAI-shaped chat +
 *                         richer model listing & per-response stats)
 *  - `ollama`           — Ollama's native `/api/chat` (thinking toggle + reasoning
 *                         level, `/api/tags` listing)
 *  - `koboldcpp`        — KoboldCpp's native `/api/v1/generate` (text-completion;
 *                         messages rendered with a chat template)
 *  - `anthropic`        — Anthropic Messages API `/messages`
 *  - `responses`        — reserved (`/v1/responses`); falls back to OpenAI today
 */
export function getAdapter(settings: LlmSettings): ChatAdapter {
  if (adapterOverride) return adapterOverride;
  const openAiCfg = {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    sampling: {
      topP: settings.topP,
      topK: settings.topK,
      minP: settings.minP,
      frequencyPenalty: settings.frequencyPenalty,
      presencePenalty: settings.presencePenalty,
      repeatPenalty: settings.repeatPenalty,
    },
  };
  switch (settings.endpointMode) {
    case 'anthropic':
      return new AnthropicAdapter({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        anthropicVersion: settings.anthropicVersion,
        sampling: { topP: settings.topP, topK: settings.topK },
      });
    case 'lmstudio':
      return new LmStudioAdapter(openAiCfg);
    case 'ollama':
      return new OllamaAdapter({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        think: settings.ollamaThink,
        sampling: openAiCfg.sampling,
      });
    case 'koboldcpp':
      return new KoboldcppAdapter({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        template: settings.koboldTemplate,
        sampling: openAiCfg.sampling,
      });
    case 'responses':
      // Not yet implemented. Fall back to chat/completions so the app keeps
      // working; swap in a ResponsesAdapter here when ready.
      return new OpenAiCompatibleAdapter(openAiCfg);
    case 'chat_completions':
    default:
      return new OpenAiCompatibleAdapter(openAiCfg);
  }
}
