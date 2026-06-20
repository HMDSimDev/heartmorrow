import {
  NpcKnowledgeSchema,
  WorldSimColorSchema,
  CONVERSATION_TOPIC_HINTS,
  PLAYER_GOSSIP,
  deriveCalendar,
  isMemorialized,
  linkTo,
  pickConversationTopic,
  type Character,
  type NpcEdge,
  type TopicSignals,
  type WorldSimBeat,
  type WorldSimResult,
} from '@dsim/shared';
import {
  charactersRepo,
  memoriesRepo,
  npcEdgesRepo,
  npcKnowledgeRepo,
  worldStatesRepo,
  npcPairKey,
} from '../db/repositories';
import { getRelationship } from './relationship-service';
import { getOrCreatePlayer } from './player-service';
import { recordEvent } from './event-service';
import { addLifeMemory } from './memory-service';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import { buildWorldSimMessages } from '../prompt/prompt-builder';
import { hashFloat, type SeededRandom } from '../lib/seeded-random';
import { newId, playerIdForWorldOrDefault } from '../lib/ids';

/**
 * The deterministic NPC world-sim core. Once per world-day it decides — with NO
 * LLM, purely via `hashFloat` rolls seeded by (world, day, sorted ids) — who met
 * whom, who worked, and what news propagated, then records the mutations onto the
 * DERIVED tables (npc_edges / npc_knowledge). The DECISIONS are deterministic; a
 * single batched "color" LLM call then rewrites the templated beat summaries into
 * natural prose (fail-safe: bad/timed-out output → the templated lines stand, so
 * the day always advances). Idempotent per (world, day) via the durable
 * `world_states.last_world_sim_day` guard — re-running a day is a no-op.
 */

// Server-owned tuning. All deterministic. MAX meetings/day locked at 2 (quiet start).
export const WORLD_SIM = {
  maxMeetingsPerDay: 2,
  maxWorkedBeats: 2,
  maxCandidates: 64,
  fofSampleK: 2,
  warmthStep: 4,
  warmthMax: 100,
  friendPromoteMeetings: 3,
  shareProb: 0.45,
  fidelityDecay: 25,
  fidelityFloor: 20,
  probCoworker: 0.55,
  probLink: 0.3,
  probFof: 0.12,
  /** Hard wall on the single color call so a hung LM Studio socket can't freeze Sleep. */
  colorTimeoutMs: 20000,
} as const;

interface Candidate {
  a: Character;
  b: Character;
  prob: number;
  place?: string;
}

/** A beat before coloring: the templated `summary` (fallback) + the neutral `fact`
 *  fed to the LLM. `ref` is assigned per-beat so the model's reply can be matched back.
 *  `scene` (met beats only) carries what's needed to fold the returned conversation
 *  `gist` back into BOTH participants' linked memories after the call. */
interface DraftBeat {
  kind: WorldSimBeat['kind'];
  summary: string;
  fact: string;
  scene?: MetScene;
}

/** Per-meeting bookkeeping so a returned gist can upgrade the two templated memories. */
interface MetScene {
  aName: string;
  bName: string;
  place?: string;
  /** The two `npc_life` memory ids ([A-about-B, B-about-A]) to upgrade with the gist. */
  aMemId: string;
  bMemId: string;
}

/** Simulate one in-world day for a world. Mutations are deterministic; a single
 *  batched LLM call then colors the beat summaries (fail-safe to templated). */
