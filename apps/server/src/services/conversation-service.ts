import {
  ConversationSessionSchema,
  type ActiveDate,
  MessageSchema,
  SessionEvaluationSchema,
  SessionSummarySchema,
  WalkoutReactionSchema,
  TurnReactionSchema,
  PlayerBreakupReactionSchema,
  PROMPT_LIMITS,
  DEFAULT_PLAYER_ID,
  LAST_SEEN_FLAG,
  KNOWLEDGE_GOSSIP_MIN_FIDELITY,
  PLAYER_GOSSIP,
  warmthBand,
  bandIndex,
  WALKOUT_PENALTY,
  WALKOUT_COOLDOWN_DAYS,
  JEALOUSY,
  JEALOUSY_COMMITTED,
  JEALOUSY_MIN_WARMTH,
  JEALOUSY_PENALTY,
  JEALOUSY_PENALTY_COMMITTED,
  warmthOf,
  DESPAIR,
  jealousyProbability,
  isCommitted,
  isBrokenUp,
  isMemorialized,
  currentStatus,
  RECONCILE_COOLDOWN_DAYS,
  linkTo,
  LINK_JEALOUSY_WEIGHT,
  CHARACTER_LINK_LABELS,
  PHASE_LABELS,
  deriveCalendar,
  intimacyAllowed,
  venueCost,
  venueDateEffect,
  propertyDateBuff,
  type Character,
  type ConversationCreate,
  type ConversationSession,
  type EndSessionResponse,
  type Intent,
  type JealousyOutcome,
  type Location,
  type Message,
  type PlayerBreakupResponse,
  type Relationship,
  type RelationshipStatus,
  type SessionWithMessages,
} from '@dsim/shared';
import { charactersRepo, chroniclesRepo, messagesRepo, npcKnowledgeRepo, relationshipsRepo, sessionsRepo, worldNotesRepo, worldStatesRepo } from '../db/repositories';
import { newId, playerIdForWorld, playerIdForWorldOrDefault } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';
import { getCharacter, listAcquaintances } from './character-service';
import { getRelationship } from './relationship-service';
import { getOrCreatePlayer, spendMoney } from './player-service';
import { selectTopMemories } from './memory-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { applyRelationshipChange, decayRelationshipBuffs, setRelationshipFlag, stampLastDate } from './stat-service';
import { assertCanAct, ensureWorldState, spendStamina } from './world-clock-service';
import { propertyVenueInfo } from './property-service';
import { getCharacterAvailability } from './availability-service';
import { recordEvent } from './event-service';
import { getLlmSettings } from './settings-service';
import { appendSessionToChronicle } from './chronicle-service';
import { detectMilestoneCrossing } from './milestone-service';
import { evaluateRelationshipStrain, applyBreakup } from './breakup-service';
import { maybeReachEnding } from './ending-service';
import { maybeExtractExFacts, listCanonFactsForPrompt } from './ex-canon-service';
import { maybeExtractPlayerFacts } from './player-fact-service';
import { adjustDespair } from './crisis-service';
import {
  dateNeedFor,
  getRapport,
  peekRapport,
  applyTurnEngagement,
  ensureRapportSeeded,
  rapportLabel,
  rapportEndEffect,
  clearRapport,
  hasLostInterest,
  RAPPORT_LEAVE_PENALTY,
} from './rapport-service';
import { weatherForDay, moodForCharacter, weatherDateEffect } from './ambiance-service';
import { getRecentTexts } from './text-message-service';
import { effectiveDatingStats } from './buffs';
import { worldsRepo } from '../db/repositories';
import {
  buildDialogueMessages,
  buildEvaluatorMessages,
  buildSummaryMessages,
  buildWalkoutReactionMessages,
  buildTurnReactionMessages,
  buildPlayerBreakupMessages,
  estimatePromptChars,
  messageText,
  type PromptContext,
} from '../prompt/prompt-builder';
import { callStructuredLlm } from '../llm/structured';
import { getAdapter } from '../llm/provider';
import type { ChatMessage } from '../llm/types';
import { ThinkStripper, stripThink } from '../lib/think-filter';

// --- session CRUD -----------------------------------------------------------

export function createSession(input: ConversationCreate): ConversationSession {
  const character = getCharacter(input.characterId); // validates existence
  // A memorialized character is gone — no further dates or chats (a kept record).
  if (isMemorialized(getRelationship(character.id))) {
    throw badRequest(`${character.name} is no longer with us.`);
  }
  // Real meetings (anything but a free-form chat) cost a daily action and require
  // the character to be available today (world-bound only). 'chat' is exempt.
  if (input.mode !== 'chat' && character.worldId) {
    const day = ensureWorldState(character.worldId).day;
    // A character who just broke up with you needs space before they'll meet
    // again — keep texting them to thaw things; the date reopens after a cooldown.
    const rel = getRelationship(character.id);
    if (isBrokenUp(rel)) {
      const since = rel.flags['breakup:day'];
      if (typeof since === 'number' && day - since < RECONCILE_COOLDOWN_DAYS) {
        throw badRequest(`${character.name} needs some space right now — give it a little time before reaching out for a date.`);
      }
    }
    const avail = getCharacterAvailability(character.worldId, day, character.id);
    if (!avail.available) {
      throw badRequest(`${character.name} ${avail.reason ?? 'is unavailable today'}.`);
    }
    assertCanAct(character.worldId);
    // Soft money gate: you can't take someone somewhere you can't afford (free
    // venues always exist, so dating itself is never blocked). The wallet is only
    // CHECKED here; it's charged when the date actually ends (mirrors stamina), so
    // an abandoned setup never costs money.
    // A property venue is only valid if you own or currently lease it — reject a
    // `prop:` location you have no claim to rather than silently degrading to a
    // locationless date.
    const loc = input.locationId ?? null;
    if (loc?.startsWith('prop:') && !propertyVenueInfo(loc, character.worldId)) {
      throw badRequest('You can only date at a place you own or lease.');
    }
    const venue = resolveSessionLocation(loc, character, worldsRepo.get(character.worldId) ?? null);
    const cost = venueCost(venue?.priceTier);
    if (cost > 0) {
      const money = getOrCreatePlayer(playerIdForWorld(character.worldId)).money;
      if (money < cost) {
        throw badRequest(
          `You can't afford ${venue?.name ?? 'this venue'} right now (it costs ${cost}, you have ${money}). Pick a cheaper spot, or earn more first.`,
        );
      }
    }
  }
  const now = Date.now();
  const session = ConversationSessionSchema.parse({
    id: newId('sess'),
    characterId: input.characterId,
    locationId: input.locationId,
    mode: input.mode,
    summary: '',
    ended: false,
    createdAt: now,
    updatedAt: now,
  });
  return sessionsRepo.insert(session);
}

export function getSession(id: string): ConversationSession {
  const s = sessionsRepo.get(id);
  if (!s) throw notFound(`Session ${id} not found.`);
  return s;
}

export function listSessions(): ConversationSession[] {
  return sessionsRepo.list();
}

export function getSessionWithMessages(id: string): SessionWithMessages {
  const session = getSession(id);
  return { session, messages: messagesRepo.listBySession(id) };
}

/**
 * The world's single live, in-progress date (if any): the most-recently-updated
 * non-ended date/event session whose character belongs to this world. Drives the
 * client's auto-resume (a date survives a navigation/refresh) and the "a date is
 * underway" lock on day-spending actions. Read-only — never mutates. Only `date`/
 * `event` sessions count — a plain `chat` or a `minigame` session is never a date.
 */
