import { LlmSettingsSchema, type LlmSettings, type LlmSettingsUpdate } from '@dsim/shared';
import { settingsRepo } from '../db/repositories';
import { config } from '../config';

const SETTINGS_KEY = 'llm';

/** Get the current LLM settings (server-internal; includes the API key). */
export function getLlmSettings(): LlmSettings {
  const raw = settingsRepo.getRaw(SETTINGS_KEY);
  if (!raw) {
    const seeded = config.llmDefaults;
    settingsRepo.set(SETTINGS_KEY, JSON.stringify(seeded));
    return seeded;
  }
  const parsed = LlmSettingsSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : config.llmDefaults;
}

/**
 * Update settings. The API key is preserved unless a non-empty replacement is
 * supplied — the client never needs to echo the existing key back, and we
 * never leak it in GET responses (see the settings route).
 */
export function updateLlmSettings(update: LlmSettingsUpdate): LlmSettings {
  const current = getLlmSettings();
  const next = { ...current, ...update };
  if (update.apiKey === undefined || update.apiKey === '') {
    next.apiKey = current.apiKey;
  }
  // Tragic outcomes can never remain armed without adult content — disabling NSFW
  // also disarms it (and keeps stored state honest with the UI gate).
  if (next.nsfwEnabled === false) next.tragicOutcomesEnabled = false;
  const merged = LlmSettingsSchema.parse(next);
  settingsRepo.set(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

/** Settings shape returned to the browser — API key redacted. */
export function getRedactedLlmSettings(): LlmSettings & { apiKeySet: boolean } {
  const s = getLlmSettings();
  return { ...s, apiKey: '', apiKeySet: s.apiKey.length > 0 };
}