export async function simulateWorldDay(
  worldId: string,
  simDay: number,
  rng: SeededRandom = hashFloat,
): Promise<WorldSimResult> {
  const empty: WorldSimResult = { day: simDay, beats: [], newLinks: [] };

  const state = worldStatesRepo.get(worldId);
  if (!state) return empty; // no clock for this world yet — nothing to simulate
  // Durable idempotency: a day already simulated is a no-op (no mutation, no LLM).
  if (state.lastWorldSimDay >= simDay) return empty;

  // Roster excludes memorialized characters (out of active play).
  const roster = charactersRepo.listByWorld(worldId).filter((c) => !isMemorialized(getRelationship(c.id)));
  const byId = new Map(roster.map((c) => [c.id, c]));
  if (roster.length < 2) {
    markSimmed(worldId, simDay);
    return empty;
  }

  const cal = deriveCalendar(simDay);

  // --- Employment tick (pure): who is at work today --------------------------
  const workers = roster.filter((c) => c.employment != null && c.employment.workdays.includes(cal.dayIndex));

  // --- Build a BOUNDED candidate pair list -----------------------------------
  const candidates: Candidate[] = [];
  const seenPair = new Set<string>();
  const addCandidate = (x: Character, y: Character, prob: number, place?: string) => {
    if (x.id === y.id) return;
    const { aId, bId } = npcPairKey(x.id, y.id);
    const key = `${aId}|${bId}`;
    if (seenPair.has(key)) return;
    seenPair.add(key);
    candidates.push({ a: byId.get(aId)!, b: byId.get(bId)!, prob, place });
  };

  // 1. Coworkers who BOTH worked today, grouped by workplace (highest chance).
  const byPlace = new Map<string, Character[]>();
  for (const w of workers) {
    const arr = byPlace.get(w.employment!.place) ?? [];
    arr.push(w);
    byPlace.set(w.employment!.place, arr);
  }
  for (const [place, mates] of byPlace) {
    for (let i = 0; i < mates.length; i += 1) {
      for (let k = i + 1; k < mates.length; k += 1) addCandidate(mates[i]!, mates[k]!, WORLD_SIM.probCoworker, place);
    }
  }

  // 2. Authored-link re-encounters (friends/family/partners/exes cross paths).
  for (const c of roster) {
    for (const l of c.links) {
      const other = byId.get(l.targetId);
      if (other) addCandidate(c, other, WORLD_SIM.probLink);
    }
  }

  // 3. Sampled friends-of-friends (bounded K per node) — deterministic pick.
  for (const c of roster) {
    const picked = pickK(friendsOfFriends(c, byId), WORLD_SIM.fofSampleK, `fof|${worldId}|${simDay}|${c.id}`, rng);
    for (const oid of picked) {
      const other = byId.get(oid);
      if (other) addCandidate(c, other, WORLD_SIM.probFof);
    }
  }

  const bounded = candidates.slice(0, WORLD_SIM.maxCandidates);

  // --- Roll each candidate; keep hits; take the strongest MAX per day ---------
  const hits = bounded
    .map((cand) => {
      const { aId, bId } = npcPairKey(cand.a.id, cand.b.id);
      return { cand, roll: rng(`meet|${worldId}|${simDay}|${aId}|${bId}`) };
    })
    .filter((x) => x.roll < x.cand.prob)
    .sort((x, y) => x.roll - y.roll) // strongest (lowest roll) first — deterministic
    .slice(0, WORLD_SIM.maxMeetingsPerDay);

  const draft: DraftBeat[] = [];
  const newLinks: Array<{ a: string; b: string }> = [];

  // --- worked beats (a capped few, deterministically chosen) -----------------
  const workedSorted = [...workers].sort(
    (a, b) => rng(`worked|${worldId}|${simDay}|${a.id}`) - rng(`worked|${worldId}|${simDay}|${b.id}`),
  );
  for (const w of workedSorted.slice(0, WORLD_SIM.maxWorkedBeats)) {
    draft.push({
      kind: 'worked',
      summary: `${w.name} put in a shift as a ${w.employment!.title} at ${w.employment!.place}.`,
      fact: `${w.name} (a ${w.employment!.title}) worked a shift at ${w.employment!.place}.`,
    });
    recordEvent('npc_worked', { worldId, day: simDay, characterId: w.id, place: w.employment!.place });
  }

  // --- meetings: warmth, friend-promotion, info sharing ----------------------
  const playerId = playerIdForWorldOrDefault(worldId);
  for (const { cand } of hits) {
    const { aId, bId } = npcPairKey(cand.a.id, cand.b.id);
    const a = byId.get(aId)!;
    const b = byId.get(bId)!;
    const existing = npcEdgesRepo.get(worldId, aId, bId);
    if (existing && existing.lastDay === simDay) continue; // already counted this day

    const meetCount = (existing?.meetCount ?? 0) + 1;
    const warmth = Math.min(WORLD_SIM.warmthMax, (existing?.warmth ?? 0) + WORLD_SIM.warmthStep);
    const wasPromoted = existing?.promoted ?? false;
    const promoted = wasPromoted || meetCount >= WORLD_SIM.friendPromoteMeetings;

    const edge: NpcEdge = { worldId, aId, bId, warmth, meetCount, lastDay: simDay, promoted };
    npcEdgesRepo.upsert(edge);

    const place = cand.place;
    // What did they talk about? Chosen DETERMINISTICALLY (seeded), weighted by who
    // they are to each other and what they have going on — the server owns WHAT, the
    // scene LLM only writes the gist. 'the-player' only surfaces if one of them is
    // actually carrying word about the player worth bringing up.
    const signals = topicSignals(a, b, place, playerId);
    const topic = pickConversationTopic(signals, rng(`topic|${worldId}|${simDay}|${aId}|${bId}`));
    const relation = relationLabel(a, b, promoted, place != null);

    recordEvent('npc_meeting', { worldId, day: simDay, aId, bId, pairKey: `${aId}|${bId}`, place: place ?? null, topic });
    // Templated linked memories (upgraded with the gist after the scene call). Each
    // is tagged with the OTHER party so the pair's memories of this encounter link up.
    const aMem = addLifeMemory(a.id, `Caught up with ${b.name}${place ? ` at ${place}` : ''}.`, 1, b.id);
    const bMem = addLifeMemory(b.id, `Caught up with ${a.name}${place ? ` at ${place}` : ''}.`, 1, a.id);
    draft.push({
      kind: 'met',
      summary: `${a.name} ran into ${b.name}${place ? ` at ${place}` : ''}.`,
      fact:
        `${a.name} (${personaTag(a)}) and ${b.name} (${personaTag(b)}), ${relation}, ` +
        `${place ? `met at ${place}` : 'crossed paths'} and ${CONVERSATION_TOPIC_HINTS[topic]}.`,
      scene: { aName: a.name, bName: b.name, place, aMemId: aMem.id, bMemId: bMem.id },
    });

    if (promoted && !wasPromoted) {
      newLinks.push({ a: aId, b: bId });
      recordEvent('npc_link_created', { worldId, day: simDay, aId, bId, kind: 'friend' });
      draft.push({
        kind: 'linked',
        summary: `${a.name} and ${b.name} have grown close — they're friends now.`,
        fact: `${a.name} and ${b.name} have been spending enough time together to call themselves friends now.`,
      });
      addLifeMemory(a.id, `${b.name} has become a real friend.`, 2, b.id);
      addLifeMemory(b.id, `${a.name} has become a real friend.`, 2, a.id);
    }

    // Info sharing is deterministic: each learns the other's job, and may pass
    // along the freshest secondhand news they picked up on an EARLIER day.
    shareOnMeeting(worldId, simDay, a, b, draft, rng, playerId);
    shareOnMeeting(worldId, simDay, b, a, draft, rng, playerId);

    // When the sim decided they talked about the player, word about you actually
    // travels: whoever is carrying it tells the other (decaying with each retelling),
    // and remembers having mentioned you. This is what lets a friend later realize
    // "wait — you're the one Mara's been seeing?".
    if (topic === 'the-player') {
      sharePlayerKnowledge(worldId, simDay, a, b, playerId, place);
      sharePlayerKnowledge(worldId, simDay, b, a, playerId, place);
    }
  }

  // Mutations are done + idempotency stamped BEFORE the (read-only) scene call, so
  // a slow/failed LLM never affects the recorded world state.
  markSimmed(worldId, simDay);
  const colored = await runSceneColor(simDay, draft);
  // Fold each meeting's gist into both parties' templated memories (best-effort —
  // a missing gist just leaves the "Caught up with X." template standing).
  draft.forEach((d, i) => {
    const gist = colored.get(`b${i}`)?.gist?.trim();
    if (!d.scene || !gist) return;
    memoriesRepo.updateText(d.scene.aMemId, composeMeetingMemory(d.scene.bName, d.scene.place, gist));
    memoriesRepo.updateText(d.scene.bMemId, composeMeetingMemory(d.scene.aName, d.scene.place, gist));
  });
  const beats: WorldSimBeat[] = draft.map((d, i) => {
    const summary = colored.get(`b${i}`)?.summary?.trim();
    return { kind: d.kind, summary: summary ? summary.slice(0, 200) : d.summary };
  });
  return { day: simDay, beats, newLinks };
}

