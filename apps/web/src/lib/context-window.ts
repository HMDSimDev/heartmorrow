export const CONTEXT_WINDOW_STORAGE_KEY = 'dsim.debug.contextWindow';
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 8_192;

type ContextUsageTone = 'normal' | 'warning' | 'critical';

/** Read the model's configured context length, falling back to the app default. */
export function readContextWindowTokens(storage: Pick<Storage, 'getItem'> = localStorage): number {
  const value = Number(storage.getItem(CONTEXT_WINDOW_STORAGE_KEY));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/** Keep the real estimate visible above 100%; only the meter fill is visually capped. */
export function contextUsagePercent(estimatedTokens: number, contextWindowTokens: number): number {
  if (!Number.isFinite(estimatedTokens) || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return 0;
  return Math.max(0, Math.round((estimatedTokens / contextWindowTokens) * 100));
}

export function contextUsageTone(percent: number): ContextUsageTone {
  if (percent >= 90) return 'critical';
  if (percent >= 70) return 'warning';
  return 'normal';
}
