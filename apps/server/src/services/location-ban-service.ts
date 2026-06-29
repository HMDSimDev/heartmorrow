import { eventsRepo } from '../db/repositories';
import { badRequest } from '../lib/errors';

/**
 * Per-LOCATION bans: getting thrown out of an Around Town room (see room-service's
 * ejection handling) locks the player out of that ONE place for a few in-world days.
 * The first time you're ejected from a place it's `BAN_DAYS_FIRST`; any further
 * ejection from that SAME place escalates to `BAN_DAYS_REPEAT` and stays there.
 *
 * State is DERIVED from the `ejected` game events (each carries the venue + the day it
 * happened), so there is no extra table to migrate and a progress reset clears bans for
 * free. Both entering the room AND starting a date at the venue honor the ban.
 */
export const BAN_DAYS_FIRST = 3;
export const BAN_DAYS_REPEAT = 7;

/** The in-world days the player was ejected from this location (oldest → newest). */
function ejectionDays(worldId: string, locationId: string): number[] {
  return eventsRepo
    .listByWorldType(worldId, 'ejected')
    .filter((e) => (e.payload as Record<string, unknown>)?.locationId === locationId)
    .map((e) => (e.payload as Record<string, unknown>)?.day)
    .map((d) => (typeof d === 'number' ? d : 0))
    .filter((d) => d > 0);
}

/** How many more in-world days the player is barred from this location (0 = not banned). */
export function locationBanDaysLeft(worldId: string, locationId: string, currentDay: number): number {
  const days = ejectionDays(worldId, locationId);
  if (days.length === 0) return 0;
  // First offense = short ban; a repeat offender at the same place gets the long one.
  const banLength = days.length >= 2 ? BAN_DAYS_REPEAT : BAN_DAYS_FIRST;
  const until = Math.max(...days) + banLength;
  return Math.max(0, until - currentDay);
}

/** Throw a friendly error if the player is currently barred from this location. */
export function assertNotBanned(worldId: string, locationId: string, locationName: string, currentDay: number): void {
  const left = locationBanDaysLeft(worldId, locationId, currentDay);
  if (left > 0) {
    throw badRequest(
      `You've been kicked out of ${locationName} — you can't go back for ${left} more ${left === 1 ? 'day' : 'days'}.`,
    );
  }
}
