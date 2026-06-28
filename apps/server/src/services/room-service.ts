import { RoomTurnSchema, type Character, type Phase, type RoomTurn } from '@dsim/shared';
import { charactersRepo, worldsRepo } from '../db/repositories';
import { ensureWorldState, assertCanAct, spendStamina } from './world-clock-service';
import { getPlacements, composeLocationScene } from './placement-service';
import { isDiscovered, stampMet } from './discovery-service';
import { stampLastSeen } from './stat-service';
import { getOrCreatePlayer } from './player-service';
import { playerIdForWorldOrDefault } from '../lib/ids';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import { recordEvent } from './event-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { notFound } from '../lib/errors';

/**
 * Location ROOM chat — the heart of discovery. A location is a single freeform text chat:
 * the model voices a narrator + every character present, and the player introduces
 * themselves / talks to anyone through natural language. Entering costs one action; the
 * model flags (structured `introduced`) when an introduction genuinely lands, and the
 * server unlocks those characters + rolls the meeting into memory.
 *
 * Stateless: the client holds the transcript AND the (day, phase) it entered on, and sends
 * them back each turn. The room is PINNED to that entry block — entering spends an action
 * (which advances the clock), but the people you walked in on don't vanish mid-visit.
 * Discovery-feature-gated by the routes.
 */

export interface RoomOccupant {
  characterId: string;
  known: boolean;
}
export interface RoomReply {
  reply: string;
  occupants: RoomOccupant[];
  introduced: string[];
  /** The (day, phase) this room is pinned to — the moment the player walked in. The
   *  client echoes these back on each `roomSay` so occupants stay stable for the visit. */
  day: number;
  phase: Phase;
}
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

function occupantsOf(here: Character[]): RoomOccupant[] {
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
  history: RoomTurnInput[];
  text: string;
}) {
  const { locationName, here, playerName, history, text } = args;
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
      .map((m) => `${m.role === 'player' ? playerName : 'Room'}: ${m.text}`)
      .join('\n') || '(just arrived)';
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
    `The player goes by "${playerName}".\n\nConversation so far:\n${transcript}\n\n` +
    `${playerName} says/does: ${text}\n\nWrite the room's response.`;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

/** Run one room turn through the model. Returns null on any failure so callers can fall
 *  back gracefully (the room must always be enterable + talkable). */
async function runRoomLlm(locName: string, here: Character[], playerName: string, history: RoomTurnInput[], text: string): Promise<RoomTurn | null> {
  try {
    const result = await callStructuredLlm(
      RoomTurnSchema,
      buildRoomMessages({ locationName: locName, here, playerName, history, text }),
      { settings: getLlmSettings(), task: `Voice ${locName} for the player.`, schemaName: 'RoomTurn' },
    );
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

/** Enter a location's chat: snapshot who's here NOW, spend one action (advancing the
 *  clock), and open with an LLM-authored arrival scene (templated fallback). */
export async function enterRoom(worldId: string, locationId: string): Promise<RoomReply> {
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
    [],
    '(The player has just walked in. Set the scene and let anyone present react — no one has been introduced yet.)',
  );
  const reply = llm ? scrubUnmetNames(llm.reply, here, new Set()) : templatedOpener(loc.name, here, activities);
  return { reply, occupants: occupantsOf(here), introduced: [], day, phase };
}

/** One room turn, pinned to the (day, phase) the player entered on. Flagged introductions
 *  unlock the character (revealed + dateable) and roll the meeting into their memory. */
export async function roomSay(
  worldId: string,
  locationId: string,
  day: number,
  phase: Phase,
  history: RoomTurnInput[],
  text: string,
): Promise<RoomReply> {
  const loc = locationOf(worldId, locationId);
  const here = occupantsAt(worldId, day, phase, locationId);
  const playerName = getOrCreatePlayer(playerIdForWorldOrDefault(worldId)).name;

  const llm = await runRoomLlm(loc.name, here, playerName, history, text);
  if (!llm) {
    return { reply: 'The room carries on around you.', occupants: occupantsOf(here), introduced: [], day, phase };
  }

  const hereIds = new Set(here.map((c) => c.id));
  const introduced = [...new Set(llm.introduced)].filter((id) => hereIds.has(id) && !isDiscovered(id));
  const introducedSet = new Set(introduced);
  for (const id of introduced) {
    stampLastSeen(id, day);
    stampMet(id, day, locationId);
    const ev = recordEvent('meet', { characterId: id, locationId, day });
    addMemoriesFromEvaluation(id, [{ text: `Met ${playerName} at ${loc.name}.`, importance: 2, tags: ['met_people'] }], ev.id);
  }

  return { reply: scrubUnmetNames(llm.reply, here, introducedSet), occupants: occupantsOf(here), introduced, day, phase };
}
