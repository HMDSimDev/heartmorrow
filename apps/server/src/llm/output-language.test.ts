import { describe, expect, it } from 'vitest';
import { LlmSettingsSchema, OUTPUT_LANGUAGES, outputLanguageDirection } from '@dsim/shared';
import type { ChatAdapter, ChatRequest, ChatResult, LlmModelInfo } from './types';
import { applyOutputLanguage, outputLanguageInstruction, withOutputLanguage } from './output-language';

class CaptureAdapter implements ChatAdapter {
  readonly name = 'capture';
  requests: ChatRequest[] = [];
  listed = 0;

  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    return { content: 'ok' };
  }

  async streamChat(req: ChatRequest, onDelta: (text: string) => void): Promise<ChatResult> {
    this.requests.push(req);
    onDelta('ok');
    return { content: 'ok' };
  }

  async listModels(): Promise<LlmModelInfo[]> {
    this.listed += 1;
    return [];
  }
}

describe('output-language enforcement', () => {
  it('defaults old settings to automatic and rejects unsupported values', () => {
    expect(LlmSettingsSchema.parse({}).outputLanguage).toBe('auto');
    expect(LlmSettingsSchema.safeParse({ outputLanguage: 'klingon' }).success).toBe(false);
  });

  it('identifies forced RTL output languages', () => {
    expect(outputLanguageDirection('auto')).toBe('auto');
    expect(outputLanguageDirection('en')).toBe('ltr');
    for (const language of ['ar', 'he', 'fa', 'ur'] as const) {
      expect(outputLanguageDirection(language)).toBe('rtl');
    }
  });

  it('leaves messages untouched in automatic mode', () => {
    const messages = [{ role: 'user' as const, content: 'Hello' }];
    expect(applyOutputLanguage(messages, 'auto')).toBe(messages);
    expect(outputLanguageInstruction('auto')).toBeNull();
  });

  it('adds a strict language rule to the existing system turn without mutation', () => {
    const messages = [
      { role: 'system' as const, content: 'You are Mina.' },
      { role: 'user' as const, content: 'Hello' },
    ];
    const next = applyOutputLanguage(messages, 'ja');

    expect(next).not.toBe(messages);
    expect(messages[0]!.content).toBe('You are Mina.');
    expect(next[0]!.content).toContain('Japanese (日本語)');
    expect(next[0]!.content).toContain('JSON property names, enum values, IDs');
    expect(next[1]).toBe(messages[1]);
  });

  it('prepends a system turn when the request has none', () => {
    const next = applyOutputLanguage([{ role: 'user', content: 'Hola' }], 'zh-Hans');

    expect(next[0]?.role).toBe('system');
    expect(next[0]?.content).toContain('Simplified Chinese / Mandarin (简体中文)');
  });

  it('covers every option and decorates chat plus streaming calls', async () => {
    for (const language of OUTPUT_LANGUAGES) {
      if (language !== 'auto') expect(outputLanguageInstruction(language)).toBeTruthy();
    }

    const inner = new CaptureAdapter();
    const adapter = withOutputLanguage(inner, 'es');
    const req = { messages: [{ role: 'user' as const, content: 'Hi' }] };
    await adapter.chat(req);
    await adapter.streamChat(req, () => {});
    await adapter.listModels();

    expect(inner.requests).toHaveLength(2);
    for (const captured of inner.requests) {
      expect(captured.messages[0]?.role).toBe('system');
      expect(captured.messages[0]?.content).toContain('Spanish (Español)');
    }
    expect(inner.listed).toBe(1);
  });
});