export function getActiveDateForWorld(worldId: string): ActiveDate | null {
  for (const s of sessionsRepo.listActive()) {
    if (s.mode !== 'date' && s.mode !== 'event') continue;
    const character = charactersRepo.get(s.characterId);
    if (!character || character.worldId !== worldId) continue;
    const rapport = peekRapport(s.id);
    return {
      sessionId: s.id,
      characterId: character.id,
      characterName: character.name,
      mode: s.mode,
      locationId: s.locationId,
      hasPlayerTurn: messagesRepo.hasRole(s.id, 'player'),
      rapport,
      vibe: rapport != null ? rapportLabel(rapport) : null,
      updatedAt: s.updatedAt,
    };
  }
  return null;
}

function touchSession(session: ConversationSession): ConversationSession {
  return sessionsRepo.update(ConversationSessionSchema.parse({ ...session, updatedAt: Date.now() }));
}

export function addPlayerMessage(sessionId: string, text: string, intent?: Intent): Message {
  const session = getSession(sessionId);
  const message = MessageSchema.parse({
    id: newId('msg'),
    sessionId: session.id,
    role: 'player',
    text,
    // The intent chip (if any) rides on metadata — read back by the prompt
    // builder to frame the line for the character and grade it for the judges.
    metadata: intent ? { intent } : {},
    createdAt: Date.now(),
  });
  const saved = messagesRepo.insert(message);
  touchSession(session);
  return saved;
}

function addCharacterMessage(sessionId: string, text: string, metadata: Record<string, unknown> = {}): Message {
  const message = MessageSchema.parse({
    id: newId('msg'),
    sessionId,
    role: 'character',
    text,
    metadata,
    createdAt: Date.now(),
  });
  return messagesRepo.insert(message);
}

// --- prompt context ---------------------------------------------------------

/**
 * Resolve a session's locationId to a Location. A `room:*` id is the character's
 * own private room (a virtual, always-indoor venue described by their generated
 * `roomDescription`); anything else is looked up in the world's authored locations.
 */
export function resolveSessionLocation(
  locationId: string | null,
  character: Character,
  world: { locations: Location[] } | null,
): Location | null {
  if (!locationId) return null;
  if (locationId.startsWith('room:')) {
    return {
      id: locationId,
      name: `${character.name}'s Room`,
      description: character.roomDescription?.trim() || `${character.name}'s private space — personal and comfortable.`,
      tags: ['private', 'home'],
      indoor: true,
      priceTier: 0, // staying in is always free
      imageAssetId: null,
    };
  }
  // A property you own or rent: a virtual venue synthesized from its definition. Its
  // money cost (rent fee if unowned, free if owned) + date buff are handled in
  // endSession; here priceTier stays 0 so the tier-based charge never double-bills.
  if (locationId.startsWith('prop:')) {
    const info = propertyVenueInfo(locationId, character.worldId);
    if (!info) return null;
    return {
      id: locationId,
      name: info.property.name,
      description: info.property.description?.trim() || (info.owned ? 'Your own place.' : 'A place for the night.'),
      tags: info.property.tags,
      indoor: info.property.indoor,
      priceTier: 0,
      imageAssetId: info.property.assetId ?? null,
    };
  }
  return world ? world.locations.find((l) => l.id === locationId) ?? null : null;
}

/**
 * The world-sim news this character is currently carrying, resolved for the prompt.
 * Surfaces only news ABOUT OTHER CHARACTERS (not the player — that's a later drama
 * surface), freshest first, capped. Fidelity rides along so the prompt can hedge.
 */
