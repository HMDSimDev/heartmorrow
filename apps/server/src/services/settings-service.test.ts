import { beforeEach, describe, expect, it } from 'vitest';
import { getRedactedLlmSettings, updateLlmSettings } from './settings-service';
import { resetDb } from '../test/helpers';
import { settingsRepo } from '../db/repositories';

describe('model setup state', () => {
  beforeEach(resetDb);

  it('stays unconfigured until a connection field is explicitly saved', () => {
    expect(getRedactedLlmSettings().configured).toBe(false);
    updateLlmSettings({ difficulty: 'gentle' });
    expect(getRedactedLlmSettings().configured).toBe(false);
    updateLlmSettings({ model: 'my-local-model' });
    expect(getRedactedLlmSettings().configured).toBe(true);
  });

  it('migrates an existing pre-marker settings row as configured', () => {
    settingsRepo.set('llm', JSON.stringify({ model: 'existing-model' }));
    expect(getRedactedLlmSettings().configured).toBe(true);
  });

  it('does not treat an untouched legacy default row as configured', () => {
    settingsRepo.set('llm', JSON.stringify({}));
    expect(getRedactedLlmSettings().configured).toBe(false);
  });

  it('repairs the ambiguous version-one marker on an untouched default row', () => {
    settingsRepo.set('llm', JSON.stringify({}));
    settingsRepo.set('llm-configured', '1');
    expect(getRedactedLlmSettings().configured).toBe(false);
  });

  it('preserves a stored localhost endpoint even when the legacy setup is ambiguous', () => {
    settingsRepo.set('llm', JSON.stringify({ baseUrl: 'http://localhost:1234/v1' }));
    settingsRepo.set('llm-configured', '0');
    const settings = getRedactedLlmSettings();
    expect(settings.configured).toBe(false);
    expect(settings.baseUrl).toBe('http://localhost:1234/v1');
  });
});
