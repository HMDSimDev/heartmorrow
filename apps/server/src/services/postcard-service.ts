import {
  EmailSchema,
  PostcardSchema,
  DEFAULT_PLAYER_ID,
  POSTCARD,
  deriveCalendar,
  isBrokenUp,
  isMemorialized,
} from '@dsim/shared';
import { charactersRepo, emailsRepo } from '../db/repositories';
import { ensureRelationship, getRelationship } from './relationship-service';
import { setRelationshipFlag } from './stat-service';
import { hasDated } from './text-message-service';
import { availabilityReason, isCharacterAvailable } from './availability-service';
import { getOrCreatePlayer } from './player-service';
import { listMemories } from './memory-service';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import { buildPostcardMessages } from '../prompt/prompt-builder';
import { newId, playerIdForWorldOrDefault } from '../lib/ids';
import { recordEvent } from './event-service';
import { featureEnabled } from './world-feature-service';

/**
 * Postcards: when someone you've dated is away (unavailable) for a stretch of
 * days, they mail ONE postcard home per absence — the deliberate exception to
 * "emails never come from characters" (see email-service's sender guard, which
 * exists to stop the GENERIC generator impersonating characters; this path is
 * server-initiated and intentional).
 *
 * Availability is a pure function of (world, day, character), so the absence is
 * fully knowable: how long they've been gone AND when they'll be back — which is
 * what lets a postcard say "back on Thursday".
 */

export interface Absence {
  /** First day of the unbroken busy streak ending on the queried day. */
  since: number;
  /** Days away so far, inclusive. */
  length: number;
  /** The first upcoming day they're back, or null when out of scan range. */
  returnDay: number | null;
}

/** Pure absence math over any busy-predicate — unit-testable without the world hash. */
export function absenceOn(
  isBusy: (day: number) => boolean,
  day: number,
  opts: { lookback?: number; scanAhead?: number } = {},
): Absence | null {
  const lookback = opts.lookback ?? POSTCARD.lookbackDays;
  const scanAhead = opts.scanAhead ?? POSTCARD.returnScanDays;
  if (!isBusy(day)) return null;
  let since = day;
  while (since > 1 && day - since < lookback && isBusy(since - 1)) since -= 1;
  let returnDay: number | null = null;
  for (let d = day + 1; d <= day + scanAhead; d += 1) {
    if (!isBusy(d)) {
      returnDay = d;
      break;
    }
  }
  return { since, length: day - since + 1, returnDay };
}

/** Day-scoped reason phrasings ("out of town until TOMORROW", "packed schedule
 *  TODAY") read wrong as the cause of a MULTI-day absence — and can flatly
 *  contradict the computed return day sitting beside them in the same prompt
 *  ("until tomorrow" vs "back on Thursday"). Neutralize them; the prompt then
 *  falls back to its own "is away for a stretch". */
export function neutralizeAbsenceReason(reason: string | null): string | null {
  if (!reason) return null;
  return /\b(today|tomorrow|tonight)\b/i.test(reason) ? null : reason;
}

/** Offline fallback so an unreachable model never loses the card. */
function fallbackBody(returnPhrase: string | null): string {
  return returnPhrase
    ? `Away for a stretch — back ${returnPhrase}. Don't have too much fun without me.`
    : `Away for a stretch — not sure for how long yet. Thinking of you.`;
}

/** "on Thursday (Day 14)", derived from the season calendar. */
function returnPhraseFor(returnDay: number | null): string | null {
  if (returnDay == null) return null;
  return `on ${deriveCalendar(returnDay).dayOfWeek} (Day ${returnDay})`;
}

/**
 * Queue the day's postcards for a world. One per (character, absence): sent the
 * day an absence reaches POSTCARD.minAbsenceDays, keyed by the streak's start
 * day in the `postcard:sentSince` relationship flag (re-fires and late passes
 * are no-ops; a NEW absence sends a new card). Broken-up bonds go quiet and the
 * memorialized are left in peace (their "absence" would otherwise never end).
 */
export async function generatePostcardsForDay(
  worldId: string,
  day: number,
  playerId: string = DEFAULT_PLAYER_ID,
): Promise<void> {
  // Postcards land in the Mail app, so they ride the same per-world toggle.
  if (!featureEnabled(worldId, 'email')) return;
  const settings = getLlmSettings();
  const player = getOrCreatePlayer(playerIdForWorldOrDefault(worldId));

  for (const character of charactersRepo.listByWorld(worldId)) {
    if (!hasDated(character.id)) continue;
    const rel = ensureRelationship(character.id, playerId);
    if (isMemorialized(rel) || isBrokenUp(rel)) continue;

    const busy = (d: number) => !isCharacterAvailable(worldId, d, character.id);
    const absence = absenceOn(busy, day);
    if (!absence || absence.length < POSTCARD.minAbsenceDays) continue;
    if (rel.flags['postcard:sentSince'] === absence.since) continue; // this absence already wrote home

    const returnPhrase = returnPhraseFor(absence.returnDay);
    const result = await callStructuredLlm(
      PostcardSchema,
      buildPostcardMessages({
        character,
        relationship: rel,
        playerName: player.name,
        awayReason: neutralizeAbsenceReason(availabilityReason(worldId, day, character.id)),
        returnPhrase,
        memories: [...listMemories(character.id)]
          .sort((a, b) => (b.importance !== a.importance ? b.importance - a.importance : b.createdAt - a.createdAt))
          .slice(0, 4),
      }),
      { settings, task: `Write ${character.name}'s postcard home.`, schemaName: 'Postcard' },
    );
    const body = result.ok ? result.data.body : fallbackBody(returnPhrase);
    if (!result.ok) recordEvent('postcard_fallback', { characterId: character.id, day, error: result.error });

    // Re-check AFTER the await (an overlapping day-start / dev-route pass may
    // have sent it); the flag write + insert below are synchronous, so they
    // cannot interleave with another pass.
    if (getRelationship(character.id).flags['postcard:sentSince'] === absence.since) continue;
    setRelationshipFlag(character.id, 'postcard:sentSince', absence.since, { source: 'postcard' });

    const handleLocal = (character.name.split(/\s+/)[0] ?? 'away').toLowerCase().replace(/[^a-z0-9]/g, '') || 'away';
    const now = Date.now();
    emailsRepo.insert(
      EmailSchema.parse({
        id: newId('email'),
        playerId,
        worldId,
        senderName: character.name,
        senderHandle: `${handleLocal}@far.away`,
        kind: 'postcard',
        subject: `A postcard from ${character.name}`,
        body,
        status: 'delivered',
        read: false,
        dayNumber: day,
        scheduledPhase: null,
        deliveredAt: now,
        createdAt: now,
      }),
    );
    recordEvent('postcard_sent', { characterId: character.id, worldId, day, since: absence.since, returnDay: absence.returnDay });
  }
}
