import {
  LlmSettingsSchema,
  type LlmSettings,
  type LlmSettingsUpdate,
  type RedactedLlmSettings,
} from '@dsim/shared';
import { settingsRepo } from '../db/repositories';
import { config } from '../config';

const SETTINGS_KEY = 'llm';

/** The roles that carry their own (optional) connection override. */
const OVERRIDE_ROLES = ['evaluator', 'vision'] as const;

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
 * Update settings. Every API key (the base one AND each per-role override) is
 * preserved unless a non-empty replacement is supplied — the client never needs to
 * echo an existing key back, and we never leak any in GET responses (see the
 * settings route + `getRedactedLlmSettings`).
 */
export function updateLlmSettings(update: LlmSettingsUpdate): LlmSettings {
  const current = getLlmSettings();
  const next = { ...current, ...update };
  if (update.apiKey === undefined || update.apiKey === '') {
    next.apiKey = current.apiKey;
  }
  // Same preserve-if-blank rule, per role override. roleOverrides is sent whole by
  // the client (the PATCH schema is a shallow partial), so when it's present we
  // re-inject each role's existing key whenever the incoming one is blank.
  if (update.roleOverrides) {
    const roles = { ...update.roleOverrides };
    for (const role of OVERRIDE_ROLES) {
      const incoming = roles[role];
      if (incoming && (incoming.apiKey === undefined || incoming.apiKey === '')) {
        roles[role] = { ...incoming, apiKey: current.roleOverrides[role].apiKey };
      }
    }
    next.roleOverrides = roles;
  }
  // Tragic outcomes can never remain armed without adult content — disabling NSFW
  // also disarms it (and keeps stored state honest with the UI gate).
  if (next.nsfwEnabled === false) next.tragicOutcomesEnabled = false;
  const merged = LlmSettingsSchema.parse(next);
  settingsRepo.set(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

/** Settings shape returned to the browser — every API key redacted (base + roles). */
export function getRedactedLlmSettings(): RedactedLlmSettings {
  const s = getLlmSettings();
  return {
    ...s,
    apiKey: '',
    apiKeySet: s.apiKey.length > 0,
    roleOverrides: {
      evaluator: { ...s.roleOverrides.evaluator, apiKey: '' },
      vision: { ...s.roleOverrides.vision, apiKey: '' },
    },
    roleApiKeySet: {
      evaluator: s.roleOverrides.evaluator.apiKey.length > 0,
      vision: s.roleOverrides.vision.apiKey.length > 0,
    },
  };
}
