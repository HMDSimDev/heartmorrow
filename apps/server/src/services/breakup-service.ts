import {
  BREAKUP_HARD_MARGIN,
  LAST_SEEN_FLAG,
  RECONCILE_COOLDOWN_DAYS,
  RECONCILE_WARMTH,
  RELATIONSHIP_STATUS_LABELS,
  ROCKS_GRACE_DAYS,
  breakupThresholdFor,
  currentStatus,
  isBrokenUp,
  isOnTheRocks,
  neglectTuningFor,
  warmthOf,
  type ConversationMode,
  type Relationship,
  type RelationshipStatus,
} from '@dsim/shared';
import { getCharacter } from './character-service';
import { getRelationship } from './relationship-service';
import { applyRelationshipChange, setRelationshipFlag } from './stat-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { appendChronicleLine } from './chronicle-service';
import { despairFromBreakup } from './crisis-service';
import { recordEvent } from './event-service';

/**
 * The relationship "endgame" state machine: commitment is not a finish line.
 * Committed relationships must be SUSTAINED — bad dates, sustained tension, or
 * prolonged neglect push them "on the rocks" (a warning), then break them up if
 * not repaired. A broken-up character goes cold but can be won back after a
 * cooldown — though each breakup scars the bond (stiffer thresholds next time).
 *
 * The SERVER owns every transition + stat consequence here; the actual breakup /
 * warning / reconciliation TEXT is rendered later by the phone text channel
 * (this service only queues a `beat:pending` flag). No LLM call lives here.
 */

export type StrainTrigger = 'date' | 'neglect';