function heardLately(character: Character): Array<{ subjectName: string; claim: string; fidelity: number }> {
  if (!character.worldId) return [];
  const out: Array<{ subjectName: string; claim: string; fidelity: number }> = [];
  for (const k of npcKnowledgeRepo.listByKnower(character.id, 16)) {
    if (!k.subjectId || k.subjectId === DEFAULT_PLAYER_ID || k.subjectId === character.id) continue;
    // Mirror the phone gossip gate: garbled/retracted knowledge (fidelity below the
    // pass-on threshold — and especially a rejected canon fact forced to 0) is never
    // surfaced, so this dialogue surface and the gossip-text surface stay in sync.
    if (k.fidelity < KNOWLEDGE_GOSSIP_MIN_FIDELITY) continue;
    const subject = charactersRepo.get(k.subjectId);
    if (!subject || subject.worldId !== character.worldId) continue;
    out.push({ subjectName: subject.name, claim: k.claim, fidelity: k.fidelity });
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * Word about the PLAYER that has reached this character SECONDHAND (through a mutual),
 * for the "wait — you're the one Mara mentioned?" recognition beat. Deliberately the
 * mirror of {@link heardLately}'s player exclusion: we surface ONLY player-subject
 * knowledge that was passed along (`sourceKnowerId` set), never the first-hand read a
 * date partner has of you. Gated to the early bands — once you've actually grown close,
 * they know you directly and stale hearsay shouldn't resurface. Attribution rides along.
 */
function heardAboutPlayer(
  character: Character,
  relationship: Relationship,
): Array<{ tellerName: string; claim: string; fidelity: number }> {
  if (!character.worldId) return [];
  // Only while you haven't really connected yet (near-strangers → warming-up).
  if (bandIndex(warmthBand(relationship)) >= bandIndex('getting-close')) return [];
  const playerId = playerIdForWorldOrDefault(character.worldId);
  const out: Array<{ tellerName: string; claim: string; fidelity: number }> = [];
  for (const k of npcKnowledgeRepo.listByKnower(character.id, 16)) {
    if (k.subjectId !== playerId || !k.sourceKnowerId) continue; // secondhand only
    if (k.fidelity < PLAYER_GOSSIP.minFidelity) continue;
    const teller = charactersRepo.get(k.sourceKnowerId);
    if (!teller || teller.worldId !== character.worldId) continue;
    out.push({ tellerName: teller.name, claim: k.claim, fidelity: k.fidelity });
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * True when this is the player's FIRST date with the character — they've never
 * actually met, so the character can't know the player's name or anything about
 * them. Stable for the whole first date: it looks at OTHER (prior) date/event
 * sessions the player actually spoke in, and requires the relationship still be at
 * the near-strangers band (so warmth built some other way doesn't fake a stranger).
 * Plain `chat` is never a "meeting".
 */
function isFirstMeeting(session: ConversationSession, relationship: Relationship): boolean {
  if (session.mode === 'chat') return false;
  if (bandIndex(warmthBand(relationship)) > 0) return false; // already warmed up somehow
  return !sessionsRepo
    .listByCharacter(session.characterId)
    .some(
      (s) =>
        s.id !== session.id &&
        (s.mode === 'date' || s.mode === 'event') &&
        messagesRepo.hasRole(s.id, 'player'),
    );
}

export function buildPromptContextForSession(
  session: ConversationSession,
  messages: Message[],
  opts?: { turnVerdict?: TurnVerdict | null },
): PromptContext {
  const character = getCharacter(session.characterId);
  const world = character.worldId ? worldsRepo.get(character.worldId) ?? null : null;
  const relationship = getRelationship(character.id);
  const location = resolveSessionLocation(session.locationId, character, world);
  const worldState = world ? worldStatesRepo.get(world.id) ?? null : null;
  const worldDay = worldState?.day ?? null;
  const holiday = worldDay != null ? deriveCalendar(worldDay).holiday : null;

  return {
    world,
    worldNotes: world ? worldNotesRepo.listByWorld(world.id) : [],
    character,
    relationship,
    acquaintances: listAcquaintances(character),
    npcKnowledge: heardLately(character),
    playerHeardAbout: heardAboutPlayer(character, relationship),
    canonFacts: listCanonFactsForPrompt(character.id),
    effectiveDatingStats: effectiveDatingStats(character.datingStats, relationship.flags),
    memories: selectTopMemories(character.id),
    player: getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId)),
    session,
    location,
    // The venue's spend tier (date/event only) so the character can notice the
    // expense; 0 = free/anywhere. Null for plain chat.
    venueTier: location && session.mode !== 'chat' ? location.priceTier ?? 0 : null,
    recentMessages: messages,
    worldDay,
    chronicle: (() => {
      // Chronicle rows are world-isolated through the character, so they stay keyed
      // on the legacy player id (not the per-world persona id).
      const c = chroniclesRepo.getByCharacter(character.id, DEFAULT_PLAYER_ID);
      return c ? { chronicle: c.chronicle, recentLines: c.recentLines } : null;
    })(),
    nsfwEnabled: getLlmSettings().nsfwEnabled,
    weather: world && worldDay != null ? (() => { const w = weatherForDay(world.id, worldDay); return { kind: w.kind, label: w.label, icon: w.icon }; })() : null,
    characterMood:
      world && worldDay != null ? (() => { const m = moodForCharacter(world.id, worldDay, character); return { mood: m.mood, icon: m.icon }; })() : null,
    holiday: holiday ? { name: holiday.name, tag: holiday.tag } : null,
    timeOfDay: worldState ? PHASE_LABELS[worldState.phase] : null,
    dayOfWeek: worldDay != null ? deriveCalendar(worldDay).dayOfWeek : null,
    recentTexts: getRecentTexts(character.id),
    // The hidden "what they want tonight" hint — date/event only, stable per world-day.
    dateNeed:
      world && worldDay != null && session.mode !== 'chat'
        ? dateNeedFor(world.id, worldDay, character.id).behavior
        : null,
    guardedness: character.guardedness,
    turnVerdict: opts?.turnVerdict ?? null,
    firstMeeting: isFirstMeeting(session, relationship),
  };
}

/** Build the dialogue ChatMessages for a session (used by streaming + preview).
 *  An optional `turnVerdict` (the just-computed read of the player's latest message)
 *  is threaded into the prompt so the character's reply honestly reflects it. */
export function buildDialogueRequest(sessionId: string, turnVerdict?: TurnVerdict | null): ChatMessage[] {
  const session = getSession(sessionId);
  const messages = messagesRepo.listBySession(sessionId);
  const ctx = buildPromptContextForSession(session, messages, { turnVerdict });
  return buildDialogueMessages(ctx);
}

// --- dialogue (plain text) --------------------------------------------------

/** Generate a non-streamed character reply and persist it. */
export async function generateReply(sessionId: string): Promise<Message> {
  const session = getSession(sessionId);
  const settings = getLlmSettings();
  const chatMessages = buildDialogueRequest(sessionId);
  const adapter = getAdapter(settings);
  const result = await adapter.chat({
    messages: chatMessages,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
  });
  // Strip any <think>…</think> reasoning from the natural-language reply.
  const text = stripThink(result.content).trim();
  if (!text) throw badRequest('The model returned an empty reply.');
  const message = addCharacterMessage(sessionId, text);
  touchSession(session);
  return message;
}

/** Stream a character reply, forwarding token deltas. Returns the full text plus
 * the finish reason (e.g. 'length' when the model hit the token budget). Does NOT
 * persist — the caller persists via `persistStreamedReply`. */
export async function streamReply(
  sessionId: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  turnVerdict?: TurnVerdict | null,
): Promise<{ content: string; finishReason?: string }> {
  getSession(sessionId);
  const settings = getLlmSettings();
  const chatMessages = buildDialogueRequest(sessionId, turnVerdict);
  const adapter = getAdapter(settings);

  // Suppress <think>…</think> reasoning from the streamed deltas + final text.
  // While the model is "thinking", no visible delta is emitted, so the UI shows
  // its typing indicator until the real reply begins.
  const stripper = new ThinkStripper();
  const { finishReason } = await adapter.streamChat(
    { messages: chatMessages, temperature: settings.temperature, maxTokens: settings.maxTokens },
    (rawDelta) => {
      const visible = stripper.push(rawDelta);
      if (visible) onDelta(visible);
    },
    signal,
  );
  const tail = stripper.end();
  if (tail) onDelta(tail);

  return { content: stripper.visible.trim(), finishReason };
}

/** Persist a character reply that was produced by the streaming route. */
export function persistStreamedReply(sessionId: string, text: string): Message {
  const session = getSession(sessionId);
  const message = addCharacterMessage(sessionId, text.trim());
  touchSession(session);
  return message;
}

/**
 * On a FIRST date, let the character break the ice. Generates a single in-character
 * opening greeting and persists it as the date's first (character) message, so the
 * player isn't forced to open a date with a total stranger. Returns the message, or
 * null when it doesn't apply (plain chat, ended, already has turns, or not a first
 * meeting) or generation fails. Best-effort: never throws — on any failure the date
 * simply falls back to the player opening. The non-first-meeting cases short-circuit
 * BEFORE any LLM call, so a normal date pays no latency for this.
 */
export async function openConversation(sessionId: string): Promise<Message | null> {
  let session: ConversationSession;
  try {
    session = getSession(sessionId);
  } catch {
    return null;
  }
  if (session.ended || session.mode === 'chat') return null;
  if (messagesRepo.countBySession(sessionId) > 0) return null; // someone already spoke
  const character = getCharacter(session.characterId);
  if (!isFirstMeeting(session, getRelationship(character.id))) return null;

  const settings = getLlmSettings();
  try {
    const messages = buildDialogueRequest(sessionId);
    messages.push({
      role: 'system',
      content:
        `OOC stage direction: the date is just beginning and this is the first time the two of you are meeting. ` +
        `You speak first — open the conversation yourself with a warm, natural greeting in your own voice: ` +
        `say hello, introduce yourself, and break the ice however suits you. Stay true to how guarded or outgoing you are, ` +
        `and keep it to just a line or two (an opening, not a monologue). Follow everything above about what you do and don't know about them.`,
    });
    const adapter = getAdapter(settings);
    const res = await adapter.chat({ messages, temperature: settings.temperature, maxTokens: settings.maxTokens });
    const text = stripThink(res.content).trim();
    if (!text) return null;
    const message = addCharacterMessage(sessionId, text, { opener: true });
    touchSession(session);
    return message;
  } catch {
    return null; // best-effort: fall back to the player opening
  }
}

// --- Phase 3: walkouts + jealousy -------------------------------------------

const HOSTILE_RE = /\b(fuck\s*you|fuck\s*off|screw\s*you|shut\s*up|stupid|idiot|hate\s*you|bitch|asshole|loser|ugly|disgusting|pathetic|worthless)\b/i;
const PROPOSITION_RE = /\b(sleep\s*with|have\s*sex|hook\s*up|hookup|come\s*(?:over|home)|in\s*bed|nudes?|sext|strip|take.*clothes\s*off)\b/i;

/** Cheap no-LLM screen: consider a walkout only for clearly hostile messages,
 *  or crude propositions when the relationship is not warm. When the player has
 *  enabled adult content AND the relationship is advanced enough for intimacy,
 *  a proposition is welcome and never triggers a walkout — but hostility always
 *  can, and propositioning a stranger/acquaintance still does. */
function cheapWalkoutPrescreen(
  text: string,
  rel: { affection: number; trust: number; chemistry: number; comfort: number; respect: number; tension: number },
  nsfwEnabled: boolean,
): boolean {
  if (HOSTILE_RE.test(text)) return true;
  if (PROPOSITION_RE.test(text)) {
    // With adult content on, mirror the dialogue prompt exactly (same intimacy
    // gate): if intimacy is permitted the proposition is welcome (no walkout);
    // otherwise the character was told a proposition now "ends a date", so let
    // the walkout judge decide. With adult content off, keep the original
    // not-warm heuristic so non-NSFW play is unchanged.
    if (nsfwEnabled) return !intimacyAllowed(rel);
    return rel.affection < 40 || rel.comfort < 40 || rel.tension > 50;
  }
  return false;
}

export interface WalkoutOutcome {
  message: Message;
  reason: string;
}

/**
 * If the player's latest message is egregious, ask the model (structured)
 * whether the character ends the date and walks out. Returns the farewell
 * message + ends the session, or null. Rare by design; fails safe (no walkout).
 */
export async function attemptWalkout(
  sessionId: string,
  playerText: string,
  signal?: AbortSignal,
): Promise<WalkoutOutcome | null> {
  const session = getSession(sessionId);
  if (session.ended || session.mode === 'chat') return null;
  const character = getCharacter(session.characterId);
  const relationship = getRelationship(character.id);

  if (character.worldId) {
    const day = ensureWorldState(character.worldId).day;
    const last = relationship.flags['walkout:lastDay'];
    if (typeof last === 'number' && day - last < WALKOUT_COOLDOWN_DAYS) return null;
  }
  const settings = getLlmSettings();
  if (!cheapWalkoutPrescreen(playerText, relationship, settings.nsfwEnabled)) return null;

  const recent = messagesRepo.listBySession(sessionId).slice(-12);
  const result = await callStructuredLlm(
    WalkoutReactionSchema,
    buildWalkoutReactionMessages({ character, relationship, recentMessages: recent, playerName: getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId)).name }),
    { settings, task: 'Decide whether the character ends the date now.', schemaName: 'WalkoutReaction', signal },
  );
  if (!result.ok || !result.data.walkout) return null;

  applyRelationshipChange(character.id, { ...WALKOUT_PENALTY }, { source: 'walkout', detail: { reason: result.data.reason } });
  setRelationshipFlag(character.id, 'state:offended', true, { source: 'walkout' });
  if (character.worldId) {
    const wday = ensureWorldState(character.worldId).day;
    setRelationshipFlag(character.id, 'walkout:lastDay', wday, { source: 'walkout' });
    // (Opt-in) cruelty severe enough to drive a deeply-attached partner out feeds
    // the despair spiral — no-op unless enabled AND they were close to you.
    try {
      adjustDespair(character.id, DESPAIR.hostility, 'hostility', wday);
    } catch {
      /* best-effort */
    }
  }
  // A real date occurred (the player earned a walkout over real turns): spend the
  // daily action + stamp last-seen, exactly like a normally-ended date. Best-effort
  // so it never blocks the farewell (e.g. if stamina is already 0).
  if (character.worldId) {
    try {
      const wday2 = ensureWorldState(character.worldId).day;
      stampLastDate(character.id, wday2);
      if (session.mode === 'date' || session.mode === 'event') spendStamina(character.worldId);
    } catch {
      /* best-effort: a date that blew up still ends */
    }
  }
  const message = addCharacterMessage(sessionId, result.data.farewellLine.trim(), { walkout: true });
  sessionsRepo.update(ConversationSessionSchema.parse({ ...session, ended: true, updatedAt: Date.now() }));
  const walkoutDay = character.worldId ? ensureWorldState(character.worldId).day : 0;
  const walkoutEvent = recordEvent('walkout', {
    characterId: character.id,
    reason: result.data.reason,
    ...(character.worldId ? { day: walkoutDay } : {}),
  });
  // The character now REMEMBERS the blow-up. A walkout used to leave ONLY the
  // transient state:offended flag (cleared at the next date), so they'd act as if
  // nothing happened. Write a durable memory of what the player did + a chronicle
  // line, with safe fallbacks when the model omits the new fields.
  const walkoutPlayerName = getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId)).name;
  const walkoutMemory =
    result.data.memory.trim() ||
    (result.data.reason.trim()
      ? `On our date, ${walkoutPlayerName} ${result.data.reason.trim()} — I ended it and walked out.`
      : `${walkoutPlayerName} crossed a line on our date, so I ended it and left.`);
  try {
    addMemoriesFromEvaluation(
      character.id,
      [{ text: walkoutMemory.slice(0, 400), importance: 5, tags: ['conflict'] }],
      walkoutEvent.id,
    );
    const walkoutSummary =
      result.data.summaryLine.trim() || `${walkoutPlayerName} crossed a line and ${character.name} walked out of the date.`;
    appendSessionToChronicle(character.id, walkoutSummary, session.mode, walkoutDay);
  } catch {
    /* best-effort: remembering the blow-up must never block the farewell */
  }
  // Storming out of a date can strain a committed relationship onto the rocks
  // (or break it) — the walkout spiked tension above.
  if (character.worldId) {
    try {
      evaluateRelationshipStrain(character.id, { day: ensureWorldState(character.worldId).day, trigger: 'date', mode: session.mode });
    } catch {
      /* strain is best-effort */
    }
  }
  return { message, reason: result.data.reason };
}

