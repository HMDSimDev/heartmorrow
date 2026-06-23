import {
  NpcKnowledgeSchema,
  WorldSimColorSchema,
  CONVERSATION_TOPIC_HINTS,
  NPC_FRICTION,
  NPC_ROMANCE,
  PLAYER_GOSSIP,
  bandIndex,
  currentStatus,
  deriveCalendar,
  frictionChance,
  isCommitted,
  isMemorialized,
  linkTo,
  mutualAttraction,
  npcAffinity,
  pickConversationTopic,
  warmthBand,
  type Character,
  type NpcEdge,
  type RomanceState,
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
import { applyRelationshipChange, setRelationshipFlag } from './stat-service';
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
  /** A frictional (cooling) run-in — the memory reads tense, not as a warm catch-up. */
  cold: boolean;
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

  // Emergent NPC romance bookkeeping. `partnerMap` is each person's current partners
  // (authored `partner` links + world-sim couples). A new romance forms only when BOTH
  // people are free to take each other: a single person always is; an already-partnered
  // person only if THEY, their new partner, AND all their existing partners are
  // polyamorous — so a poly NPC can have multiple partners (mirroring how the jealousy
  // model already exempts poly characters) while a monogamous person is never blindsided.
  // `newRomances` enforces the conservative per-day spark cap.
  const partnerMap = new Map<string, Set<string>>();
  const addPartner = (x: string, y: string) => {
    let set = partnerMap.get(x);
    if (!set) partnerMap.set(x, (set = new Set()));
    set.add(y);
  };
  for (const e of npcEdgesRepo.listByWorld(worldId)) {
    if (e.romanceState === 'together') {
      addPartner(e.aId, e.bId);
      addPartner(e.bId, e.aId);
    }
  }
  for (const c of roster) for (const l of c.links) if (l.kind === 'partner') addPartner(c.id, l.targetId);
  const isPoly = (id: string) => byId.get(id)?.relationshipStyle === 'polyamorous';
  /** Can `x` and `y` form a NEW romance without putting a monogamous person in a bind? */
  const canPair = (x: string, y: string): boolean => {
    const free = (self: string, other: string) => {
      const partners = partnerMap.get(self);
      if (!partners || partners.size === 0) return true; // single — always free to pair
      // Already partnered: only ok if self + the prospective partner + every existing
      // partner is poly (so nobody in the resulting web is a blindsided monogamist).
      return isPoly(self) && isPoly(other) && [...partners].every(isPoly);
    };
    return free(x, y) && free(y, x);
  };
  let newRomances = 0;
  let newSourings = 0;

  for (const { cand } of hits) {
    const { aId, bId } = npcPairKey(cand.a.id, cand.b.id);
    const a = byId.get(aId)!;
    const b = byId.get(bId)!;
    const existing = npcEdgesRepo.get(worldId, aId, bId);
    if (existing && existing.lastDay === simDay) continue; // already counted this day

    const meetCount = (existing?.meetCount ?? 0) + 1;
    const prevRomance: RomanceState = existing?.romanceState ?? 'none';
    const wasSoured = existing?.soured ?? false;

    // Emergent FRICTION (the cooling mirror of warmth): a clashing, world-sim-formed
    // (no authored bond) non-romance pair can have a COLD meeting that cools them instead
    // of warming — and, once they've crossed paths enough while staying icy, fall out into
    // rivals. Seeded roll; chance comes purely from authored affinity. Authored ties are
    // never soured (the world-sim doesn't override hand-authored relationships).
    const authoredTie = linkTo(a.links, b.id) ?? linkTo(b.links, a.id);
    const canSour = prevRomance === 'none' && authoredTie == null;
    const cold = canSour && rng(`friction|${worldId}|${simDay}|${aId}|${bId}`) < frictionChance(npcAffinity(a, b));
    const warmth = cold
      ? Math.max(0, (existing?.warmth ?? 0) - NPC_FRICTION.coolStep)
      : Math.min(WORLD_SIM.warmthMax, (existing?.warmth ?? 0) + WORLD_SIM.warmthStep);
    const wasPromoted = existing?.promoted ?? false;
    // A cold meeting never promotes a friendship.
    const promoted = wasPromoted || (!cold && meetCount >= WORLD_SIM.friendPromoteMeetings);
    // A cold streak that's crossed paths enough and stayed icy falls out into a rivalry.
    const soured =
      wasSoured ||
      (cold &&
        meetCount >= NPC_FRICTION.rivalMeetings &&
        warmth <= NPC_FRICTION.rivalFloor &&
        newSourings < NPC_FRICTION.maxSouringPerDay);
    const souredNow = soured && !wasSoured;
    if (souredNow) newSourings += 1;

    // Emergent romance: crush → couple, the love-side mirror of friend-promotion.
    // A crush sparks (seeded roll, scaled by authored affinity) only between two
    // unattached, mutually-attracted, not-player-committed people once their edge is
    // warm enough; a sustained crush matures into a couple. All deterministic + pure.
    let romanceState: RomanceState = prevRomance;
    let romanceSince = existing?.romanceSince ?? 0;
    let crushSparked = false;
    let coupledNow = false;
    if (
      prevRomance === 'none' &&
      !cold && // a cold meeting cools them — it doesn't also kindle a crush
      newRomances < NPC_ROMANCE.maxNewPerDay &&
      canPair(aId, bId) &&
      warmth >= NPC_ROMANCE.crushWarmth &&
      mutualAttraction(orient(a), orient(b)).mutual &&
      // Dating relationships are keyed by DEFAULT_PLAYER_ID (not the per-world gossip
      // id), so read them with getRelationship's default — a partner the player is
      // committed to is off-limits to an emergent NPC romance.
      !isCommitted(getRelationship(aId)) &&
      !isCommitted(getRelationship(bId)) &&
      rng(`romance|${worldId}|${simDay}|${aId}|${bId}`) < NPC_ROMANCE.crushBaseProb * npcAffinity(a, b)
    ) {
      romanceState = 'crush';
      romanceSince = simDay;
      crushSparked = true;
      newRomances += 1;
    } else if (
      prevRomance === 'crush' &&
      warmth >= NPC_ROMANCE.togetherWarmth &&
      // Re-check at maturation: a person can hold crush edges with several people (sparks
      // aren't capped across days), so canPair stops a second crush maturing into a second
      // couple for a monogamist (while still allowing a fully-poly web). partnerMap reflects
      // pre-existing AND in-loop couples + authored partners.
      canPair(aId, bId) &&
      // If the player committed to one of them after the crush formed, it freezes
      // (stays a crush) rather than maturing — they chose the player.
      !isCommitted(getRelationship(aId)) &&
      !isCommitted(getRelationship(bId))
    ) {
      romanceState = 'together';
      romanceSince = simDay;
      coupledNow = true;
      addPartner(aId, bId);
      addPartner(bId, aId);
    }

    const edge: NpcEdge = { worldId, aId, bId, warmth, meetCount, lastDay: simDay, promoted, romanceState, romanceSince, soured };
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
    // A COLD (frictional) meeting reads as a tense run-in, not a warm catch-up.
    const aMem = addLifeMemory(a.id, meetingMemoryStub(b.name, place, cold), 1, b.id);
    const bMem = addLifeMemory(b.id, meetingMemoryStub(a.name, place, cold), 1, a.id);
    draft.push({
      kind: 'met',
      summary: `${a.name} ran into ${b.name}${place ? ` at ${place}` : ''}.`,
      fact:
        `${a.name} (${personaTag(a)}) and ${b.name} (${personaTag(b)}), ${relation}, ` +
        `${place ? `met at ${place}` : 'crossed paths'} and ${cold ? 'it was tense — they did not really click' : CONVERSATION_TOPIC_HINTS[topic]}.`,
      scene: { aName: a.name, bName: b.name, place, aMemId: aMem.id, bMemId: bMem.id, cold },
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

    // The cooling mirror: a world-sim friendship/acquaintance that's gone cold falls out
    // into a rivalry — a recap beat + crossed life-memories (surfaces as a rival tie).
    if (souredNow) {
      recordEvent('npc_fell_out', { worldId, day: simDay, aId, bId });
      addLifeMemory(a.id, `Things with ${b.name} have gone cold.`, 2, b.id);
      addLifeMemory(b.id, `Things with ${a.name} have gone cold.`, 2, a.id);
      draft.push({
        kind: 'soured',
        summary: `${a.name} and ${b.name} have had a falling-out.`,
        fact: `${a.name} and ${b.name} have fallen out — there's friction between them now.`,
      });
    }

    // A fresh crush stays quiet — a private life-memory, no public beat. It only
    // becomes "news" once it grows into a couple.
    if (crushSparked) {
      addLifeMemory(a.id, `Catching feelings for ${b.name}.`, 2, b.id);
      addLifeMemory(b.id, `Catching feelings for ${a.name}.`, 2, a.id);
      recordEvent('npc_crush', { worldId, day: simDay, aId, bId });
    }

    // A new couple IS news: a recap beat + crossed life-memories. And if either is a
    // player love-interest who's been neglected, they get poached (the hard loss).
    if (coupledNow) {
      recordEvent('npc_coupled', { worldId, day: simDay, aId, bId, aName: a.name, bName: b.name });
      addLifeMemory(a.id, `${b.name} and I are seeing each other now.`, 3, b.id);
      addLifeMemory(b.id, `${a.name} and I are seeing each other now.`, 3, a.id);
      draft.push({
        kind: 'linked',
        summary: `${a.name} and ${b.name} are seeing each other now.`,
        fact: `${a.name} and ${b.name} have quietly started seeing each other.`,
      });
      maybePoachPlayerInterest(worldId, simDay, a, b);
      maybePoachPlayerInterest(worldId, simDay, b, a);
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
    memoriesRepo.updateText(d.scene.aMemId, composeMeetingMemory(d.scene.bName, d.scene.place, gist, d.scene.cold));
    memoriesRepo.updateText(d.scene.bMemId, composeMeetingMemory(d.scene.aName, d.scene.place, gist, d.scene.cold));
  });
  const beats: WorldSimBeat[] = draft.map((d, i) => {
    const summary = colored.get(`b${i}`)?.summary?.trim();
    return { kind: d.kind, summary: summary ? summary.slice(0, 200) : d.summary };
  });
  return { day: simDay, beats, newLinks };
}

/** The templated meeting memory before any gist (the fail-safe text). A cold run-in
 *  reads tense rather than as a friendly catch-up. */
function meetingMemoryStub(otherName: string, place: string | undefined, cold: boolean): string {
  const where = place ? ` at ${place}` : '';
  return cold ? `Crossed paths with ${otherName}${where} — it was a little tense.` : `Caught up with ${otherName}${where}.`;
}

/** Stitch a meeting gist into a first-person life memory ("Caught up with Mara at the
 *  café — talked about the gallery opening."). The gist is a neutral clause about what
 *  the pair discussed, so the same gist reads right from either side with just the
 *  other person's name swapped in. A cold meeting leads with "Crossed paths with" so the
 *  memory doesn't read as warm when the pair actually cooled. */
function composeMeetingMemory(otherName: string, place: string | undefined, gist: string, cold: boolean): string {
  const clause = gist.replace(/\s+/g, ' ').replace(/[.!?]+$/, '').trim().slice(0, 160);
  if (!clause) return meetingMemoryStub(otherName, place, cold);
  const where = place ? ` at ${place}` : '';
  const verb = cold ? 'Crossed paths with' : 'Caught up with';
  return `${verb} ${otherName}${where} — ${clause}.`;
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
    case 'roommate':
      return 'roommates';
    case 'coworker':
      return 'coworkers';
    case 'classmate':
      return 'classmates';
    case 'neighbor':
      return 'neighbors';
    case 'mentor':
    case 'mentee':
      return 'a mentor and their mentee';
    case 'crush':
      // One-sided by nature — don't out the crush as a mutual scene fact.
      return 'acquaintances';
    default:
      break;
  }
  if (promoted) return 'friends';
  if (sharePlace) return 'coworkers';
  return 'acquaintances who have crossed paths before';
}

/** A character's orientation pair, for `mutualAttraction`. */
function orient(c: Character): { gender: Character['gender']; sexuality: Character['sexuality'] } {
  return { gender: c.gender, sexuality: c.sexuality };
}

/**
 * Contested singles — "you snoozed, you lost". When NPC `x` pairs off with `partner`,
 * if the PLAYER had a real but pre-commitment romance with `x` (getting-close band or
 * warmer, not yet exclusive) AND has neglected them past the grace window, `x` is now
 * taken: a real sting to the player's bond plus a `state:seeingOther` flag (the partner's
 * name) that closes the romance route — read by the date prompt + the DTR guard.
 * Idempotent via the flag; never touches a relationship the player is committed to.
 * Fully synchronous (runs inside the pre-`markSimmed` mutation window).
 */
function maybePoachPlayerInterest(worldId: string, simDay: number, x: Character, partner: Character): void {
  // A polyamorous person pairing off doesn't drop you — they'd keep seeing you AND the
  // new partner — so there's no loss to inflict (mirrors how the jealousy model exempts
  // poly characters). Their new couple still surfaces in the web; your route stays open.
  if (x.relationshipStyle === 'polyamorous') return;
  // Dating relationships live under DEFAULT_PLAYER_ID (getRelationship's default),
  // NOT the per-world gossip id — read/write them there so the date prompt + DTR guard
  // (which both read the default) actually see the change.
  const rel = getRelationship(x.id);
  if (rel.flags['state:seeingOther']) return; // already taken — don't re-sting
  if (isCommitted(rel)) return; // exclusive/cohabiting partners are off-limits
  if (bandIndex(warmthBand(rel)) < bandIndex('getting-close')) return; // not a real interest
  const lastSeen = typeof rel.flags['lastSeenDay'] === 'number' ? rel.flags['lastSeenDay'] : -9999;
  if (simDay - lastSeen < NPC_ROMANCE.poachNeglectDays) return; // you've been seeing them — safe
  setRelationshipFlag(x.id, 'state:seeingOther', partner.name, { source: 'worldsim' });
  // A casually-dating bond that gets poached is no longer a relationship the player is
  // IN — clear the status so the date panel / Dossier don't show "Dating" alongside a
  // now-closed romance route (a coherent loss, not a contradictory half-state). They can
  // still be texted/seen as friends; the date prompt + DTR guard treat them as taken.
  if (currentStatus(rel) !== 'none') setRelationshipFlag(x.id, 'status', 'none', { source: 'worldsim' });
  applyRelationshipChange(
    x.id,
    { affection: -8, chemistry: -6, tension: 8 },
    { source: 'worldsim', detail: { poachedBy: partner.id, day: simDay } },
  );
  recordEvent('npc_poached_player_interest', { worldId, day: simDay, characterId: x.id, partnerId: partner.id });
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
