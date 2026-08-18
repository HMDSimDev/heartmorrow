import {
  LlmSettingsSchema,
  type LlmSettings,
  type LlmSettingsUpdate,
  type RedactedLlmSettings,
} from '@dsim/shared';
import { settingsRepo } from '../db/repositories';
import { config } from '../config';

const SETTINGS_KEY = 'llm';
const CONFIGURED_KEY = 'llm-configured';
const CONFIGURED_EXPLICIT = 'explicit';
const CONFIGURED_LEGACY = 'legacy';
const CONFIGURED_NO = '0';
const LEGACY_PLACEHOLDER_URLS = new Set(['http://localhost:1234/v1', 'http://localhost:1234/', 'http://host.docker.internal:1234/v1']);

/** Saving any of these fields means the player deliberately configured the main
 *  model connection. Gameplay-only PATCHes must not accidentally dismiss the
 *  first-run setup screen. */
const CONNECTION_SETUP_KEYS: ReadonlyArray<keyof LlmSettingsUpdate> = ['baseUrl', 'apiKey', 'model', 'endpointMode'];

function connectionDiffersFromDefaults(settings: LlmSettings): boolean {
  for (const key of CONNECTION_SETUP_KEYS) {
    if (key === 'baseUrl' && LEGACY_PLACEHOLDER_URLS.has(settings.baseUrl)) continue;
    if (settings[key] !== config.llmDefaults[key]) return true;
  }
  return false;
}

function isLlmConfigured(settings: LlmSettings): boolean {
  const marker = settingsRepo.getRaw(CONFIGURED_KEY);
  if (marker === CONFIGURED_EXPLICIT || marker === CONFIGURED_LEGACY) return true;
  if (marker !== '1') return false;
  // Version 1 used `1` for both deliberate saves and automatic legacy migration.
  // Resolve that ambiguous value once: untouched defaults are not configuration;
  // a customized legacy connection is.
  if (connectionDiffersFromDefaults(settings)) {
    settingsRepo.set(CONFIGURED_KEY, CONFIGURED_LEGACY);
    return true;
  }
  settingsRepo.set(CONFIGURED_KEY, CONFIGURED_NO);
  return false;
}

/** The roles that carry their own (optional) connection override. */
const OVERRIDE_ROLES = ['evaluator', 'vision'] as const;

/** Get the current LLM settings (server-internal; includes the API key). */
export function getLlmSettings(): LlmSettings {
  const raw = settingsRepo.getRaw(SETTINGS_KEY);
  if (!raw) {
    const seeded = config.llmDefaults;
    settingsRepo.set(SETTINGS_KEY, JSON.stringify(seeded));
    if (config.llmConfiguredFromEnvironment) settingsRepo.set(CONFIGURED_KEY, CONFIGURED_EXPLICIT);
    else settingsRepo.set(CONFIGURED_KEY, CONFIGURED_NO);
    return seeded;
  }
  const parsed = LlmSettingsSchema.safeParse(JSON.parse(raw));
  let settings = config.llmDefaults;
  if (parsed.success) settings = parsed.data;
  if (settingsRepo.getRaw(CONFIGURED_KEY) === undefined) {
    if (connectionDiffersFromDefaults(settings)) settingsRepo.set(CONFIGURED_KEY, CONFIGURED_LEGACY);
    else settingsRepo.set(CONFIGURED_KEY, CONFIGURED_NO);
  }
  return settings;
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
  let connectionWasSaved = false;
  for (const key of CONNECTION_SETUP_KEYS) {
    if (Object.prototype.hasOwnProperty.call(update, key)) connectionWasSaved = true;
  }
  if (connectionWasSaved) settingsRepo.set(CONFIGURED_KEY, CONFIGURED_EXPLICIT);
  return merged;
}

/** Settings shape returned to the browser — every API key redacted (base + roles). */
export function getRedactedLlmSettings(): RedactedLlmSettings {
  const s = getLlmSettings();
  return {
    ...s,
    apiKey: '',
    apiKeySet: s.apiKey.length > 0,
    configured: isLlmConfigured(s),
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
