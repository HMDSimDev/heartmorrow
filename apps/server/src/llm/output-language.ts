import type { OutputLanguage } from '@dsim/shared';
import type { ChatAdapter, ChatMessage, ChatRequest, ChatResult, LlmModelInfo } from './types';

/** Human-readable target names plus endonyms, which help smaller local models
 * recognize the requested language even when their English instruction following
 * is uneven. `auto` intentionally has no entry and produces no prompt mutation. */
const LANGUAGE_NAMES: Record<Exclude<OutputLanguage, 'auto'>, string> = {
  en: 'English',
  'zh-Hans': 'Simplified Chinese / Mandarin (简体中文)',
  'zh-Hant': 'Traditional Chinese / Mandarin (繁體中文)',
  ja: 'Japanese (日本語)',
  ko: 'Korean (한국어)',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  'pt-BR': 'Brazilian Portuguese (Português do Brasil)',
  it: 'Italian (Italiano)',
  ru: 'Russian (Русский)',
  pl: 'Polish (Polski)',
  nl: 'Dutch (Nederlands)',
  tr: 'Turkish (Türkçe)',
  ar: 'Arabic (العربية)',
  he: 'Hebrew (עברית)',
  fa: 'Persian / Farsi (فارسی)',
  ur: 'Urdu (اردو)',
  hi: 'Hindi (हिन्दी)',
  id: 'Indonesian (Bahasa Indonesia)',
  vi: 'Vietnamese (Tiếng Việt)',
  th: 'Thai (ไทย)',
  uk: 'Ukrainian (Українська)',
};

/** Strict global instruction used for free prose and structured calls alike. */
export function outputLanguageInstruction(language: OutputLanguage): string | null {
  if (language === 'auto') return null;
  const name = LANGUAGE_NAMES[language];
  return (
    `OUTPUT LANGUAGE — MANDATORY: Write every player-visible natural-language string you generate in ${name}. ` +
    `Do not write prose in any other language. Preserve proper names, quoted user text, URLs, code, and technical identifiers when necessary. ` +
    `For structured output, keep JSON property names, enum values, IDs, and all schema-controlled literal values exactly as specified; ` +
    `write only the natural-language string values in ${name}.`
  );
}

/**
 * Add the language rule to the first system message without mutating the caller's
 * message array. Keeping it in the leading system turn works across OpenAI-style
 * chat, Anthropic's extracted top-level system prompt, and rendered Kobold templates.
 */
export function applyOutputLanguage(messages: ChatMessage[], language: OutputLanguage): ChatMessage[] {
  const instruction = outputLanguageInstruction(language);
  if (!instruction) return messages;

  const systemIndex = messages.findIndex((message) => message.role === 'system');
  if (systemIndex < 0) return [{ role: 'system', content: instruction }, ...messages];

  const system = messages[systemIndex]!;
  const content =
    typeof system.content === 'string'
      ? `${system.content}\n\n${instruction}`
      : [...system.content, { type: 'text' as const, text: instruction }];
  const next = [...messages];
  next[systemIndex] = { ...system, content };
  return next;
}

/** Decorate one transport so every chat and streaming request gets the rule.
 * Model listing has no generated prose and passes straight through. */
export function withOutputLanguage(adapter: ChatAdapter, language: OutputLanguage): ChatAdapter {
  if (language === 'auto') return adapter;
  return new OutputLanguageAdapter(adapter, language);
}

class OutputLanguageAdapter implements ChatAdapter {
  readonly name: string;

  constructor(
    private readonly inner: ChatAdapter,
    private readonly language: OutputLanguage,
  ) {
    this.name = inner.name;
  }

  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    return this.inner.chat({ ...req, messages: applyOutputLanguage(req.messages, this.language) }, signal);
  }

  streamChat(
    req: ChatRequest,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    return this.inner.streamChat(
      { ...req, messages: applyOutputLanguage(req.messages, this.language) },
      onDelta,
      signal,
    );
  }

  listModels(signal?: AbortSignal): Promise<LlmModelInfo[]> {
    return this.inner.listModels(signal);
  }
}