/** Stitch a meeting gist into a first-person life memory ("Caught up with Mara at the
 *  café — talked about the gallery opening."). The gist is a neutral clause about what
 *  the pair discussed, so the same gist reads right from either side with just the
 *  other person's name swapped in. */
function composeMeetingMemory(otherName: string, place: string | undefined, gist: string): string {
  const clause = gist.replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim().slice(0, 160);
  const where = place ? ` at ${place}` : '';
  return clause ? `Caught up with ${otherName}${where} — ${clause}.` : `Caught up with ${otherName}${where}.`;
}

/**
 * The ONE batched LLM call: rewrite each templated draft beat into a natural line
 * and, for meetings, return a short `gist` of what they talked about (grounded in
 * the topic + personalities the server already chose). Fail-safe — bad/timed-out
 * output yields an EMPTY map, so every beat keeps its template and every memory
 * keeps its "Caught up with X." line; the day always advances. The model can only
 * key off refs we sent, so it can never invent people or events.
 */
async function runSceneColor(
  day: number,
  draft: DraftBeat[],
): Promise<Map<string, { summary?: string; gist?: string }>> {
  if (draft.length === 0) return new Map();
  const items = draft.map((d, i) => ({ ref: `b${i}`, fact: d.fact }));
  const settings = getLlmSettings();
  const result = await callStructuredLlm(WorldSimColorSchema, buildWorldSimMessages(day, items), {
    settings,
    task: 'Rewrite each off-screen happening as one natural line; for meetings, add a short gist.',
    schemaName: 'WorldSimColor',
    maxRetries: 1,
    // Up to 16 lines (each a summary + optional gist); floor headroom so a
    // user-lowered default can't truncate the batch (failure → templated lines).
    maxTokens: Math.max(settings.maxTokens, 3000),
    signal: AbortSignal.timeout(WORLD_SIM.colorTimeoutMs),
  });
  if (!result.ok) {
    recordEvent('world_sim_color_failed', { day, error: result.error });
    return new Map();
  }
  return new Map(result.data.lines.map((l) => [l.ref, { summary: l.summary, gist: l.gist }] as const));
}