// --- Live date dynamics (per-turn rapport) ----------------------------------

export interface TurnReadout {
  /** Qualitative read of how the date is going now (e.g. "warming to you"). */
  label: string;
  /** Expression key for the live portrait. */
  expression: string;
  /** Internal rapport value (0..100) — not shown to the player. */
  rapport: number;
  /** Signed rapport change this turn (for the UI's +N / −N flourish). */
  delta: number;
  /** The raw engagement score (−3..+3) the judge gave the player's last message. */
  engagement: number;
  /** Brief internal reason (not shown to the player); feeds the reply prompt. */
  note: string;
}

/** The slice of a turn read that feeds the character's reply prompt so its tone
 *  honestly reflects how the player's last message landed. */
export type TurnVerdict = Pick<TurnReadout, 'engagement' | 'label' | 'note'>;

/**
 * After a reply, judge how the player's LAST message landed and move the live
 * rapport for this date. Returns the new readout (vibe label + expression), or
 * null when it doesn't apply (plain chat, ended, cadence skip) or the structured
 * call fails. Fails safe: never throws, never mutates relationship stats — only
 * the ephemeral session rapport.
 */
export async function judgeTurn(sessionId: string, signal?: AbortSignal): Promise<TurnReadout | null> {
  let session: ConversationSession;
  try {
    session = getSession(sessionId);
  } catch {
    return null;
  }
  if (session.ended || session.mode === 'chat') return null;

  const settings = getLlmSettings();
  const all = messagesRepo.listBySession(sessionId);

  // Cadence: 'periodic' judges every OTHER player turn (but always on a long,
  // substantial message), to keep replies snappy when the player prefers it.
  if (settings.rapportCadence === 'periodic') {
    const playerTurns = all.filter((m) => m.role === 'player').length;
    const lastPlayer = [...all].reverse().find((m) => m.role === 'player');
    const substantial = (lastPlayer?.text.trim().length ?? 0) >= 120;
    if (playerTurns % 2 !== 0 && !substantial) return null;
  }

  const character = getCharacter(session.characterId);
  // Seed this date's rapport to the character's guarded opening BEFORE judging, so the
  // vibe label fed to the judge (and the first 'rapport' read) reflects a reserved
  // character's cooler start rather than the neutral 50. Idempotent after turn 1.
  ensureRapportSeeded(sessionId, character.guardedness);
  // Only world-bound dates have a stable per-day need (the dialogue prompt and the
  // end-of-date evaluator only surface one when the character has a world). Don't
  // let the per-turn judge penalize a hint the character was never given and the
  // evaluator never sees — keep all three surfaces in agreement for world-less dates.
  const need = character.worldId
    ? dateNeedFor(character.worldId, ensureWorldState(character.worldId).day, character.id)
    : null;

  const result = await callStructuredLlm(
    TurnReactionSchema,
    buildTurnReactionMessages({
      character,
      needJudge: need?.judge ?? '',
      vibe: rapportLabel(getRapport(sessionId)),
      recentMessages: all.slice(-8),
      playerName: getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId)).name,
    }),
    { settings, task: 'Judge how the last message landed on this date.', schemaName: 'TurnReaction', signal },
  );
  if (!result.ok) return null; // fail-safe — no rapport change

  const { rapport, delta } = applyTurnEngagement(sessionId, result.data.engagement, character.guardedness);
  return {
    label: rapportLabel(rapport),
    expression: result.data.expression.trim(),
    rapport,
    delta,
    engagement: result.data.engagement,
    note: result.data.note.trim(),
  };
}

