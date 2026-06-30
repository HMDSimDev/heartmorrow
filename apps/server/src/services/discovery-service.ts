import {
  ACQUAINTANCE_FLAG,
  MET_DAY_FLAG,
  MET_LOCATION_FLAG,
  GLIMPSED_FLAG_PREFIX,
  type AcquaintanceStage,
  type Character,
  type ConversationMode,
} from '@dsim/shared';
import { getRelationship } from './relationship-service';
import { setRelationshipFlag } from './stat-service';
import { getLlmSettings } from './settings-service';
import { charactersRepo } from '../db/repositories';
import { badRequest } from '../lib/errors';

/**
 * Location-based discovery: the player's acquaintance state with a character, stored
 * in the relationship's `flags`. Keyed exactly like every other relationship signal
 * (DEFAULT_PLAYER_ID, world-isolated via characterId — see migrate-player-identity),
 * so a Meet's stat nudge and the unlock it grants always land on the SAME row.
 *
 * Whether discovery is ACTIVE is a GLOBAL player choice (`LlmSettings.discoveryMode`),
 * not a per-world property — so every redaction/gate below keys off that one toggle.
 * With it off these are inert (stage is just 'unknown' and nothing is hidden).
 */

function stageOf(raw: unknown): AcquaintanceStage {
  return raw === 'acquaintance' || raw === 'glimpsed' ? raw : 'unknown';
}

/** The player's acquaintance stage with a character ('unknown' if never met). */
export function getAcquaintanceStage(characterId: string): AcquaintanceStage {
  return stageOf(getRelationship(characterId).flags[ACQUAINTANCE_FLAG]);
}

/** True once the player has introduced themselves (revealed in People + dateable). */
export function isDiscovered(characterId: string): boolean {
  return getAcquaintanceStage(characterId) === 'acquaintance';
}

/** Whether location-based discovery (must-meet-people) is active. A GLOBAL player
 *  setting now — the `worldId` arg is accepted for call-site stability but ignored,
 *  since no world decides this any longer. */
export function discoveryEnabled(_worldId?: string | null): boolean {
  return getLlmSettings().discoveryMode;
}

/** True when a character must be hidden behind ??? for the player: discovery is on for
 *  their world AND the player hasn't met them. The single redaction predicate threaded
 *  through every player-facing surface (People / Dossier / feed / gossip / recap). */
export function isRedacted(worldId: string | null | undefined, characterId: string): boolean {
  return discoveryEnabled(worldId) && !isDiscovered(characterId);
}

/** Ids of every character in a world the player has met — the client's People tab uses
 *  this to render ??? for the rest (mirrors the memorial-ids list). */
export function listDiscoveredCharacterIds(worldId: string): string[] {
  return charactersRepo.listByWorld(worldId).filter((c) => isDiscovered(c.id)).map((c) => c.id);
}

/** Discovery read-model for a character: stage + where/when you met. */
export function getDiscoveryState(characterId: string): {
  stage: AcquaintanceStage;
  metDay: number | null;
  metAtLocationId: string | null;
} {
  const flags = getRelationship(characterId).flags;
  const metDay = typeof flags[MET_DAY_FLAG] === 'number' ? (flags[MET_DAY_FLAG] as number) : null;
  const metLoc = flags[MET_LOCATION_FLAG];
  return {
    stage: stageOf(flags[ACQUAINTANCE_FLAG]),
    metDay,
    metAtLocationId: typeof metLoc === 'string' ? metLoc : null,
  };
}

/** Record an introduction: the character becomes an acquaintance (revealed + dateable). */
export function stampMet(characterId: string, day: number, locationId: string | null): void {
  setRelationshipFlag(characterId, ACQUAINTANCE_FLAG, 'acquaintance', { source: 'discovery' });
  setRelationshipFlag(characterId, MET_DAY_FLAG, day, { source: 'discovery' });
  if (locationId) setRelationshipFlag(characterId, MET_LOCATION_FLAG, locationId, { source: 'discovery' });
}

/**
 * Record a sighting at a location (a discovery lead) without speaking. Leaves a
 * per-location breadcrumb flag and, for an as-yet-unknown character, advances the
 * stage to 'glimpsed'. Never downgrades an existing acquaintance.
 */
export function stampGlimpsed(characterId: string, locationId: string): void {
  setRelationshipFlag(characterId, `${GLIMPSED_FLAG_PREFIX}${locationId}`, true, { source: 'discovery' });
  if (getAcquaintanceStage(characterId) === 'unknown') {
    setRelationshipFlag(characterId, ACQUAINTANCE_FLAG, 'glimpsed', { source: 'discovery' });
  }
}

/**
 * When discovery is on for a character's world, gate STARTING a conversation on having
 * met them: you can't date, chat with, or run an event for a stranger. The introduction
 * itself (mode 'meet') is always allowed — that's how you become an acquaintance — and
 * dating additionally requires the character be dateable (not a fixture NPC). No-op when
 * discovery is off, so non-discovery worlds behave exactly as before.
 */
export function assertDiscoveryCanStart(character: Character, mode: ConversationMode): void {
  if (!character.worldId || !discoveryEnabled()) return;
  if (mode === 'meet') return;
  if (getAcquaintanceStage(character.id) !== 'acquaintance') {
    throw badRequest(`You haven't met ${character.name} yet.`);
  }
  if ((mode === 'date' || mode === 'event') && !character.dateable) {
    throw badRequest(`${character.name} isn't someone you can date.`);
  }
}

/** Throw (without naming them) if discovery is on and the player hasn't met this character.
 *  The shared gate for interactions outside the conversation flow (Together activities,
 *  bonding minigames). No-op when discovery is off. */
export function assertMet(character: Character): void {
  if (isRedacted(character.worldId, character.id)) {
    throw badRequest("You haven't met them yet.");
  }
}
