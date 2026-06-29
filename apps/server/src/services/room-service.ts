import {
  RoomTurnSchema,
  WARMTH_BANDS,
  RELATIONSHIP_STATUS_LABELS,
  warmthBand,
  currentStatus,
  type ActiveRoom,
  type Character,
  type CharacterLinkKind,
  type Location,
  type Phase,
  type RoomMessage,
  type RoomSession,
  type RoomTurn,
} from '@dsim/shared';
import { charactersRepo, roomSessionsRepo, worldsRepo } from '../db/repositories';
import { ensureWorldState, assertCanAct, spendStamina } from './world-clock-service';
import { getPlacements, composeLocationScene, type LocationScene } from './placement-service';
import { getSocialWeb } from './character-service';
import { getRelationship } from './relationship-service';
import { selectTopMemories } from './memory-service';
import { weatherForDay } from './ambiance-service';
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

/**
 * Symmetric social ties AMONG the people currently present (authored links + world-sim
 * edges — the same web the co-presence clustering uses). Anyone not in another's map is
 * a STRANGER to them: merely sharing the space, not a group. Lets the room prompt color
 * who actually knows whom instead of treating every co-present person as a clique.
 */
function tiesAmong(worldId: string, here: Character[]): Map<string, Map<string, CharacterLinkKind>> {
  const present = new Set(here.map((c) => c.id));
  const out = new Map<string, Map<string, CharacterLinkKind>>();
  const add = (a: string, b: string, kind: CharacterLinkKind) => {
    let m = out.get(a);
    if (!m) out.set(a, (m = new Map()));
    if (!m.has(b)) m.set(b, kind); // first (highest-precedence) tie wins
  };
  for (const node of getSocialWeb(worldId).nodes) {
    if (!present.has(node.id)) continue;
    for (const tie of node.ties) {
      if (!present.has(tie.targetId)) continue;
      add(node.id, tie.targetId, tie.kind);
      add(tie.targetId, node.id, tie.kind); // "they know each other"
    }
  }
  return out;
}

/**
 * How an ALREADY-MET person stands with the player — their warmth band, their official
 * commitment status (dating/exclusive/…), and one recent memory — so they greet the
 * player in keeping with real history rather than as a mild acquaintance. Relationships
 * are keyed on the default player (the unified discovery keying). Never used for unmet
 * people. Returns the "(already met — …)" name suffix and an optional "recently: …" part.
 */
function metContext(characterId: string): { standing: string; recent: string | null } {
  const rel = getRelationship(characterId);
  const band = WARMTH_BANDS.find((b) => b.key === warmthBand(rel))?.label ?? 'acquaintances';
  const status = currentStatus(rel);
  const standing =
    status !== 'none' ? `you're ${RELATIONSHIP_STATUS_LABELS[status].toLowerCase()} (${band})` : `you two are ${band}`;
  const top = selectTopMemories(characterId, 1)[0]?.text?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? '';
  return { standing, recent: top || null };
}

function templatedOpener(locName: string, here: Character[], activities: Map<string, string>): string {
  if (here.length === 0) return `You step into ${locName}. It's quiet right now — no one's around.`;
  const lines = here.map((c) =>
    isDiscovered(c.id) ? `${c.name} is ${activities.get(c.id) ?? 'here'}.` : `Someone is ${activities.get(c.id) ?? 'here'}.`,
  );
  return `You step into ${locName}. ${lines.join(' ')}`;
}