export interface StrainOutcome {
  /** broke_up: a committed relationship just ended. on_the_rocks: a warning state.
   *  steadied: an on-the-rocks date pulled back from the brink. reconciled: a
   *  broken-up character got back together. none: no change. */
  kind: 'broke_up' | 'on_the_rocks' | 'steadied' | 'reconciled' | 'none';
  /** The committed status that ended (only for `broke_up`). */
  fromStatus?: RelationshipStatus;
  /** A short player-facing summary line (banner/recap). */
  line?: string;
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

/**
 * Evaluate where a relationship stands after a date or a day of neglect, and
 * transition it (healthy ⇄ on-the-rocks → broken-up, or broken-up → reconciled).
 * Idempotent-ish: re-running on the same state only escalates when the on-the-
 * rocks grace has elapsed. Call this AFTER the caller has applied that turn's
 * stat deltas (so it reads the post-change relationship). World-bound only.
 */
export function evaluateRelationshipStrain(
  characterId: string,
  ctx: { day: number; trigger: StrainTrigger; mode?: ConversationMode },
): StrainOutcome {
  const rel = getRelationship(characterId);

  // A broken-up character can ONLY get back together through a deliberate
  // reconciliation DATE (after the cooldown) — never passively. The day-advance
  // neglect pass must NEVER auto-reconcile someone you're ignoring; if it did,
  // residual warmth from the old relationship (which doesn't decay while broken
  // up) would silently patch things up behind the player's back.
  if (isBrokenUp(rel)) return ctx.trigger === 'date' ? maybeReconcile(characterId, rel, ctx.day) : { kind: 'none' };

  const status = currentStatus(rel);
  if (status === 'none') return { kind: 'none' }; // uncommitted: only cools off via neglect decay

  const priorBreakups = num(rel.flags['breakup:count']);
  const threshold = breakupThresholdFor(status, priorBreakups);
  if (!threshold) return { kind: 'none' };

  const warmth = warmthOf(rel);
  const lastSeen = rel.flags[LAST_SEEN_FLAG];
  const daysSinceSeen = typeof lastSeen === 'number' ? Math.max(0, ctx.day - lastSeen) : 0;
  const { graceDays } = neglectTuningFor(status);

  // Why the relationship is failing — warmth crater, tension spike, or (neglect
  // pass only) simply being ignored past the status's grace window.
  const coldEnough = warmth < threshold.warmthFloor;
  const tenseEnough = rel.tension > threshold.tensionCeil;
  const neglectedTooLong = ctx.trigger === 'neglect' && daysSinceSeen >= graceDays;
  const inTrouble = coldEnough || tenseEnough || neglectedTooLong;

  if (!inTrouble) {
    // Recovered: a date (or repaired warmth) pulled them back from the brink.
    if (isOnTheRocks(rel)) {
      setRelationshipFlag(characterId, 'state:onTheRocks', false, { source: 'reconcile' });
      setRelationshipFlag(characterId, 'rocks:since', 0, { source: 'reconcile' });
      // Cancel an un-sent "we need to talk" text — things are patched up now.
      if (rel.flags['beat:pending'] === 'rocks') setRelationshipFlag(characterId, 'beat:pending', '', { source: 'reconcile' });
      recordEvent('relationship_steadied', { characterId, status, day: ctx.day });
      return { kind: 'steadied', line: `Things feel steady with ${getCharacter(characterId).name} again.` };
    }
    return { kind: 'none' };
  }

  // A catastrophic single date (warmth/tension far past the line) ends it on the
  // spot — no warning. Neglect always goes through the on-the-rocks warning first.
  const catastrophic =
    ctx.trigger === 'date' &&
    (warmth < threshold.warmthFloor - BREAKUP_HARD_MARGIN || rel.tension > threshold.tensionCeil + BREAKUP_HARD_MARGIN);

  if (isOnTheRocks(rel)) {
    const since = num(rel.flags['rocks:since']);
    if (catastrophic || ctx.day - since >= ROCKS_GRACE_DAYS) {
      return breakUp(characterId, status, ctx.day);
    }
    return { kind: 'on_the_rocks' }; // still on the rocks, grace not yet elapsed
  }

  if (catastrophic) return breakUp(characterId, status, ctx.day);

  // First time in trouble: enter the on-the-rocks warning + queue a "we need to
  // talk" text. They have ROCKS_GRACE_DAYS to course-correct before it breaks.
  setRelationshipFlag(characterId, 'state:onTheRocks', true, { source: 'rocks' });
  setRelationshipFlag(characterId, 'rocks:since', ctx.day, { source: 'rocks' });
  setRelationshipFlag(characterId, 'beat:pending', 'rocks', { source: 'rocks' });
  recordEvent('relationship_on_the_rocks', { characterId, status, day: ctx.day });
  return { kind: 'on_the_rocks', line: `Things feel strained with ${getCharacter(characterId).name}.` };
}

/** Who initiated a breakup: the character (strain) or the player (a deliberate choice). */
export type BreakupInitiator = 'character' | 'player';

/**
 * Apply a breakup: reset the ladder, set the cold/estranged state, scar the bond,
 * record memory + chronicle + event. Shared by the strain machine (character-
 * initiated, which also queues the character's breakup TEXT) and the player-
 * initiated path (face-to-face — no text needed, and a player-voiced memory).
 */
export function applyBreakup(
  characterId: string,
  opts: { day: number; fromStatus: RelationshipStatus; initiator: BreakupInitiator; queueText?: boolean },
): { fromStatus: RelationshipStatus; breakupCount: number } {
  const { day, fromStatus, initiator, queueText = initiator === 'character' } = opts;
  const rel = getRelationship(characterId);
  const priorBreakups = num(rel.flags['breakup:count']);

  setRelationshipFlag(characterId, 'status', 'none', { source: 'breakup' });
  setRelationshipFlag(characterId, 'state:onTheRocks', false, { source: 'breakup' });
  setRelationshipFlag(characterId, 'rocks:since', 0, { source: 'breakup' });
  setRelationshipFlag(characterId, 'state:brokenUp', true, { source: 'breakup' });
  setRelationshipFlag(characterId, 'breakup:day', day, { source: 'breakup' });
  setRelationshipFlag(characterId, 'breakup:count', priorBreakups + 1, { source: 'breakup' });
  setRelationshipFlag(characterId, 'breakup:status', fromStatus, { source: 'breakup' });
  // Only a CHARACTER-initiated breakup queues a follow-up breakup text; when the
  // player ends it face-to-face, no "I think we should break up" text is sent.
  if (queueText) setRelationshipFlag(characterId, 'beat:pending', 'breakup', { source: 'breakup' });

  // A breakup leaves a mark on both sides: a cold, tense distance.
  applyRelationshipChange(characterId, { affection: -6, comfort: -8, tension: 6 }, {
    source: 'breakup',
    detail: { fromStatus, initiator },
  });

  const wasLine = fromStatus !== 'none' ? ` It ended what we had as ${RELATIONSHIP_STATUS_LABELS[fromStatus].toLowerCase()}.` : '';
  const memory = initiator === 'player' ? `I ended things between us.${wasLine}` : `We broke up.${wasLine}`;
  addMemoriesFromEvaluation(characterId, [{ text: memory, importance: 5, tags: ['breakup'] }], null);
  try {
    appendChronicleLine(characterId, day, 'date', `💔 We broke up.`, { bumpSession: false });
  } catch {
    /* chronicle is best-effort */
  }
  recordEvent('breakup', { characterId, fromStatus, day, breakupCount: priorBreakups + 1, initiator });
  // (Opt-in) repeated heartbreak feeds the despair spiral — no-op unless enabled.
  try {
    despairFromBreakup(characterId, priorBreakups, day);
  } catch {
    /* best-effort; never block a breakup */
  }
  return { fromStatus, breakupCount: priorBreakups + 1 };
}

/** Break up (character-initiated, from strain): apply + return the surfaced outcome. */
function breakUp(characterId: string, fromStatus: RelationshipStatus, day: number): StrainOutcome {
  applyBreakup(characterId, { day, fromStatus, initiator: 'character' });
  return { kind: 'broke_up', fromStatus, line: `${getCharacter(characterId).name} ended things — you've broken up.` };
}

/**
 * A broken-up character stays cold until the cooldown passes; after that, if the
 * player has kept reaching out and warmth has recovered, they get back together
 * (one rung — 'dating' — not back to where they were). The scar persists via the
 * incremented `breakup:count`, so the rekindled relationship is more fragile.
 */
function maybeReconcile(characterId: string, rel: Relationship, day: number): StrainOutcome {
  const since = rel.flags['breakup:day'];
  if (typeof since !== 'number') return { kind: 'none' };
  if (day - since < RECONCILE_COOLDOWN_DAYS) return { kind: 'none' }; // still too raw
  if (warmthOf(rel) < RECONCILE_WARMTH) return { kind: 'none' }; // not warmed back up yet

  const name = getCharacter(characterId).name;
  setRelationshipFlag(characterId, 'state:brokenUp', false, { source: 'reconcile' });
  setRelationshipFlag(characterId, 'status', 'dating', { source: 'reconcile' });
  setRelationshipFlag(characterId, 'beat:pending', 'reconcile', { source: 'reconcile' });
  addMemoriesFromEvaluation(
    characterId,
    [{ text: 'After breaking up, we found our way back to each other and decided to try again.', importance: 5, tags: ['reconcile'] }],
    null,
  );
  try {
    appendChronicleLine(characterId, day, 'date', `💗 We got back together.`, { bumpSession: false });
  } catch {
    /* chronicle is best-effort */
  }
  recordEvent('reconciled', { characterId, day });
  return { kind: 'reconciled', line: `You and ${name} are back together.` };
}
