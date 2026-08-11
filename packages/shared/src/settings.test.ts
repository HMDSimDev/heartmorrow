import { describe, expect, it } from 'vitest';
import { DEFAULT_LLM_SETTINGS, LlmSettingsSchema } from './schemas/settings';

describe('LLM settings defaults', () => {
  it('does not assume a local model endpoint', () => {
    expect(DEFAULT_LLM_SETTINGS.baseUrl).toBe('');
    expect(LlmSettingsSchema.parse({ baseUrl: '' }).baseUrl).toBe('');
  });

  it('still rejects a non-empty invalid endpoint', () => {
    expect(() => LlmSettingsSchema.parse({ baseUrl: 'not a URL' })).toThrow();
  });
});