export interface LeaveOutcome {
  message: Message;
  reason: string;
}

/**
 * If this date's rapport has cratered (the character has quietly lost interest),
 * they end the date themselves — a soft, non-hostile early exit (distinct from a
 * walkout, which is for egregious behavior). Runs BEFORE the reply on the
 * player's next message, so a "losing interest" turn warns first, then they
 * leave. Applies a real cost. Returns the farewell + ends the session, or null.
 * Fails safe (no early exit on error).
 */
export async function maybeLeaveForLostInterest(sessionId: string, signal?: AbortSignal): Promise<LeaveOutcome | null> {
  const session = getSession(sessionId);
  if (session.ended || session.mode === 'chat') return null;
  if (!hasLostInterest(sessionId)) return null;

  const character = getCharacter(session.characterId);
  const settings = getLlmSettings();

  // A brief, in-character "I should get going" — plain dialogue, low budget.
  let line = '';
  try {
    const messages = buildDialogueRequest(sessionId);
    messages.push({
      role: 'system',
      content:
        `OOC stage direction: this date isn't working for you — you've quietly lost interest and want to wrap it up now. ` +
        `Give ONE short, in-character line making a polite excuse to end the evening and leave (an early night, somewhere to be). ` +
        `Not cruel, just done — no questions, and no plans to meet again.`,
    });
    const adapter = getAdapter(settings);
    const res = await adapter.chat({ messages, temperature: settings.temperature, maxTokens: 200 }, signal);
    line = stripThink(res.content).trim();
  } catch {
    line = '';
  }
  if (!line) line = `Hey — it's been a long week and I'm pretty wiped. I think I'm gonna call it a night. Take care, okay?`;

  applyRelationshipChange(character.id, { ...RAPPORT_LEAVE_PENALTY }, { source: 'rapport', detail: { reason: 'lost_interest' } });
  // A real date occurred (rapport cratered over real turns): spend the daily action
  // + stamp last-seen like any ended date — this is the "real cost" the docstring
  // promises. Best-effort so it never blocks the farewell.
  if (character.worldId) {
    try {
      stampLastDate(character.id, ensureWorldState(character.worldId).day);
      if (session.mode === 'date' || session.mode === 'event') spendStamina(character.worldId);
    } catch {
      /* best-effort: the date still ends */
    }
  }
  const message = addCharacterMessage(sessionId, line, { left: true });
  sessionsRepo.update(ConversationSessionSchema.parse({ ...session, ended: true, updatedAt: Date.now() }));
  clearRapport(sessionId);
  const leftEvent = recordEvent('date_left', { characterId: character.id, reason: 'lost_interest' });
  // A soft early-exit used to leave no trace either — so remember the fizzled date,
  // and fold it into the chronicle, so a run of flat dates actually registers.
  const leftPlayerName = getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId)).name;
  const leftDay = character.worldId ? ensureWorldState(character.worldId).day : 0;
  try {
    addMemoriesFromEvaluation(
      character.id,
      [
        {
          text: `My date with ${leftPlayerName} fell flat — the spark wasn't there, and I made an excuse to call it an early night.`,
          importance: 3,
          tags: ['date'],
        },
      ],
      leftEvent.id,
    );
    appendSessionToChronicle(character.id, `The date with ${leftPlayerName} fizzled and ${character.name} left early.`, session.mode, leftDay);
  } catch {
    /* best-effort */
  }
  // Losing interest and ending the date early can strain a committed relationship.
  if (character.worldId) {
    try {
      evaluateRelationshipStrain(character.id, { day: ensureWorldState(character.worldId).day, trigger: 'date', mode: session.mode });
    } catch {
      /* strain is best-effort */
    }
  }
  return { message, reason: 'lost_interest' };
}

// --- Player-initiated breakup -----------------------------------------------

/** Cheap no-LLM screen for a player message that reads like ending the relationship. */
const BREAKUP_INTENT_RE =
  /\b(break(?:ing)?\s*up|broke\s*up|it'?s\s*over|we'?re\s*(?:over|through|done)|i'?m\s*done\s+with\s+(?:you|us|this)|end\s+(?:things|this|it|us|our\s+relationship)|leav(?:e|ing)\s+you|don'?t\s+want\s+to\s+(?:be\s+with\s+you|see\s+you|date\s+you|be\s+together)|not\s+work(?:ing)?\s+out\s+between\s+us)\b/i;

export interface BreakupIntentOutcome {
  /** The character's reaction line (persisted as a character message). */
  message: Message;
  reaction: 'accept' | 'hurt' | 'plead';
}

/**
 * If the player's latest message reads like a genuine breakup, ask the model
 * (structured) how the character reacts. This does NOT end the relationship —
 * it returns the character's plea/acceptance so the UI can ask the player to
 * CONFIRM. The breakup is applied only by `confirmPlayerBreakup`. Returns null
 * (→ fall through to a normal reply) when there's no breakup intent, the model
 * judges it non-genuine, or the structured call fails.
 */
export async function attemptPlayerBreakupIntent(
  sessionId: string,
  playerText: string,
  signal?: AbortSignal,
): Promise<BreakupIntentOutcome | null> {
  const session = getSession(sessionId);
  if (session.ended || session.mode === 'chat') return null;
  if (!BREAKUP_INTENT_RE.test(playerText)) return null;

  const character = getCharacter(session.characterId);
  // You can only break up with someone you're actually together with — and you
  // can't re-break-up with someone who has already broken up with you (the
  // "win them back" phase). Mirrors the guards on the character-initiated strain
  // path (evaluateRelationshipStrain): without them, a breakup-sounding line on
  // an already-broken-up or never-committed bond would surface a confirm prompt
  // that re-applies the breakup penalty, bumps the scar count, and resets the
  // reconcile cooldown. Fall through to a normal reply instead.
  const relationship = getRelationship(character.id);
  if (isBrokenUp(relationship) || currentStatus(relationship) === 'none') return null;

  const settings = getLlmSettings();
  const recent = messagesRepo.listBySession(sessionId).slice(-12);
  const result = await callStructuredLlm(
    PlayerBreakupReactionSchema,
    buildPlayerBreakupMessages({ character, relationship, recentMessages: recent, playerName: getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId)).name }),
    { settings, task: 'Decide whether the player is genuinely breaking up, and react in character.', schemaName: 'PlayerBreakupReaction', signal },
  );
  // Not genuine (joking/hypothetical/opposite) or a failed call → normal reply.
  if (!result.ok || !result.data.genuine) return null;

  const message = addCharacterMessage(sessionId, result.data.line.trim(), { breakupIntent: true });
  return { message, reaction: result.data.reaction };
}

