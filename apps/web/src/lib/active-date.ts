import type { ActiveDate } from '@dsim/shared';

/** Human-readable attendee list for resume badges and action-lock messages. The
 *  fallback keeps the web client compatible with a server from before roster reads. */
export function activeDateParticipantNames(date: ActiveDate): string {
  const names = date.participants?.map((participant) => participant.characterName).filter(Boolean) ?? [];
  return new Intl.ListFormat(undefined, { style: 'long', type: 'conjunction' }).format(
    names.length > 0 ? names : [date.characterName],
  );
}