// --- internals --------------------------------------------------------------

/** Stamp the world as simulated for `simDay`, re-reading fresh state first so we
 *  never clobber a concurrent day/stamina write (advanceDay updates just before). */
function markSimmed(worldId: string, simDay: number): void {
  const fresh = worldStatesRepo.get(worldId);
  if (!fresh || fresh.lastWorldSimDay >= simDay) return;
  worldStatesRepo.update({ ...fresh, lastWorldSimDay: simDay, updatedAt: Date.now() });
}

/** Ids of the character's friends' friends (excluding self + direct connections). */
function friendsOfFriends(c: Character, byId: Map<string, Character>): string[] {
  const direct = new Set<string>([c.id, ...c.links.map((l) => l.targetId)]);
  const out = new Set<string>();
  for (const l of c.links) {
    const friend = byId.get(l.targetId);
    if (!friend) continue;
    for (const fl of friend.links) {
      if (!direct.has(fl.targetId) && byId.has(fl.targetId)) out.add(fl.targetId);
    }
  }
  return [...out];
}

/** Deterministically take K ids, ordered by a seeded roll per id. */
function pickK(ids: string[], k: number, seed: string, rng: SeededRandom): string[] {
  return [...ids].sort((x, y) => rng(`${seed}|${x}`) - rng(`${seed}|${y}`)).slice(0, k);
}