function buildRoomMessages(args: {
  worldId: string;
  loc: Location;
  day: number;
  phase: Phase;
  here: Character[];
  scene: LocationScene;
  playerName: string;
  playerNamed: boolean;
  history: RoomTurnInput[];
  text: string;
}) {
  const { worldId, loc, day, phase, here, scene, playerName, playerNamed, history, text } = args;
  const ties = tiesAmong(worldId, here);
  const factsById = new Map(scene.occupants.map((o) => [o.characterId, o]));
  const roster =
    here
      .map((c) => {
        const met = isDiscovered(c.id);
        const persona = (c.personality || c.shortDescription || '').replace(/\s+/g, ' ').slice(0, 200);
        const speech = (c.speechStyle || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const facts = factsById.get(c.id);
        // Staff act as staff (a barista serving), not a patron — a key fix for the
        // "everyone forcefully introduces themselves" feel. Patrons get a stable,
        // deterministic activity so they don't change what they're doing every turn.
        const doing = facts?.atWork ? 'working here (staff/on shift)' : facts?.activity ?? 'here';
        const myTies = ties.get(c.id);
        const tieClause = myTies && myTies.size
          ? `knows here: ${[...myTies].map(([tid, kind]) => `id:${tid} (${kind})`).join(', ')}`
          : here.length > 1
            ? 'knows no one else here (a stranger to the others present)'
            : 'here alone';
        const ctx = met ? metContext(c.id) : null;
        const nameClause = met
          ? `name: ${c.name} (already met — ${ctx!.standing})`
          : `name: ${c.name} (NOT YET MET — do NOT use or reveal this name; refer to them only by description until they introduce themselves to the player, then use this exact name)`;
        const parts = [`id:${c.id}`, nameClause, persona];
        if (speech) parts.push(`speech: ${speech}`);
        if (ctx?.recent) parts.push(`recently: ${ctx.recent}`);
        parts.push(`doing: ${doing}`, tieClause);
        return `- ${parts.join(' | ')}`;
      })
      .join('\n') || '(no one is here)';
  // Who is actually TOGETHER right now (a tied pair/group sharing this block) — so the
  // model can open on them mid-interaction instead of as separate idlers.
  const groups = scene.clusters.filter((cl) => cl.memberIds.length >= 2);
  const togetherLine = groups.length
    ? `\n\nHere TOGETHER right now (already in each other's company — you may walk in on them mid-conversation): ${groups
        .map((g) => `[${g.memberIds.map((id) => `id:${id}`).join(' + ')}]`)
        .join('; ')}`
    : '';
  const desc = (loc.description || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const vibe = loc.tags.length ? ` Vibe: ${loc.tags.slice(0, 6).join(', ')}.` : '';
  const setting =
    `Setting: ${loc.name}, a ${loc.kind}.${desc ? ` ${desc}` : ''}${vibe} ` +
    `Time: ${phase}, ${weatherForDay(worldId, day).label.toLowerCase()}.`;
  const transcript =
    history
      .slice(-12)
      .map((m) => `${m.role === 'player' ? 'Player' : 'Room'}: ${m.text}`)
      .join('\n') || '(just arrived)';
  // The player's name is known to anyone they've ALREADY MET (they know the player from
  // before), and to everyone once the player says it this visit — but never to a stranger
  // until the player introduces themselves.
  const nameKnown = playerNameKnown(here, playerNamed);
  const playerLine = nameKnown
    ? `The player's name is "${playerName}". People here who have ALREADY MET the player know it and use it naturally; anyone NOT yet met must NOT use the player's name until the player introduces themselves (set "playerIntroduced" true the turn they do).`
    : `The player has NOT told anyone here their name yet — NO ONE present knows it. Address the player only as "you" (or a description); do NOT use or guess the player's name until they state it. When the player DOES tell the room their name this turn, set "playerIntroduced" to true.`;
  const system =
    'You run a LOCATION in a dating sim. You voice the NARRATOR and the people present, addressing ' +
    'the player as "you" in short, evocative in-world prose (2–5 sentences). The player talks to people ' +
    'here in natural language. ' +
    'FOCUS: respond as ONLY the person (or people) the player is actually addressing or interacting with — ' +
    'usually just ONE person speaks per turn. Everyone else stays in the background: they do NOT interject, ' +
    'pile on, or introduce themselves just because the player walked in or is talking to someone else. A ' +
    'bystander speaks only when there is a natural, earned reason (directly addressed, spoken about, or the ' +
    'moment plainly pulls them in). No one forces an introduction — a stranger introduces themselves only ' +
    'when the player actually turns to engage them. ' +
    'RULES: only the listed people are present — NEVER invent anyone else, and NEVER invent a name. ' +
    'A person whose roster line says "already met" is someone the player KNOWS — refer to them by their ' +
    'real name right away (NEVER call a person the player has already met "a woman" / "a man" / "someone"). ' +
    'A person marked NOT YET MET must be referred to only by description (e.g. "the woman reading"), NEVER ' +
    'by name, until they introduce themselves to the player THIS turn. ' +
    'CONNECTIONS (the social graph): each roster line\'s "knows here" is the COMPLETE list of who that ' +
    'person already knows among those present, and how. It is the ONLY source of who-knows-whom here. If ' +
    'two people are not listed as connected — or NObody lists any connection at all (an empty graph) — ' +
    'then they do NOT know each other. DEFAULT TO STRANGERS: assume people are unacquainted unless the ' +
    'graph says otherwise. Strangers are independently present, NOT a group — they sit and act separately ' +
    'and do not talk to, sit with, or behave familiarly toward each other (each still reacts to the player ' +
    'on their own). Only where a connection IS listed do those two know each other; color that interaction ' +
    'by the relationship (partners affectionate, rivals cold, exes awkward, friends easy, etc.). People ' +
    'listed under "Here TOGETHER right now" are actively in each other\'s company this moment — the player ' +
    'may walk in on them mid-conversation, and they naturally interact with each other (still per FOCUS — ' +
    'don\'t let their banter hijack a turn where the player addresses someone else). ' +
    'When the player and a present person genuinely exchange names / introduce themselves, use that ' +
    'person\'s real name from the roster and put their id in "introduced". ' +
    'GROUNDING: keep the scene consistent — honor each person\'s "doing" (don\'t reinvent what they are ' +
    'up to), treat staff as staff (they serve; they do not chat the player up like a fellow patron), let ' +
    'each voice match their "speech", and match the setting + time of day. People you have ALREADY MET ' +
    'should treat the player according to the standing (and any "recently:" memory) noted on their line. ' +
    'Return JSON per the schema.';
  const user =
    `${setting}\n\nPeople present:\n${roster}${togetherLine}\n\n` +
    `${playerLine}\n\nConversation so far:\n${transcript}\n\n` +
    `The player says/does: ${text}\n\nWrite the room's response.`;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

/** Run one room turn through the model. Returns null on any failure so callers can fall
 *  back gracefully (the room must always be enterable + talkable). */
async function runRoomLlm(args: {
  worldId: string;
  loc: Location;
  day: number;
  phase: Phase;
  here: Character[];
  scene: LocationScene;
  playerName: string;
  playerNamed: boolean;
  history: RoomTurnInput[];
  text: string;
}): Promise<RoomTurn | null> {
  try {
    const result = await callStructuredLlm(
      RoomTurnSchema,
      buildRoomMessages(args),
      { settings: getLlmSettings(), task: `Voice ${args.loc.name} for the player.`, schemaName: 'RoomTurn' },
    );
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

/** Whether the player's name is known to anyone present — true if a met person is here
 *  (they know the player from before) or the player has stated it this visit. Strangers
 *  in a room of strangers never know it until the player introduces themselves. */
function playerNameKnown(here: Character[], playerNamed: boolean): boolean {
  return playerNamed || here.some((c) => isDiscovered(c.id));
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
  const playerName = getOrCreatePlayer(playerIdForWorldOrDefault(worldId)).name;
  // The action (advances the clock); the room stays pinned to `day`/`phase` above.
  spendStamina(worldId, 1);
  const llm = await runRoomLlm({
    worldId,
    loc,
    day,
    phase,
    here,
    scene,
    playerName,
    playerNamed: false, // the player hasn't said their name on arrival
    history: [],
    text: '(The player has just walked in. Set the scene in a sentence or two — the place and who is around. Greet people the player has already met by name; describe anyone not yet met without naming them. People are absorbed in their own business; no one rushes over to greet or introduce themselves just because the player arrived.)',
  });
  let reply: string;
  if (llm) {
    reply = scrubUnmetNames(llm.reply, here, new Set());
    // A met person present already knows the player's name; only scrub it in a room of
    // strangers (who can't know it yet).
    if (!playerNameKnown(here, false)) reply = scrubPlayerName(reply, playerName);
  } else {
    reply = templatedOpener(
      loc.name,
      here,
      new Map(scene.occupants.map((o) => [o.characterId, o.atWork ? 'working here' : o.activity])),
    );
  }
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
  const scene = composeLocationScene(worldId, session.day, session.phase, session.locationId);
  const playerName = getOrCreatePlayer(playerIdForWorldOrDefault(worldId)).name;
  // The model only ever sees player/room turns — the inline 'meet' markers are UI.
  const history: RoomTurnInput[] = session.messages
    .filter((m): m is RoomMessage & { role: 'player' | 'room' } => m.role === 'player' || m.role === 'room')
    .map((m) => ({ role: m.role, text: m.text }));

  const llm = await runRoomLlm({
    worldId,
    loc,
    day: session.day,
    phase: session.phase,
    here,
    scene,
    playerName,
    playerNamed: session.playerNamed,
    history,
    text,
  });

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
    // Met people present already know the player's name; only scrub it when no one here
    // could know it yet (a room of strangers, before the player introduces themselves).
    if (!playerNameKnown(here, playerNamed)) reply = scrubPlayerName(reply, playerName);
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
