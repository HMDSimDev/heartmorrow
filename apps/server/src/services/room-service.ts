import {
  RoomTurnSchema,
  type ActiveRoom,
  type Character,
  type Phase,
  type RoomMessage,
  type RoomSession,
  type RoomTurn,
} from '@dsim/shared';
import { charactersRepo, roomSessionsRepo, worldsRepo } from '../db/repositories';
import { ensureWorldState, assertCanAct, spendStamina } from './world-clock-service';
import { getPlacements, composeLocationScene } from './placement-service';
import { isDiscovered, stampMet } from './discovery-service';
import { getActiveDateForWorld } from './conversation-service';
import { stampLastSeen } from './stat-service';
import { getOrCreatePlayer } from './player-service';
import { playerIdForWorldOrDefault, newId } from '../lib/ids';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import { recordEvent } from './event-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { badRequest, notFound } from '../lib/errors';

/**
 * Location ROOM chat — the heart of discovery. A location is a single freeform text chat:
 * the model voices a narrator + every character present, and the player introduces
 * themselves / talks to anyone through natural language. The model flags (structured
 * `introduced`) when an introduction genuinely lands, and the server unlocks those
 * characters + rolls the meeting into memory.
 *
 * SERVER-TRUTH + RESUMABLE: the room is a persisted `room_sessions` row (at most one
 * active per world). It is PINNED to the (day, phase) the player entered on — entering
 * spends an action (which advances the clock), but the people you walked in on don't
 * vanish mid-visit. Leaving the tab and returning resumes the same room; the same
 * "you're busy" lock that dates use blocks day-spending actions while you're out, and a
 * live date blocks entering a room (and vice-versa). Discovery-feature-gated by the routes.
 *
 * The PLAYER's name is withheld from the model until they tell the room (mirroring how an
 * unmet character's name is withheld from the player) — `playerNamed` flips it on.
 */

export interface RoomTurnInput {
  role: 'player' | 'room';
  text: string;
}

function occupantsAt(worldId: string, day: number, phase: Phase, locationId: string): Character[] {
  return [...getPlacements(worldId, day, phase)]
    .filter(([, p]) => p.locationId === locationId)
    .map(([id]) => charactersRepo.get(id))
    .filter((c): c is Character => !!c);
}

function locationOf(worldId: string, locationId: string) {
  const loc = worldsRepo.get(worldId)?.locations.find((l) => l.id === locationId);
  if (!loc || !loc.discoverable) throw notFound('That location is not part of this world.');
  return loc;
}

/** Defense-in-depth: strip any UNMET present character's NAME from room prose. The model
 *  is told not to name them, but identity is never left to the model's good behavior. */
function scrubUnmetNames(text: string, here: Character[], introducedNow: Set<string>): string {
  let out = text;
  for (const c of here) {
    if (!c.name || isDiscovered(c.id) || introducedNow.has(c.id)) continue;
    const re = new RegExp(c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, 'someone');
  }
  return out;
}

/** Defense-in-depth: strip the PLAYER's name from room prose while it's still secret —
 *  no one present knows it until the player says it, so the room must not use it. */
function scrubPlayerName(text: string, playerName: string): string {
  const name = playerName.trim();
  if (name.length < 2) return text;
  return text.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'you');
}

function occupantsOf(here: Character[]) {
  return here.map((c) => ({ characterId: c.id, known: isDiscovered(c.id) }));
}

function templatedOpener(locName: string, here: Character[], activities: Map<string, string>): string {
  if (here.length === 0) return `You step into ${locName}. It's quiet right now — no one's around.`;
  const lines = here.map((c) =>
    isDiscovered(c.id) ? `${c.name} is ${activities.get(c.id) ?? 'here'}.` : `Someone is ${activities.get(c.id) ?? 'here'}.`,
  );
  return `You step into ${locName}. ${lines.join(' ')}`;
}

