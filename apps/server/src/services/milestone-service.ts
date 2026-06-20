import {
  MILESTONE_BANDS,
  WARMTH_BANDS,
  bandIndex,
  warmthBand,
  type ConversationMode,
  type Milestone,
  type Relationship,
  type WarmthBandKey,
  type WarmthStats,
} from '@dsim/shared';
import { setRelationshipFlag } from './stat-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { appendChronicleLine } from './chronicle-service';
import { rippleSocialVouch } from './social-ripple-service';
import { recordEvent } from './event-service';

/**
 * Milestone copy per celebrated warmth band. `line` is the player-facing banner;
 * `memory` is the durable first-person beat written to memory + chronicle. The
 * trivial early bands have no milestone (see MILESTONE_BANDS).
 */
const MILESTONE_COPY: Partial<Record<WarmthBandKey, { line: string; memory: string }>> = {
  'getting-close': {
    line: "You've grown genuinely comfortable together — this is starting to feel like something.",
    memory: 'We grew close enough to feel genuinely comfortable around each other.',
  },
  close: {
    line: "There's no denying it now — you're close, and openly fond of each other.",
    memory: 'We became close — openly fond of each other.',
  },
  sweethearts: {
    line: "You've become sweethearts. This is the real thing.",
    memory: 'We became sweethearts.',
  },
};

/**
 * Detect an UPWARD crossing into a milestone warmth band during a date eval.
 * Fires at most one surfaced moment (the highest band newly reached), marks every
 * skipped milestone band as celebrated so a later dip-and-recross won't re-fire
 * them, writes a 5★ memory + a chronicle line, queues a next-morning text, and
 * records an event. Returns the surfaced milestone (for the end-of-date banner)
 * or null. Idempotent via the `milestone:<band>` flags.
 */
export function detectMilestoneCrossing(
  characterId: string,
  before: WarmthStats,
  after: Relationship,
  ctx: { day: number; mode: ConversationMode },
): Milestone | null {
  const fromIdx = bandIndex(warmthBand(before));
  const toIdx = bandIndex(warmthBand(after));
  if (toIdx <= fromIdx) return null; // not an upward crossing

  // Milestone bands newly crossed this session that haven't already fired.
  const crossed = MILESTONE_BANDS.filter(
    (b) => bandIndex(b) > fromIdx && bandIndex(b) <= toIdx && !after.flags[`milestone:${b}`],
  );
  if (crossed.length === 0) return null;

  // Mark all crossed bands as celebrated (skipped intermediates included).
  for (const b of crossed) setRelationshipFlag(characterId, `milestone:${b}`, true, { source: 'milestone' });

  const top = crossed[crossed.length - 1]!; // highest newly-reached band
  const copy = MILESTONE_COPY[top];
  const label = WARMTH_BANDS.find((b) => b.key === top)?.label ?? top;
  if (!copy) return null; // defensive: only celebrated bands have copy

  // Queue a next-morning text referencing the new closeness (consumed + cleared
  // by the daily-text generator).
  setRelationshipFlag(characterId, 'milestone:pendingText', top, { source: 'milestone' });
  addMemoriesFromEvaluation(characterId, [{ text: copy.memory, importance: 5, tags: ['milestone'] }], null);
  try {
    appendChronicleLine(characterId, ctx.day, ctx.mode, `💞 ${copy.memory}`, { bumpSession: false });
  } catch {
    /* chronicle is best-effort; never block ending a date */
  }
  recordEvent('milestone_reached', { characterId, band: top, label, day: ctx.day });
  // Word gets around: ripple the news through this character's social web.
  try {
    rippleSocialVouch(characterId);
  } catch {
    /* ripple is best-effort */
  }
  return { band: top, label, line: copy.line };
}
