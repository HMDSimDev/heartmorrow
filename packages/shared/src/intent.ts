import { z } from 'zod';
import type { WarmthStats } from './social';

/**
 * Player conversational INTENTS — the "intent chips" a player can attach to a
 * free-typed date message (Flirt / Tease / Reassure / Open Up / Apologize).
 *
 * An intent is pure player AGENCY layered on top of the free text, not a new
 * mechanic: it never moves a stat by itself. It is stored on the player
 * message's `metadata.intent`, framed for the character so they react to the
 * move, and surfaced to the impartial judges (the per-turn rapport read AND the
 * end-of-session evaluator) so they can REWARD an intent that fits the moment
 * and DING a mismatch — flirting with a near-stranger, apologizing when nothing
 * is wrong. As always, the server/judge owns the verdict; the chip is a claim.
 */
export const INTENTS = ['flirt', 'tease', 'reassure', 'open_up', 'apologize'] as const;
export type Intent = (typeof INTENTS)[number];
export const IntentSchema = z.enum(INTENTS);

export const INTENT_LABELS: Record<Intent, string> = {
  flirt: 'Flirt',
  tease: 'Tease',
  reassure: 'Reassure',
  open_up: 'Open Up',
  apologize: 'Apologize',
};

/** A small glyph per intent for the chip row. */
export const INTENT_ICONS: Record<Intent, string> = {
  flirt: '😘',
  tease: '😏',
  reassure: '🤝',
  open_up: '🫶',
  apologize: '🙏',
};

/**
 * A short third-person stage direction describing the player's ATTEMPTED intent.
 * Used both to frame the player's line for the CHARACTER (so they react to the
 * move) and to annotate the transcript for the JUDGES (so they can grade fit).
 * Phrased as description, never an instruction the model should obey or echo.
 */
export const INTENT_CUE: Record<Intent, string> = {
  flirt: 'flirting — being playfully romantic',
  tease: 'teasing them playfully',
  reassure: 'trying to reassure and steady them',
  open_up: 'opening up — being vulnerable and sincere',
  apologize: 'apologizing — owning a misstep',
};

/** Coerce an unknown value to a canonical Intent, or null if it isn't one. */
export function toIntent(value: unknown): Intent | null {
  return typeof value === 'string' && (INTENTS as readonly string[]).includes(value)
    ? (value as Intent)
    : null;
}

/** Below this tension there is nothing to repair, so the repair chips stay hidden. */
export const INTENT_REPAIR_TENSION = 20;

/**
 * Which intent chips to OFFER given the current relationship state. The three
 * "connection" moves are always available — their FIT varies by warmth/tension,
 * and the judge (not this gate) decides whether they landed. The two repair
 * moves (Reassure, Apologize) surface only once there is real friction to
 * address, so a calm date isn't cluttered with an apology button. Returning the
 * repair moves first puts them under the player's thumb exactly when they matter.
 */
export function availableIntents(rel: Pick<WarmthStats, 'tension'>): Intent[] {
  const base: Intent[] = ['flirt', 'tease', 'open_up'];
  if (rel.tension >= INTENT_REPAIR_TENSION) return ['reassure', 'apologize', ...base];
  return base;
}