function buildRoomMessages(args: {
  locationName: string;
  here: Character[];
  playerName: string;
  playerNamed: boolean;
  history: RoomTurnInput[];
  text: string;
}) {
  const { locationName, here, playerName, playerNamed, history, text } = args;
  const roster =
    here
      .map((c) => {
        const persona = (c.personality || c.shortDescription || '').replace(/\s+/g, ' ').slice(0, 200);
        return `- id:${c.id} | ${
          isDiscovered(c.id)
            ? `name: ${c.name} (already met)`
            : `name: ${c.name} (NOT YET MET — do NOT use or reveal this name; refer to them only by description until they introduce themselves to the player, then use this exact name)`
        } | ${persona}`;
      })
      .join('\n') || '(no one is here)';
  const transcript =
    history
      .slice(-12)
      .map((m) => `${m.role === 'player' ? 'Player' : 'Room'}: ${m.text}`)
      .join('\n') || '(just arrived)';
  // The player's name is itself withheld until they introduce themselves to the room.
  const playerLine = playerNamed
    ? `The player's name is "${playerName}" — they've introduced themselves, so people here may use it.`
    : `The player has NOT told anyone here their name yet — NO ONE present knows it. Address the player only as "you" (or a description); do NOT use or guess the player's name until they state it. When the player DOES tell the room their name this turn, set "playerIntroduced" to true.`;
  const system =
    'You run a LOCATION in a dating sim. You voice the NARRATOR and EVERY person present, addressing ' +
    'the player as "you" in short, evocative in-world prose (2–5 sentences). The player talks to people ' +
    'here in natural language — let the relevant person answer in their own voice and narrate the room. ' +
    'RULES: only the listed people are present — NEVER invent anyone else. NEVER invent a name: each ' +
    "person's real name is in the roster — use it ONLY once they've introduced themselves. Anyone marked " +
    'NOT YET MET must be referred to by description (e.g. "the woman reading"), NEVER by name, until they ' +
    'introduce themselves to the player THIS turn. When the player and a present person genuinely exchange ' +
    'names / introduce themselves, use that person\'s real name from the roster and put their id in ' +
    '"introduced". Return JSON per the schema.';
  const user =
    `Location: ${locationName}\nPeople present:\n${roster}\n\n` +
    `${playerLine}\n\nConversation so far:\n${transcript}\n\n` +
    `The player says/does: ${text}\n\nWrite the room's response.`;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

/** Run one room turn through the model. Returns null on any failure so callers can fall
 *  back gracefully (the room must always be enterable + talkable). */
async function runRoomLlm(
  locName: string,
  here: Character[],
  playerName: string,
  playerNamed: boolean,
  history: RoomTurnInput[],
  text: string,
): Promise<RoomTurn | null> {
  try {
    const result = await callStructuredLlm(
      RoomTurnSchema,
      buildRoomMessages({ locationName: locName, here, playerName, playerNamed, history, text }),
      { settings: getLlmSettings(), task: `Voice ${locName} for the player.`, schemaName: 'RoomTurn' },
    );
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

/** Build the client read-model for a persisted room session: live occupants (with
 *  fresh `known` flags), the resolved venue name/photo, and the full transcript. Returns
 *  null (and ends the session) if the pinned location no longer exists. */
function composeActiveRoom(session: RoomSession): ActiveRoom | null {
  const loc = worldsRepo.get(session.worldId)?.locations.find((l) => l.id === session.locationId);
  if (!loc) {
    roomSessionsRepo.endForWorld(session.worldId);
    return null;
  }
  const here = occupantsAt(session.worldId, session.day, session.phase, session.locationId);
  return {
    sessionId: session.id,
    worldId: session.worldId,
    locationId: session.locationId,
    locationName: loc.name,
    imageAssetId: loc.imageAssetId,
    day: session.day,
    phase: session.phase,
    occupants: occupantsOf(here),
    messages: session.messages,
  };
}

/** The world's live Around Town room (for auto-resume), or null. */
export function getActiveRoom(worldId: string): ActiveRoom | null {
  const session = roomSessionsRepo.activeForWorld(worldId);
  return session ? composeActiveRoom(session) : null;
}

/**
 * Enter a location's chat. If a room is already open for this world, RESUME it (no
 * charge). Otherwise: refuse while a date is underway, snapshot who's here NOW, spend
 * one action (advancing the clock), open with an LLM-authored arrival scene (templated
 * fallback), and persist the session pinned to the entry (day, phase).
 */
export async function enterRoom(worldId: string, locationId: string): Promise<ActiveRoom> {
  const existing = roomSessionsRepo.activeForWorld(worldId);
  if (existing) {
    const resumed = composeActiveRoom(existing);
    if (resumed) return resumed; // already out and about — resume, don't re-charge
  }
  if (getActiveDateForWorld(worldId)) throw badRequest("Wrap up your date before heading out around town.");
  const loc = locationOf(worldId, locationId);
  assertCanAct(worldId);
  // Snapshot the CURRENT block BEFORE spending — the room is pinned to who's here right now.
  const state = ensureWorldState(worldId);
  const day = state.day;
  const phase = state.phase;
  const here = occupantsAt(worldId, day, phase, locationId);
  const scene = composeLocationScene(worldId, day, phase, locationId);
  const activities = new Map(scene.occupants.map((o) => [o.characterId, o.activity]));
  const playerName = getOrCreatePlayer(playerIdForWorldOrDefault(worldId)).name;
  // The action (advances the clock); the room stays pinned to `day`/`phase` above.
  spendStamina(worldId, 1);
  const llm = await runRoomLlm(
    loc.name,
    here,
    playerName,
    false, // the player hasn't said their name on arrival
    [],
    '(The player has just walked in. Set the scene and let anyone present react — no one has been introduced yet.)',
  );
  const reply = llm
    ? scrubPlayerName(scrubUnmetNames(llm.reply, here, new Set()), playerName)
    : templatedOpener(loc.name, here, activities);
  const now = Date.now();
  const session = roomSessionsRepo.insert({
    id: newId('room'),
    worldId,
    locationId,
    day,
    phase,
    messages: [{ role: 'room', text: reply }],
    playerNamed: false,
    ended: false,
    createdAt: now,
    updatedAt: now,
  });
  return composeActiveRoom(session)!;
}

/**
 * One turn in the world's live room, server-truth: history is the persisted transcript
 * (never client-supplied). Flagged introductions unlock the character (revealed +
 * dateable) and roll the meeting into their memory; once the player introduces
 * themselves the room may use their name.
 */
export async function roomSay(worldId: string, text: string): Promise<ActiveRoom> {
  const session = roomSessionsRepo.activeForWorld(worldId);
  if (!session) throw badRequest("You're not in a room right now — step into a place from Around Town first.");
  const loc = locationOf(worldId, session.locationId);
  const here = occupantsAt(worldId, session.day, session.phase, session.locationId);
  const playerName = getOrCreatePlayer(playerIdForWorldOrDefault(worldId)).name;
  // The model only ever sees player/room turns — the inline 'meet' markers are UI.
  const history: RoomTurnInput[] = session.messages
    .filter((m): m is RoomMessage & { role: 'player' | 'room' } => m.role === 'player' || m.role === 'room')
    .map((m) => ({ role: m.role, text: m.text }));

  const llm = await runRoomLlm(loc.name, here, playerName, session.playerNamed, history, text);

  const messages: RoomMessage[] = [...session.messages, { role: 'player', text }];
  let playerNamed = session.playerNamed;
  let introduced: string[] = [];

  if (!llm) {
    messages.push({ role: 'room', text: 'The room carries on around you.' });
  } else {
    playerNamed = session.playerNamed || llm.playerIntroduced;
    const hereIds = new Set(here.map((c) => c.id));
    introduced = [...new Set(llm.introduced)].filter((id) => hereIds.has(id) && !isDiscovered(id));
    const introducedSet = new Set(introduced);
    // The character only learns the player's name if the player has actually shared it.
    const metLabel = playerNamed ? playerName : 'someone new';
    for (const id of introduced) {
      stampLastSeen(id, session.day);
      stampMet(id, session.day, session.locationId);
      const ev = recordEvent('meet', { characterId: id, locationId: session.locationId, day: session.day });
      addMemoriesFromEvaluation(id, [{ text: `Met ${metLabel} at ${loc.name}.`, importance: 2, tags: ['met_people'] }], ev.id);
    }
    let reply = scrubUnmetNames(llm.reply, here, introducedSet);
    if (!playerNamed) reply = scrubPlayerName(reply, playerName);
    messages.push({ role: 'room', text: reply });
    if (introduced.length > 0) {
      const names = introduced.map((id) => charactersRepo.get(id)?.name).filter((n): n is string => !!n);
      if (names.length > 0) messages.push({ role: 'meet', text: names.join(', ') });
    }
  }

  const updated = roomSessionsRepo.update({ ...session, messages, playerNamed, updatedAt: Date.now() });
  return composeActiveRoom(updated)!;
}

/** Leave the room (end the visit) — clears the lock. Idempotent. */
export function leaveRoom(worldId: string): void {
  roomSessionsRepo.endForWorld(worldId);
}