/** A compact, neutral persona tag for the scene LLM (DATA, not free rein) — the
 *  shortest authored hook we have, truncated. Always non-empty. */
function personaTag(c: Character): string {
  const raw =
    c.shortDescription?.trim() ||
    c.personality?.split(/[.;\n]/)[0]?.trim() ||
    c.likes[0]?.trim() ||
    c.employment?.title?.trim() ||
    'a local';
  return raw.replace(/\s+/g, ' ').slice(0, 50);
}

/** How the pair reads to each other, for the scene fact. Authored ties win; else a
 *  promoted edge → friends, a shared workplace → coworkers, otherwise acquaintances. */
function relationLabel(a: Character, b: Character, promoted: boolean, sharePlace: boolean): string {
  const kind = linkTo(a.links, b.id)?.kind ?? linkTo(b.links, a.id)?.kind ?? null;
  switch (kind) {
    case 'partner':
      return 'partners';
    case 'ex':
      return 'exes';
    case 'family':
      return 'family';
    case 'friend':
      return 'friends';
    case 'rival':
      return 'rivals';
    default:
      break;
  }
  if (promoted) return 'friends';
  if (sharePlace) return 'coworkers';
  return 'acquaintances who have crossed paths before';
}

/** Build the deterministic topic-weighting signals for a meeting pair. */
function topicSignals(a: Character, b: Character, place: string | undefined, playerId: string): TopicSignals {
  const relationKind = linkTo(a.links, b.id)?.kind ?? linkTo(b.links, a.id)?.kind ?? null;
  const aTargets = new Set(a.links.map((l) => l.targetId));
  const sharesMutual = b.links.some((l) => l.targetId !== a.id && aTargets.has(l.targetId));
  return {
    relationKind,
    bothEmployed: a.employment != null && b.employment != null,
    eitherHasGoals: a.goals.length > 0 || b.goals.length > 0,
    sharesMutual,
    involvesPlayer: holdsPlayerKnowledge(a.id, playerId) || holdsPlayerKnowledge(b.id, playerId),
  };
}

/** True when a character is carrying word about the player still fresh enough to bring up. */
function holdsPlayerKnowledge(characterId: string, playerId: string): boolean {
  return npcKnowledgeRepo
    .listByKnower(characterId)
    .some((k) => k.subjectId === playerId && k.fidelity >= PLAYER_GOSSIP.minFidelity);
}

/**
 * `from` mentions the player to `to`: pass along ONE fresh-enough thing `from` knows
 * about the player that `to` doesn't already hold, decaying fidelity per retelling and
 * attributing it to `from` (so `to` can later say "I heard from `from`…"). First-hand
 * OR secondhand knowledge re-shares, so word ripples outward across days until it
 * garbles below the floor. `from` remembers bringing you up. Capped so one NPC never
 * accumulates a dossier; no public town beat — your dating life stays low-key.
 */