/**
 * Confirm a player-initiated breakup: apply it (server-owned, scarred like any
 * breakup) and end the date. Texting stays open afterward so the player can
 * still try to win them back later. Face-to-face, so NO breakup text is queued.
 */
export function confirmPlayerBreakup(sessionId: string): PlayerBreakupResponse {
  const session = getSession(sessionId);
  const character = getCharacter(session.characterId);
  const rel = getRelationship(character.id);
  // Defense in depth (the intent step already short-circuits these): never apply
  // a player breakup to a bond that's already broken up or was never a couple —
  // doing so would double-scar (breakup:count++), reset the reconcile cooldown,
  // overwrite the recorded prior status, and stack the breakup penalty.
  if (isBrokenUp(rel)) throw badRequest(`You and ${character.name} have already broken up.`);
  const fromStatus: RelationshipStatus = currentStatus(rel);
  if (fromStatus === 'none') throw badRequest(`You and ${character.name} aren't together, so there's nothing to break off.`);
  const day = character.worldId ? ensureWorldState(character.worldId).day : 0;

  applyBreakup(character.id, { day, fromStatus, initiator: 'player' });
  const ended = sessionsRepo.update(ConversationSessionSchema.parse({ ...session, ended: true, updatedAt: Date.now() }));

  const relationship: Relationship = getRelationship(character.id);
  return { relationship, fromStatus, ended: ended.ended };
}

/**
 * Roll for a monogamous character "finding out" you've been seeing others.
 * Polyamorous characters never get jealous. RNG injectable for tests.
 */
export function maybeRollJealousy(character: Character, rng: () => number = Math.random): JealousyOutcome | null {
  if (character.relationshipStyle !== 'monogamous' || !character.worldId) return null;
  const day = ensureWorldState(character.worldId).day;
  const rel = getRelationship(character.id);
  // No bond, no jealousy: a near-stranger or acquaintance has no claim to feel
  // betrayed. Only once you're at least "getting close" does seeing others sting.
  if (warmthOf(rel) < JEALOUSY_MIN_WARMTH) return null;
  // Commitment raises the stakes: an exclusive partner catches on near-certainly
  // and is hurt far more than someone you're only casually seeing.
  const committed = isCommitted(rel);
  const tuning = committed ? JEALOUSY_COMMITTED : JEALOUSY;
  const lastRoll = rel.flags['jealousy:lastRollDay'];
  if (typeof lastRoll === 'number' && day - lastRoll < tuning.cooldownDays) return null;

  const others = charactersRepo.listByWorld(character.worldId).filter((c) => c.id !== character.id);
  const otherRecent = others.filter((c) => {
    const seen = relationshipsRepo.getByCharacter(c.id, DEFAULT_PLAYER_ID)?.flags[LAST_SEEN_FLAG];
    return typeof seen === 'number' && day - seen <= tuning.recencyDays;
  });
  if (otherRecent.length === 0) return null;

  setRelationshipFlag(character.id, 'jealousy:lastRollDay', day, { source: 'jealousy' });
  const prob = jealousyProbability(otherRecent.length, committed);
  if (rng() >= prob) {
    recordEvent('jealousy_roll', { characterId: character.id, prob, triggered: false });
    return { triggered: false, otherCount: otherRecent.length, message: '' };
  }

  // Weighted pick: a character is far likelier to fixate on catching you with
  // their OWN ex/rival/partner (per the social graph) than with a stranger.
  const weightFor = (o: Character) => {
    const link = linkTo(character.links, o.id);
    return link ? LINK_JEALOUSY_WEIGHT[link.kind] : 1;
  };
  const totalWeight = otherRecent.reduce((sum, o) => sum + weightFor(o), 0);
  let pick = rng() * totalWeight;
  let other = otherRecent[0]!;
  for (const o of otherRecent) {
    pick -= weightFor(o);
    if (pick < 0) {
      other = o;
      break;
    }
  }

  // Name the relationship if the rival is someone in their social web.
  const link = linkTo(character.links, other.id);
  const relDesc = link ? `, their ${CHARACTER_LINK_LABELS[link.kind].toLowerCase()}` : '';

  applyRelationshipChange(character.id, { ...(committed ? JEALOUSY_PENALTY_COMMITTED : JEALOUSY_PENALTY) }, {
    source: 'jealousy',
    detail: { otherCharacterId: other.id, committed, link: link?.kind ?? null },
  });
  setRelationshipFlag(character.id, 'state:jealous', true, { source: 'jealousy' });
  // (Opt-in) cheating discovered while they were COMMITTED to you cuts deepest.
  if (committed) {
    try {
      adjustDespair(character.id, DESPAIR.cheatHit, 'cheating', day);
    } catch {
      /* best-effort */
    }
  }
  addMemoriesFromEvaluation(
    character.id,
    [{ text: `Found out the player has also been seeing ${other.name}${relDesc}. It stung.`, importance: link ? 5 : 4, tags: ['jealousy'] }],
    null,
  );
  recordEvent('jealousy_triggered', {
    characterId: character.id,
    otherCharacterId: other.id,
    link: link?.kind ?? null,
    committed,
    day,
  });
  return {
    triggered: true,
    otherCount: otherRecent.length,
    message: `${character.name} found out you've also been seeing ${other.name}${relDesc} — and isn't happy about it.`,
  };
}

// --- summary (structured) ---------------------------------------------------

export async function summarizeSession(sessionId: string): Promise<ConversationSession> {
  const session = getSession(sessionId);
  const messages = messagesRepo.listBySession(sessionId);
  if (messages.length === 0) return session;
  const settings = getLlmSettings();
  const ctx = buildPromptContextForSession(session, messages);
  const result = await callStructuredLlm(SessionSummarySchema, buildSummaryMessages(ctx), {
    settings,
    task: 'Summarize the dating-sim conversation so far.',
    schemaName: 'SessionSummary',
  });
  if (!result.ok) {
    recordEvent('summary_failed', { sessionId, error: result.error });
    return session; // fail safe: keep existing summary
  }
  const combined = [result.data.summary, ...result.data.keyPoints.map((p) => `• ${p}`)].join('\n');
  const updated = sessionsRepo.update(
    ConversationSessionSchema.parse({ ...session, summary: combined, updatedAt: Date.now() }),
  );
  recordEvent('summary_written', { sessionId });
  return updated;
}

/** Summarize automatically once a session crosses the message threshold. */
export async function maybeAutoSummarize(sessionId: string): Promise<void> {
  const count = messagesRepo.countBySession(sessionId);
  if (count > 0 && count % PROMPT_LIMITS.summarizeEveryMessages === 0) {
    try {
      await summarizeSession(sessionId);
    } catch {
      // Summaries are best-effort; never block the chat loop on them.
    }
  }
}