function sharePlayerKnowledge(
  worldId: string,
  simDay: number,
  from: Character,
  to: Character,
  playerId: string,
  place: string | undefined,
): void {
  const held = npcKnowledgeRepo
    .listByKnower(from.id)
    // `day < simDay` so a fact can't teleport multiple hops in one day (mirrors shareOnMeeting).
    .filter((k) => k.subjectId === playerId && k.day < simDay && k.fidelity >= PLAYER_GOSSIP.minFidelity);
  if (held.length === 0) return;

  const toAbout = npcKnowledgeRepo.listByKnower(to.id).filter((k) => k.subjectId === playerId);
  if (toAbout.length >= PLAYER_GOSSIP.maxHeardPerCharacter) return;
  const toKnows = new Set(toAbout.map((k) => `${k.topic}|${k.claim}`));
  const top = held.find((k) => !toKnows.has(`${k.topic}|${k.claim}`));
  if (!top) return;

  npcKnowledgeRepo.insert(
    NpcKnowledgeSchema.parse({
      id: newId('know'),
      worldId,
      knowerId: to.id,
      subjectId: playerId,
      topic: top.topic,
      claim: top.claim,
      fidelity: Math.max(0, top.fidelity - PLAYER_GOSSIP.fidelityDecay),
      hops: top.hops + 1,
      sourceKnowerId: from.id,
      day: simDay,
      createdAt: Date.now(),
    }),
  );
  const playerName = getOrCreatePlayer(playerId).name;
  addLifeMemory(from.id, `Mentioned ${playerName} to ${to.name}${place ? ` at ${place}` : ''}.`, 2, to.id);
  recordEvent('player_gossip_shared', { worldId, day: simDay, fromId: from.id, toId: to.id, hops: top.hops + 1 });
}

/** `to` learns what `from` does, and may pick up one piece of `from`'s older news.
 *  Word about the PLAYER is deliberately excluded here — it's owned by
 *  {@link sharePlayerKnowledge} (attributed + topic-gated), so it never leaks through
 *  this unattributed path (which would block the attributed copy via the UNIQUE key). */
function shareOnMeeting(
  worldId: string,
  simDay: number,
  from: Character,
  to: Character,
  draft: DraftBeat[],
  rng: SeededRandom,
  playerId: string,
): void {
  // 1. Bootstrap: `to` learns `from`'s job (deduped by the UNIQUE constraint).
  if (from.employment) {
    npcKnowledgeRepo.insert(
      NpcKnowledgeSchema.parse({
        id: newId('know'),
        worldId,
        knowerId: to.id,
        subjectId: from.id,
        topic: 'job',
        claim: `${from.name} works as a ${from.employment.title} at ${from.employment.place}`,
        fidelity: 100,
        hops: 0,
        day: simDay,
        createdAt: Date.now(),
      }),
    );
  }

  // 2. Secondhand gossip: pass along the freshest thing `from` learned on an
  //    EARLIER day (day < simDay so news doesn't teleport multiple hops in a day),
  //    that isn't about `to`, that `to` doesn't already know. Gated by a roll.
  if (rng(`share|${worldId}|${simDay}|${from.id}|${to.id}`) >= WORLD_SIM.shareProb) return;
  const toKnows = new Set(npcKnowledgeRepo.listByKnower(to.id).map((k) => `${k.subjectId}|${k.topic}|${k.claim}`));
  const top = npcKnowledgeRepo
    .listByKnower(from.id)
    .find(
      (k) =>
        k.day < simDay &&
        k.subjectId !== to.id &&
        k.subjectId !== playerId && // word about the player travels via sharePlayerKnowledge only
        k.fidelity > WORLD_SIM.fidelityFloor &&
        !toKnows.has(`${k.subjectId}|${k.topic}|${k.claim}`),
    );
  if (!top) return;

  npcKnowledgeRepo.insert(
    NpcKnowledgeSchema.parse({
      id: newId('know'),
      worldId,
      knowerId: to.id,
      subjectId: top.subjectId,
      topic: top.topic,
      claim: top.claim,
      fidelity: Math.max(0, top.fidelity - WORLD_SIM.fidelityDecay),
      hops: top.hops + 1,
      sourceCanonId: top.sourceCanonId,
      sourceKnowerId: from.id, // attribute the retelling to the immediate teller (each hop)
      day: simDay,
      createdAt: Date.now(),
    }),
  );
  const subjName = top.subjectId ? charactersRepo.get(top.subjectId)?.name ?? 'someone' : 'someone';
  draft.push({
    kind: 'shared',
    summary: `${from.name} caught ${to.name} up on ${subjName}.`,
    fact: `${from.name} passed some news along to ${to.name} about ${subjName}.`,
  });
}