// --- end + evaluate (structured) --------------------------------------------

/**
 * End a session and run the STRUCTURED evaluator. Stat/memory mutations happen
 * only if the structured result validates. On failure, no game state is
 * mutated by the evaluation (the session is still marked ended).
 */
export async function endSession(sessionId: string): Promise<EndSessionResponse> {
  const session = getSession(sessionId);
  const messages = messagesRepo.listBySession(sessionId);

  // Already over (e.g. the character walked out, or a double end-request).
  // Do NOT re-run the evaluator/jealousy — that would double-apply deltas.
  if (session.ended) {
    clearRapport(sessionId);
    return {
      session,
      evaluated: false,
      relationship: null,
      mood: null,
      expression: null,
      summaryLine: null,
      memoriesWritten: 0,
      evalError: 'This date has already ended.',
      jealousy: null,
      milestone: null,
      breakup: null,
      onTheRocks: false,
      reconciled: false,
      ending: null,
    };
  }

  const endBase = (
    evaluated: boolean,
    evalError: string | null,
    extra: Partial<EndSessionResponse> = {},
  ): EndSessionResponse => {
    const ended = sessionsRepo.update(
      ConversationSessionSchema.parse({ ...session, ended: true, updatedAt: Date.now() }),
    );
    return {
      session: ended,
      evaluated,
      relationship: null,
      mood: null,
      expression: null,
      summaryLine: null,
      memoriesWritten: 0,
      evalError,
      jealousy: null,
      milestone: null,
      breakup: null,
      onTheRocks: false,
      reconciled: false,
      ending: null,
      ...extra,
    };
  };

  // Starting a date but never actually speaking is NOT a real date. Don't let it
  // count — no stamina spent, no "last seen" stamp, no jealousy/eval, and remove
  // the empty session entirely so it can't enable texting (hasDated) or clutter
  // history. A real date requires at least one player turn.
  const hadPlayerTurn = messages.some((m) => m.role === 'player');
  if (!hadPlayerTurn) {
    clearRapport(sessionId);
    sessionsRepo.delete(session.id);
    return {
      session: { ...session, ended: true },
      evaluated: false,
      relationship: null,
      mood: null,
      expression: null,
      summaryLine: null,
      memoriesWritten: 0,
      evalError: "You didn't say anything, so this date doesn't count.",
      jealousy: null,
      milestone: null,
      breakup: null,
      onTheRocks: false,
      reconciled: false,
      ending: null,
    };
  }

  // A real date occurred: stamp "last seen" and spend a daily action (once,
  // before the session is marked ended). World-bound dates/events only.
  if (!session.ended) {
    const actor = getCharacter(session.characterId);
    if (actor.worldId) {
      stampLastDate(session.characterId, ensureWorldState(actor.worldId).day);
      if (session.mode === 'date' || session.mode === 'event') {
        // Funds were checked at createSession; re-check here in case the wallet was
        // drained mid-date. A property you own or lease is FREE (the lease rent /
        // purchase covers it); any other venue charges its full tier price.
        const venue = resolveSessionLocation(session.locationId, actor, worldsRepo.get(actor.worldId) ?? null);
        const propVenue = propertyVenueInfo(session.locationId, actor.worldId);
        const cost = propVenue ? 0 : venueCost(venue?.priceTier);
        const pid = playerIdForWorld(actor.worldId);
        // Refuse to end the date if it can no longer be paid (mirrors the createSession
        // gate), BEFORE spending stamina — rather than silently discounting the venue to
        // whatever's left. The session stays open, so it's re-endable once funds return.
        if (cost > 0 && getOrCreatePlayer(pid).money < cost) {
          throw badRequest(
            `You can no longer afford ${venue?.name ?? 'this venue'} (it costs ${cost}, you have ${getOrCreatePlayer(pid).money}). Settle up before ending the date.`,
          );
        }
        spendStamina(actor.worldId);
        if (cost > 0) spendMoney(cost, pid);
      }
    }
  }

  // Emotional state carried INTO this date should be resolved by having had it
  // out here — but jealousy freshly discovered just below must persist to color
  // the NEXT date, so capture the pre-roll state first.
  const incomingFlags = getRelationship(session.characterId).flags;
  const incomingJealous = incomingFlags['state:jealous'] === true;
  const incomingOffended = incomingFlags['state:offended'] === true;

  // A monogamous character may "find out" about other people you've seen lately.
  const jealousy = maybeRollJealousy(getCharacter(session.characterId));

  const settings = getLlmSettings();
  const evalMessages = messages.slice(-50);
  const ctx = buildPromptContextForSession(session, evalMessages);
  const result = await callStructuredLlm(SessionEvaluationSchema, buildEvaluatorMessages(ctx), {
    settings,
    task: 'Evaluate how this dating-sim conversation affected the relationship and record memories.',
    schemaName: 'SessionEvaluation',
    // A maximal eval (summaryLine + up to 8 memories) plus a reasoning model's
    // think tokens can outgrow a user-lowered budget; the whole eval is fail-safe
    // DISCARDED on a truncated/invalid response (recap, memories, and deltas all
    // lost), so floor the headroom.
    maxTokens: Math.max(settings.maxTokens, 3000),
  });

  // This real session is ending → decay temporary buffs by one session NOW that the
  // evaluator (which ran with them still active) is done. Done once, on BOTH the
  // success and failure paths, so the README contract ("buffs decay when a session
  // ends") holds even when the eval call fails.
  decayRelationshipBuffs(session.characterId);

  if (!result.ok) {
    // FAIL SAFE: do not mutate relationship/memories.
    recordEvent('session_eval_failed', { sessionId, error: result.error, attempts: result.attempts });
    return endBase(false, result.error, { jealousy });
  }

  const evaluation = result.data;
  const actor = getCharacter(session.characterId);
  const chronDay = actor.worldId ? ensureWorldState(actor.worldId).day : 0;
  const event = recordEvent('session_eval', {
    sessionId,
    characterId: session.characterId,
    day: chronDay,
    mood: evaluation.mood,
    expression: evaluation.expression,
    deltas: evaluation.relationshipDeltas,
    summaryLine: evaluation.summaryLine,
  });

  // Capture warmth BEFORE the eval delta so we can detect a band crossing.
  const beforeRel = getRelationship(session.characterId);
  applyRelationshipChange(session.characterId, evaluation.relationshipDeltas, {
    source: 'session_eval',
    detail: { sessionId },
  });
  const memories = addMemoriesFromEvaluation(session.characterId, evaluation.memoryCandidates, event.id);

  // Resolve the emotional state carried INTO this date — they've now had the
  // chance to air it. Keep jealousy that was freshly discovered this turn so it
  // colors the NEXT date instead.
  if (incomingOffended) setRelationshipFlag(session.characterId, 'state:offended', false, { source: 'state_resolved' });
  if (incomingJealous && !jealousy?.triggered) {
    setRelationshipFlag(session.characterId, 'state:jealous', false, { source: 'state_resolved' });
  }
  const stateResolved = incomingOffended || (incomingJealous && !jealousy?.triggered);

  // The day's weather + the venue (indoor/outdoor) nudge the date. Server-owned,
  // clamped — and applied BEFORE milestone detection so it can tip a crossing.
  if (actor.worldId && (session.mode === 'date' || session.mode === 'event')) {
    const weather = weatherForDay(actor.worldId, chronDay);
    const loc = resolveSessionLocation(session.locationId, actor, worldsRepo.get(actor.worldId) ?? null);
    const eff = weatherDateEffect(actor, loc, weather);
    if (Object.keys(eff).length > 0) {
      applyRelationshipChange(session.characterId, eff, {
        source: 'weather',
        detail: { weather: weather.kind, locationId: session.locationId },
      });
      recordEvent('weather_date', { characterId: session.characterId, weather: weather.kind, indoor: loc?.indoor ?? null });
    }

    // How they judged the spend on the venue — filtered through their taste (a
    // splurge delights a luxury-lover but can mildly put off a down-to-earth one;
    // thoughtful cheap effort charms the grounded type). Server-owned + clamped,
    // applied before milestone/strain so it can tip a crossing.
    const tier = loc?.priceTier ?? 0;
    const venueEff = venueDateEffect(actor, tier);
    if (Object.keys(venueEff).length > 0) {
      applyRelationshipChange(session.characterId, venueEff, {
        source: 'venue',
        detail: { priceTier: tier, locationId: session.locationId },
      });
      recordEvent('venue_date', { characterId: session.characterId, priceTier: tier });
    }

    // Dating at a property you own (or rented) grants its authored relationship buff —
    // owning gives the full amount, renting gives a fraction. The "own your place" payoff.
    const propVenue = propertyVenueInfo(session.locationId, actor.worldId);
    if (propVenue) {
      const buff = propertyDateBuff(propVenue.property.buffStat, propVenue.property.buffAmount, propVenue.owned);
      if (Object.keys(buff).length > 0) {
        applyRelationshipChange(session.characterId, buff, {
          source: 'venue',
          detail: { propertyId: propVenue.property.id, owned: propVenue.owned },
        });
        recordEvent('property_date', {
          characterId: session.characterId,
          propertyId: propVenue.property.id,
          owned: propVenue.owned,
        });
      }
    }
  }

  // The date's overall RAPPORT applies its consequence — the core "dates can go
  // wrong" lever. A great date boosts warmth; a flat/bad one nets negative and
  // more tense, feeding the strain check below over repeated bad nights. Default
  // rapport (no per-turn judging happened) sits in the neutral band → no effect.
  // Server-owned + clamped, applied BEFORE milestone/strain see the state.
  if (actor.worldId && (session.mode === 'date' || session.mode === 'event')) {
    const finalRapport = getRapport(session.id);
    const eff = rapportEndEffect(finalRapport);
    if (Object.keys(eff).length > 0) {
      applyRelationshipChange(session.characterId, eff, { source: 'rapport', detail: { rapport: finalRapport } });
      recordEvent('date_rapport', { characterId: session.characterId, rapport: finalRapport });
    }
  }
  clearRapport(session.id);

  // (Opt-in) showing up for a real, non-cruel evening helps pull a struggling
  // partner back from the despair spiral — the off-ramp. (No-op unless enabled.)
  if (actor.worldId && (session.mode === 'date' || session.mode === 'event')) {
    try {
      adjustDespair(session.characterId, -DESPAIR.dateHeal, 'time_together', chronDay);
    } catch {
      /* best-effort */
    }
  }

  // Re-read after every delta (eval + weather + rapport) so the response + milestone see the full picture.
  const relationship = getRelationship(session.characterId);

  // (Opt-in) The character may have revealed canon facts about an ex this date.
  // Heavily gated (usually zero LLM); writes to canon_facts, never the authored row.
  try {
    await maybeExtractExFacts(session, messages, actor, chronDay);
  } catch {
    /* ex-canon is best-effort; never block ending a date */
  }

  // Once you're actually seeing this person, the things YOU shared about yourself
  // become their first-hand knowledge of you — which the world-sim then lets travel
  // their social web ("Mara's seeing a chef, apparently"). Gated + best-effort.
  try {
    await maybeExtractPlayerFacts(session, messages, actor, chronDay);
  } catch {
    /* player-fact capture is best-effort; never block ending a date */
  }

  // A relationship-stage milestone may have been crossed (best-effort).
  let milestone = null;
  try {
    milestone = detectMilestoneCrossing(session.characterId, beforeRel, relationship, {
      day: chronDay,
      mode: session.mode,
    });
  } catch {
    /* milestone detection is best-effort; never block ending a date */
  }

  // Fold this date's highlight into the cross-date chronicle (best-effort).
  try {
    appendSessionToChronicle(session.characterId, evaluation.summaryLine, session.mode, chronDay);
  } catch {
    /* chronicle is best-effort; never block ending a date */
  }

  // Endgame: a committed relationship may go on the rocks / break up after a bad
  // date, or a broken-up one may reconcile after enough warming back up. Runs
  // after milestone detection so a crossing isn't pre-empted by a breakup check.
  let breakup: EndSessionResponse['breakup'] = null;
  let onTheRocks = false;
  let reconciled = false;
  if (actor.worldId && (session.mode === 'date' || session.mode === 'event')) {
    try {
      const outcome = evaluateRelationshipStrain(session.characterId, { day: chronDay, trigger: 'date', mode: session.mode });
      if (outcome.kind === 'broke_up') breakup = { fromStatus: outcome.fromStatus!, line: outcome.line ?? '' };
      else if (outcome.kind === 'on_the_rocks') onTheRocks = true;
      else if (outcome.kind === 'reconciled') reconciled = true;
    } catch {
      /* strain is best-effort; never block ending a date */
    }
  }
  const strainChanged = breakup != null || onTheRocks || reconciled;

  // The "happy ending" — a soft win when the relationship reaches its committed
  // peak. Only when nothing went wrong this date (no breakup/rocks/reconcile).
  let ending: EndSessionResponse['ending'] = null;
  if (actor.worldId && (session.mode === 'date' || session.mode === 'event') && !strainChanged) {
    try {
      ending = await maybeReachEnding(session.characterId, { day: chronDay, mode: session.mode });
    } catch {
      /* ending is best-effort; never block ending a date */
    }
  }

  return endBase(true, null, {
    // Re-read when a milestone fired, state was resolved, the endgame state shifted,
    // or an ending was reached so the returned flags reflect it.
    relationship:
      milestone || stateResolved || strainChanged || ending ? getRelationship(session.characterId) : relationship,
    mood: evaluation.mood,
    expression: evaluation.expression,
    summaryLine: evaluation.summaryLine,
    memoriesWritten: memories.length,
    jealousy,
    milestone,
    breakup,
    onTheRocks,
    reconciled,
    ending,
  });
}

// --- prompt preview (debug / character editor) ------------------------------

export interface PromptPreview {
  system: string;
  approxChars: number;
}

/** Preview the dialogue prompt for a character without an active session. */
export function previewCharacterPrompt(characterId: string): PromptPreview {
  getCharacter(characterId);
  const now = Date.now();
  const session = ConversationSessionSchema.parse({
    id: 'preview',
    characterId,
    locationId: null,
    mode: 'chat',
    summary: '',
    ended: false,
    createdAt: now,
    updatedAt: now,
  });
  const ctx = buildPromptContextForSession(session, []);
  const messages = buildDialogueMessages(ctx);
  const system = messages.find((m) => m.role === 'system');
  return {
    system: system ? messageText(system.content) : '',
    approxChars: estimatePromptChars(messages),
  };
}

/** Preview the dialogue prompt for an active session. */
export function previewSessionPrompt(sessionId: string): PromptPreview {
  const messages = buildDialogueRequest(sessionId);
  const system = messages.find((m) => m.role === 'system');
  return {
    system: system ? messageText(system.content) : '',
    approxChars: estimatePromptChars(messages),
  };
}
