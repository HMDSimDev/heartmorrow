import {
  ConversationContextEstimateSchema,
  ConversationSessionSchema,
  type ActiveDate,
  MessageSchema,
  SessionParticipantSchema,
  SessionEvaluationSchema,
  SessionSummarySchema,
  WalkoutReactionSchema,
  TurnReactionSchema,
  GroupSpeakerSelectionSchema,
  PlayerBreakupReactionSchema,
  PlayerFarewellReactionSchema,
  PROMPT_LIMITS,
  GEN_TEXT,
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
  isDateMode,
  isMeetingMode,
  ANNIVERSARY_DATE_BONUS,
  anniversaryOn,
  isMemorialized,
  currentStatus,
  RECONCILE_COOLDOWN_DAYS,
  linkTo,
  LINK_JEALOUSY_WEIGHT,
  CHARACTER_LINK_LABELS,
  AFTERGLOW_MOOD_FLAG,
  AFTERGLOW_DAY_FLAG,
  PHASE_LABELS,
  deriveCalendar,
  intimacyAllowed,
  venueCost,
  venueDateEffect,
  propertyDateBuff,
  scaleEvaluationDeltas,
  type Character,
  type ConversationCreate,
  type ConversationContextEstimate,
  type ConversationParticipant,
  type ConversationSession,
  EndSessionResponseSchema,
  type EndSessionResponse,
  type DateParticipantResult,
  type Intent,
  type JealousyOutcome,
  type Location,
  type Message,
  type PlayerBreakupResponse,
  type Relationship,
  type RelationshipStatus,
  type SessionParticipant,
  type SessionWithMessages,
} from '@dsim/shared';
import { z } from 'zod';
import { getDb } from '../db/index';
import { charactersRepo, chroniclesRepo, dateResultsRepo, messagesRepo, npcKnowledgeRepo, relationshipsRepo, sessionParticipantsRepo, sessionsRepo, worldNotesRepo, worldStatesRepo } from '../db/repositories';
import { newId, playerIdForWorld, playerIdForWorldOrDefault } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';
import { isWorldAdvancing } from '../lib/world-transition';
import { getCharacter, listAcquaintances, currentNpcPartners } from './character-service';
import { getRelationship } from './relationship-service';
import { getOrCreatePlayer, spendMoney } from './player-service';
import { selectTopMemories } from './memory-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { applyRelationshipChange, decayRelationshipBuffs, setRelationshipFlag, stampLastDate } from './stat-service';
import { assertCanAct, ensureWorldState, spendStamina } from './world-clock-service';
import { propertyVenueInfo } from './property-service';
import { getCharacterAvailability } from './availability-service';
import { romanticCompatFor } from './compatibility-service';
import { requireFeature } from './world-feature-service';
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
  peekExpression,
  setLastExpression,
  applyTurnEngagement,
  ensureRapportSeeded,
  hasJudgedTurn,
  rapportLabel,
  rapportEndEffect,
  clearRapport,
  hasLostInterest,
  getParticipantRapport,
  ensureParticipantRapportSeeded,
  applyParticipantTurnEngagement,
  setParticipantLastExpression,
  participantHasLostInterest,
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
  buildGroupSpeakerSelectionMessages,
  buildPlayerBreakupMessages,
  buildPlayerFarewellMessages,
  estimatePromptChars,
  messageText,
  type PromptContext,
} from '../prompt/prompt-builder';
import { callStructuredLlm } from '../llm/structured';
import { getAdapter } from '../llm/provider';
import type { ChatMessage } from '../llm/types';
import { ThinkStripper, stripThink } from '../lib/think-filter';
import { withKeyedLock } from '../lib/keyed-lock';

// --- session CRUD -----------------------------------------------------------

/**
 * Resolve the date-setup "Anywhere" choice to a concrete venue. "Anywhere" means
 * "surprise me", so among the FREE public venues we pick a RANDOM one for variety —
 * not always the first in the list, which made every "Anywhere" date land at the same
 * spot. Free venues take precedence so "Anywhere" never silently charges you when a
 * free option exists; only when the world has NONE free do we fall back to the
 * cheapest venue the player can currently afford (a predictable minimum spend, rather
 * than randomly picking a pricier place and surprise-charging for it). Throws if every
 * venue costs more than the wallet holds (and none are free), so "Anywhere" can't
 * silently start a date you can't pay for. Returns null only when the world has no
 * venues at all (a locationless date is the fallback then). `rng` is injectable so
 * tests can pin the random choice.
 */
export function pickAnywhereVenue(
  locations: readonly Location[],
  money: number,
  rng: () => number = Math.random,
): string | null {
  if (locations.length === 0) return null;
  // Prefer free venues — pick a random one so "Anywhere" surprises you with a
  // different spot each time instead of always the first free entry.
  const free = locations.filter((l) => venueCost(l.priceTier) === 0);
  if (free.length > 0) {
    const idx = Math.min(free.length - 1, Math.max(0, Math.floor(rng() * free.length)));
    return free[idx]!.id;
  }
  // No free venue exists — fall back to the cheapest one you can afford.
  const cheapestFirst = [...locations].sort((a, b) => venueCost(a.priceTier) - venueCost(b.priceTier));
  const affordable = cheapestFirst.find((l) => venueCost(l.priceTier) <= money);
  if (affordable) return affordable.id;
  const cheapest = cheapestFirst[0]!;
  throw badRequest(
    `Everywhere in town costs more than you have right now (the cheapest, ${cheapest.name}, is ${venueCost(cheapest.priceTier)} and you have ${money}). Earn a little first, or date somewhere you own.`,
  );
}

export function createSession(input: ConversationCreate): ConversationSession {
  const character = getCharacter(input.characterId); // validates existence
  // `ConversationCreate` is the schema's INPUT type, so defaulted fields remain
  // optional for direct service callers (tests and internal tools). Resolve them
  // once so every gate sees the same normalized values as the stored session.
  const mode = input.mode ?? 'chat';
  const participantIds = input.participantIds ?? [];
  if (participantIds.length > 1) {
    throw badRequest('A group outing currently supports one additional attendee.');
  }
  if (new Set(participantIds).size !== participantIds.length || participantIds.includes(character.id)) {
    throw badRequest('Each group-outing attendee must be a different character.');
  }

  const invitees = participantIds.map((id) => getCharacter(id));
  const attendees = [character, ...invitees];
  // A memorialized character is gone — no further dates or chats (a kept record).
  for (const attendee of attendees) {
    if (isMemorialized(getRelationship(attendee.id))) {
      throw badRequest(`${attendee.name} is no longer with us.`);
    }
  }

  if (invitees.length > 0) {
    if (mode !== 'date' && mode !== 'hangout') {
      throw badRequest('Additional attendees are currently supported only on dates and hangouts.');
    }
    if (!character.worldId) {
      throw badRequest('Group-outing attendees must belong to the same world.');
    }
    for (const invitee of invitees) {
      if (invitee.worldId !== character.worldId) {
        throw badRequest('Group-outing attendees must belong to the same world.');
      }
    }
    requireFeature(character.worldId, 'groupDates');
  }
  // The location the date actually happens at. "Anywhere" (a date-setup directive,
  // not a real id) is resolved to a concrete venue inside the date block below; it
  // never reaches a chat or worldless session as a literal location.
  let resolvedLocationId: string | null = input.locationId ?? null;
  // Real meetings (a date OR a hangout) cost a daily action and require the
  // character to be available today (world-bound only). A bare `chat` is exempt.
  // Only the venue-SPEND block below is date-only: hanging out is always free.
  if (isMeetingMode(mode) && character.worldId) {
    const outing = mode === 'hangout' ? 'hangout' : 'date';
    // Make the Sleep/date exclusion reciprocal. Sleep claims this guard before
    // checking active sessions, so a date cannot begin during a partially committed
    // multi-step day rollover from another tab.
    if (isWorldAdvancing(character.worldId)) {
      throw badRequest(`The day is turning over — give it a moment before starting a ${outing}.`);
    }
    // One live meeting per world. The client guards against starting a second one
    // (Chat.tsx `if (activeDate) return`), but that's best-effort UI state — a
    // double-submit, a second tab, or a stale/failed active-date fetch can slip a
    // second POST through. Enforce it authoritatively here so sittings can't "stack":
    // without this, two open sessions coexist and ending one silently resurfaces the
    // other (getActiveDateForWorld returns them one at a time).
    const openDate = getActiveDateForWorld(character.worldId);
    if (openDate) {
      const openNames = openDate.participants.map((p) => p.characterName).join(' and ') || openDate.characterName;
      throw badRequest(
        `You're already ${openDate.mode === 'hangout' ? 'hanging out' : 'on a date'} with ${openNames} — wrap that up before starting another.`,
      );
    }
    const day = ensureWorldState(character.worldId).day;
    // A character who just broke up with you needs space before they'll meet
    // again — keep texting them to thaw things; the date reopens after a cooldown.
    for (const attendee of attendees) {
      const rel = getRelationship(attendee.id);
      if (isBrokenUp(rel)) {
        const since = rel.flags['breakup:day'];
        if (typeof since === 'number' && day - since < RECONCILE_COOLDOWN_DAYS) {
          throw badRequest(`${attendee.name} needs some space right now — give it a little time before reaching out to meet up.`);
        }
      }
      const avail = getCharacterAvailability(character.worldId, day, attendee.id);
      if (!avail.available) {
        throw badRequest(`${attendee.name} ${avail.reason ?? 'is unavailable today'}.`);
      }
    }
    assertCanAct(character.worldId);
    const world = worldsRepo.get(character.worldId) ?? null;
    if (mode === 'hangout') {
      // A hangout never costs money, so it can only happen somewhere free — the
      // spend levers (venue taste, property buff) are date-only anyway, and letting
      // a hangout book a lavish venue for nothing would read as a loophole.
      // "Anywhere" picks a random free spot; a paid one is refused outright.
      const free = (world?.locations ?? []).filter((l) => venueCost(l.priceTier) === 0);
      if (resolvedLocationId === 'anywhere') {
        resolvedLocationId = free.length > 0 ? pickAnywhereVenue(free, 0) : null;
      } else if (resolvedLocationId) {
        const venue = resolveSessionLocation(resolvedLocationId, character, world);
        if (venueCost(venue?.priceTier) > 0) {
          throw badRequest(
            `Hanging out doesn't come with a night out — pick somewhere free, or save ${venue?.name ?? 'that place'} for a real date.`,
          );
        }
      }
    } else {
      // Soft money gate: you can't take someone somewhere you can't afford (free
      // venues always exist, so dating itself is never blocked). The wallet is only
      // CHECKED here; it's charged when the date actually ends (mirrors stamina), so
      // an abandoned setup never costs money.
      // A property venue is only valid if you own or currently lease it — reject a
      // `prop:` location you have no claim to rather than silently degrading to a
      // locationless date.
      // "Anywhere": auto-pick a RANDOM free public venue (for variety), else the cheapest
      // the player can currently afford — refusing the date outright when nothing is affordable.
      if (resolvedLocationId === 'anywhere') {
        resolvedLocationId = pickAnywhereVenue(world?.locations ?? [], getOrCreatePlayer(playerIdForWorld(character.worldId)).money);
      }
      if (resolvedLocationId?.startsWith('prop:') && !propertyVenueInfo(resolvedLocationId, character.worldId)) {
        throw badRequest('You can only date at a place you own or lease.');
      }
      const venue = resolveSessionLocation(resolvedLocationId, character, world);
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
  } else if (resolvedLocationId === 'anywhere') {
    resolvedLocationId = null; // "Anywhere" is meaningless outside a world-bound date
  }
  const now = Date.now();
  const session = ConversationSessionSchema.parse({
    id: newId('sess'),
    characterId: input.characterId,
    locationId: resolvedLocationId,
    mode,
    summary: '',
    ended: false,
    createdAt: now,
    updatedAt: now,
  });
  // The session and its ordered roster are one durable unit. If any participant row
  // fails, the session insert rolls back rather than leaving an unresumable half-date.
  return getDb().transaction(() => {
    const saved = sessionsRepo.insert(session);
    attendees.forEach((attendee, seat) => {
      sessionParticipantsRepo.upsert(
        SessionParticipantSchema.parse({
          sessionId: saved.id,
          characterId: attendee.id,
          seat,
          role: 'romance',
          state: 'present',
          rapport: null,
          updatedAt: now,
        }),
      );
    });
    return saved;
  });
}

export function getSession(id: string): ConversationSession {
  const s = sessionsRepo.get(id);
  if (!s) throw notFound(`Session ${id} not found.`);
  return s;
}

export function listSessions(): ConversationSession[] {
  return sessionsRepo.list();
}

function getConversationParticipants(session: ConversationSession): ConversationParticipant[] {
  const stored = sessionParticipantsRepo.listBySession(session.id);
  // Defensive read fallback for a legacy/imported session created without a roster.
  // Normal database startup backfills these rows, but a direct repository insert in
  // an older integration should still remain readable without mutating on GET.
  const participants =
    stored.length > 0
      ? stored
      : [
          SessionParticipantSchema.parse({
            sessionId: session.id,
            characterId: session.characterId,
            seat: 0,
            role: 'romance',
            state: 'present',
            rapport: null,
            updatedAt: session.updatedAt,
          }),
        ];
  return participants.map((participant) => ({
    characterId: participant.characterId,
    characterName: getCharacter(participant.characterId).name,
    seat: participant.seat,
    role: participant.role,
    state: participant.state,
    rapport: participant.judged ? participant.rapport : null,
    vibe: participant.judged && participant.rapport != null ? rapportLabel(participant.rapport) : null,
    expression: participant.expression,
    judged: participant.judged,
  }));
}

export function getSessionWithMessages(id: string): SessionWithMessages {
  const session = getSession(id);
  return {
    session,
    participants: getConversationParticipants(session),
    messages: messagesRepo.listBySession(id),
  };
}

/**
 * The world's single live, in-progress meeting (if any): the most-recently-updated
 * non-ended date/event/hangout session whose character belongs to this world. Drives
 * the client's auto-resume (a sitting survives a navigation/refresh) and the "someone
 * is waiting on you" lock on day-spending actions. Read-only — never mutates. A bare
 * `chat` never counts. Read `mode` to tell a date from a hangout.
 */
export function getActiveDateForWorld(worldId: string): ActiveDate | null {
  for (const s of sessionsRepo.listActive()) {
    if (!isMeetingMode(s.mode)) continue;
    const character = charactersRepo.get(s.characterId);
    if (!character || character.worldId !== worldId) continue;
    // No rapport/vibe until a turn has actually been JUDGED: the rapport row is
    // seeded (to a guarded character's cooler opening) before the first judge
    // call, and that seed must not surface as a verdict on a date where nothing
    // has happened — the client shows its neutral "settling in" state instead.
    const participants = getConversationParticipants(s);
    const hostParticipant = participants.find((participant) => participant.characterId === character.id);
    const rawRapport = hostParticipant?.rapport ?? peekRapport(s.id);
    // Legacy callers still write the original session-level rapport row directly.
    // Treat either store's judged bit as authoritative so those dates keep their
    // public host read while Phase 2 writes both stores in lockstep.
    const rapport = rawRapport != null && (hostParticipant?.judged === true || hasJudgedTurn(s.id)) ? rawRapport : null;
    return {
      sessionId: s.id,
      participants,
      characterId: character.id,
      characterName: character.name,
      mode: s.mode,
      locationId: s.locationId,
      hasPlayerTurn: messagesRepo.hasRole(s.id, 'player'),
      rapport,
      vibe: rapport != null ? rapportLabel(rapport) : null,
      expression: hostParticipant?.expression ?? peekExpression(s.id),
      updatedAt: s.updatedAt,
    };
  }
  return null;
}

/**
 * Throw if this world has a live date or hangout underway. Day-spending actions
 * (Sleep, work shifts, minigames) are locked while one is open: running the clock or
 * the energy budget mid-sitting would misfile its events, reset stamina under it, or
 * neglect-decay the very person you're out with. The client disables those buttons,
 * but only off its own per-tab `activeDate` state — a second tab that loaded before
 * the sitting began can still send the request, so enforce it here.
 */
export function assertNoActiveDate(worldId: string): void {
  const openDate = getActiveDateForWorld(worldId);
  if (openDate) {
    const openNames = openDate.participants.map((p) => p.characterName).join(' and ') || openDate.characterName;
    throw badRequest(
      `You're ${openDate.mode === 'hangout' ? 'hanging out' : 'on a date'} with ${openNames} — wrap that up first.`,
    );
  }
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

export interface GroupSpeakerPlan {
  characterIds: string[];
  /** Internal director rationale; useful when diagnosing a surprising turn choice. */
  reason: string;
  /** True when the selector failed validation/model access and all attendees were used. */
  fallback: boolean;
}

export interface GroupSpeakerSelectionOptions {
  latestReads?: Record<string, { engagement: number; label: string; note: string } | null>;
  signal?: AbortSignal;
}

/**
 * Decide who actually speaks after a player turn in a shared scene. The selector
 * sees the room as a whole; individual dialogue models still own the words. A
 * failure preserves the old all-attendees behavior rather than stranding a turn.
 */
export async function selectGroupSpeakers(
  sessionId: string,
  candidateCharacterIds: string[],
  options: GroupSpeakerSelectionOptions = {},
): Promise<GroupSpeakerPlan> {
  const session = getSession(sessionId);
  const candidateSet = new Set(candidateCharacterIds);
  const roster = sessionParticipantsRepo
    .listBySession(sessionId)
    .filter((participant) => participant.state === 'present' && candidateSet.has(participant.characterId))
    .sort((a, b) => a.seat - b.seat);
  const fallback = (reason: string): GroupSpeakerPlan => ({
    characterIds: roster.map((participant) => participant.characterId),
    reason,
    fallback: true,
  });
  if (roster.length <= 1) {
    return {
      characterIds: roster.map((participant) => participant.characterId),
      reason: roster.length === 1 ? 'Only one attendee is present.' : 'No attendee is present.',
      fallback: false,
    };
  }

  const allMessages = messagesRepo.listBySession(sessionId);
  const fullRoster = sessionParticipantsRepo.listBySession(sessionId);
  const participantNames = Object.fromEntries(
    fullRoster.map((participant) => [participant.characterId, getCharacter(participant.characterId).name]),
  );
  const recentCharacterReplies = allMessages
    .filter((message) => message.role === 'character' && message.characterId && participantNames[message.characterId])
    .slice(-8);
  const attendees = roster.map((participant) => {
    const character = getCharacter(participant.characterId);
    const relationship = getRelationship(character.id);
    const lastReplyIndex = recentCharacterReplies.findLastIndex(
      (message) => (message.characterId ?? session.characterId) === character.id,
    );
    const recentReplyCount = recentCharacterReplies.filter(
      (message) => (message.characterId ?? session.characterId) === character.id,
    ).length;
    const dateNeed = character.worldId && isDateMode(session.mode)
      ? dateNeedFor(character.worldId, ensureWorldState(character.worldId).day, character.id).behavior
      : null;
    return {
      seat: participant.seat,
      character,
      relationship,
      liveRapport: participant.judged ? participant.rapport : null,
      liveVibe: participant.judged && participant.rapport != null ? rapportLabel(participant.rapport) : null,
      dateNeed,
      relationsToOthers: roster
        .filter((other) => other.characterId !== character.id)
        .map((other) => {
          const otherCharacter = getCharacter(other.characterId);
          const link = character.links.find((candidate) => candidate.targetId === other.characterId);
          return `${otherCharacter.name}: ${link ? CHARACTER_LINK_LABELS[link.kind] : 'no authored link'}`;
        }),
      recentReplyCount,
      replyTurnsSinceLastSpoke:
        lastReplyIndex < 0 ? null : recentCharacterReplies.length - 1 - lastReplyIndex,
      latestRead: options.latestReads?.[character.id] ?? null,
    };
  });

  const settings = getLlmSettings();
  const result = await callStructuredLlm(
    GroupSpeakerSelectionSchema,
    buildGroupSpeakerSelectionMessages({
      mode: session.mode,
      playerName: getOrCreatePlayer(playerIdForWorldOrDefault(getCharacter(session.characterId).worldId)).name,
      attendees,
      recentMessages: allMessages.slice(-12),
      participantNames,
    }),
    {
      settings,
      role: 'evaluator',
      task: 'Choose who should speak next in this shared conversation.',
      schemaName: 'GroupSpeakerSelection',
      minMaxTokens: 384,
      baseTemperature: Math.min(settings.temperature, 0.35),
      signal: options.signal,
    },
  );
  if (!result.ok) return fallback(`Speaker selector failed: ${result.error}`);

  const bySeat = new Map(roster.map((participant) => [participant.seat, participant]));
  const selected = result.data.speakerSeats.map((seat) => bySeat.get(seat));
  if (selected.some((participant) => participant == null)) {
    return fallback('Speaker selector returned a seat that is not currently present.');
  }
  return {
    characterIds: selected.map((participant) => participant!.characterId),
    reason: result.data.reason.trim(),
    fallback: false,
  };
}

/** Persist the director plan so a dropped stream retries only the intended speakers. */
export function recordGroupSpeakerPlan(messageId: string, plan: GroupSpeakerPlan): void {
  messagesRepo.mergeMetadata(messageId, {
    groupSpeakerPlan: {
      characterIds: [...plan.characterIds],
      reason: plan.reason,
      fallback: plan.fallback,
    },
  });
}

/** Read a validated, ordered plan from the player message; null means legacy turn. */
export function getRecordedGroupSpeakerIds(message: Message): string[] | null {
  const raw = message.metadata.groupSpeakerPlan;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ids = (raw as Record<string, unknown>).characterIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) return null;
  const unique = [...new Set(ids as string[])];
  return unique.length === ids.length ? unique : null;
}

function addCharacterMessage(
  sessionId: string,
  text: string,
  metadata: Record<string, unknown> = {},
  characterId?: string,
): Message {
  const speakerId = characterId ?? getSession(sessionId).characterId;
  const message = MessageSchema.parse({
    id: newId('msg'),
    sessionId,
    role: 'character',
    characterId: speakerId,
    text,
    metadata,
    createdAt: Date.now(),
  });
  return messagesRepo.insert(message);
}

/** Insert a third-person narration "beat" (scene-setting, gift lines, etc.) — not
 *  dialogue. Rendered centered/quiet on the client and fed back to the model as
 *  `Narration: …` so later turns stay aware of it. */
function addNarratorMessage(sessionId: string, text: string, metadata: Record<string, unknown> = {}): Message {
  const message = MessageSchema.parse({
    id: newId('msg'),
    sessionId,
    role: 'narrator',
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
 * True when this is the player's FIRST time actually meeting the character — so the
 * character can't know the player's name or anything about them. Stable for the whole
 * sitting: it looks at OTHER (prior) meetings the player actually spoke in — dates and
 * hangouts alike, since either one is a real introduction — and requires the
 * relationship still be at the near-strangers band (so warmth built some other way
 * doesn't fake a stranger). A bare `chat` is never a "meeting".
 */
function isFirstMeeting(
  session: ConversationSession,
  relationship: Relationship,
  characterId = session.characterId,
): boolean {
  if (!isMeetingMode(session.mode)) return false;
  if (bandIndex(warmthBand(relationship)) > 0) return false; // already warmed up somehow
  const priorIds = new Set([
    ...sessionsRepo.listByCharacter(characterId).map((prior) => prior.id),
    ...sessionParticipantsRepo.listByCharacter(characterId).map((participant) => participant.sessionId),
  ]);
  return ![...priorIds].some((priorId) => {
    const prior = sessionsRepo.get(priorId);
    return prior?.id !== session.id && prior != null && isMeetingMode(prior.mode) && messagesRepo.hasRole(prior.id, 'player');
  });
}

export function buildPromptContextForSession(
  session: ConversationSession,
  messages: Message[],
  opts?: { turnVerdict?: TurnVerdict | null; characterId?: string },
): PromptContext {
  const character = getCharacter(opts?.characterId ?? session.characterId);
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
    participantNames: Object.fromEntries(
      sessionParticipantsRepo
        .listBySession(session.id)
        .map((participant) => [participant.characterId, getCharacter(participant.characterId).name]),
    ),
    coAttendees: sessionParticipantsRepo
      .listBySession(session.id)
      .filter((participant) => participant.state === 'present' && participant.characterId !== character.id)
      .map((participant) => getCharacter(participant.characterId))
      .map((attendee) => {
        const link = character.links.find((candidate) => candidate.targetId === attendee.id);
        return {
          characterId: attendee.id,
          name: attendee.name,
          personality: attendee.personality,
          relation: link ? CHARACTER_LINK_LABELS[link.kind] : 'another attendee',
          relationshipStyle: attendee.relationshipStyle,
          playerRelationshipStatus: currentStatus(getRelationship(attendee.id)),
          romanticallyCompatibleWithPlayer: romanticCompatFor(attendee.id)?.mutual ?? true,
        };
      }),
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
    // expense; 0 = free/anywhere. Null for a hangout or a plain chat — neither
    // spends anything, so there is nothing to notice.
    venueTier: location && isDateMode(session.mode) ? location.priceTier ?? 0 : null,
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
    // A hangout carries no such expectation to read (or trample), by design.
    dateNeed:
      world && worldDay != null && isDateMode(session.mode)
        ? dateNeedFor(world.id, worldDay, character.id).behavior
        : null,
    guardedness: character.guardedness,
    turnVerdict: opts?.turnVerdict ?? null,
    firstMeeting: isFirstMeeting(session, relationship, character.id),
    // NPC(s) the world-sim has paired this character off with — so a coupled-off
    // character is honest about being taken rather than denying it on a date.
    npcPartners: currentNpcPartners(character).map((p) => p.name),
  };
}

/** Build the dialogue ChatMessages for a session (used by streaming + preview).
 *  An optional `turnVerdict` (the just-computed read of the player's latest message)
 *  is threaded into the prompt so the character's reply honestly reflects it. */
export function buildDialogueRequest(
  sessionId: string,
  turnVerdict?: TurnVerdict | null,
  characterId?: string,
): ChatMessage[] {
  const session = getSession(sessionId);
  const messages = messagesRepo.listBySession(sessionId);
  const ctx = buildPromptContextForSession(session, messages, { turnVerdict, characterId });
  return buildDialogueMessages(ctx);
}

// --- dialogue (plain text) --------------------------------------------------

/** Generate a non-streamed character reply and persist it. */
export async function generateReply(sessionId: string, characterId?: string): Promise<Message> {
  const session = getSession(sessionId);
  const settings = getLlmSettings();
  const chatMessages = buildDialogueRequest(sessionId, null, characterId);
  const adapter = getAdapter(settings);
  const result = await adapter.chat({
    messages: chatMessages,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
  });
  // Strip any <think>…</think> reasoning from the natural-language reply.
  const text = stripThink(result.content).trim();
  if (!text) throw badRequest('The model returned an empty reply.');
  const message = addCharacterMessage(sessionId, text, {}, characterId);
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
  characterId?: string,
): Promise<{ content: string; finishReason?: string }> {
  getSession(sessionId);
  const settings = getLlmSettings();
  const chatMessages = buildDialogueRequest(sessionId, turnVerdict, characterId);
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
export function persistStreamedReply(sessionId: string, text: string, characterId?: string): Message {
  const session = getSession(sessionId);
  const message = addCharacterMessage(sessionId, text.trim(), {}, characterId);
  touchSession(session);
  return message;
}

/**
 * Remove the session's trailing character reply so it can be REGENERATED in place
 * (the player asked to rewrite a bad/looping line). Called inside the per-session
 * reply lock by the regenerate route, which then re-runs `streamReply` against the
 * now-trailing player turn — deliberately WITHOUT re-judging (the rapport already
 * moved when the turn was first sent; a regenerate only rewrites the prose).
 *
 * Throws when the last message isn't a plain, regenerable character line: a player
 * turn or narrator beat (nothing to rewrite), or a consequence-bearing line whose
 * effects are already applied and must not be silently dropped — a walkout, a
 * lost-interest exit, an amicable farewell, or a breakup-intent reaction.
 */
export function dropReplyForRegen(sessionId: string): Message {
  const session = getSession(sessionId);
  if (session.ended) throw badRequest('This date has already ended.');
  const messages = messagesRepo.listBySession(sessionId);
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'character') {
    throw badRequest('There’s no reply here to regenerate.');
  }
  // Only a reply to one of YOUR turns can be regenerated — not the character's
  // scene-opening greeting (regenerating it has no player turn to answer).
  if (!messages.some((m) => m.role === 'player')) {
    throw badRequest('There’s nothing of yours here for them to reply to yet.');
  }
  const md = last.metadata ?? {};
  if (md.walkout || md.left || md.farewell || md.breakupIntent) {
    throw badRequest('That line ended the date, so it can’t be regenerated.');
  }
  // Gift reactions and DTR answers carry applied consequences AND load-bearing
  // metadata: regenerating one replaces it with a plain reply whose metadata is
  // empty — un-hiding the gift from the end-of-date evaluator's `!metadata.gift`
  // filter (double-counting the gift), or orphaning an applied status change.
  if (md.gift || md.dtr) {
    throw badRequest('That reaction already landed, so it can’t be regenerated.');
  }
  messagesRepo.delete(last.id);
  touchSession(session);
  return last;
}

const GROUP_DATE_COLLISION_SESSION_FLAG = 'jealousy:groupCollisionSessionId';
const GROUP_DATE_UNWITTING_PENALTY = { trust: -4, comfort: -3, respect: -5, tension: 7 } as const;

interface GroupDateRelationshipCollision {
  kind: 'betrayed_partner' | 'unwitting_date';
  other: Character;
  ownStatus: RelationshipStatus;
  otherStatus: RelationshipStatus;
}

/** Find the role this attendee occupies in a group-date ambush. An established
 * monogamous partner objects to ANY other plausible romantic date, even when that
 * connection is brand new. The other attendee is also allowed to recognize that
 * the player dragged them into betraying somebody. A fully orientation-incompatible
 * attendee is treated as platonic and does not create a collision. */
function groupDateRelationshipCollisionFor(
  session: ConversationSession,
  roster: SessionParticipant[],
  characterId: string,
): GroupDateRelationshipCollision | null {
  if (!isDateMode(session.mode) || roster.length < 2) return null;
  const character = getCharacter(characterId);
  const ownStatus = currentStatus(getRelationship(character.id));
  const others = roster.filter(
    (participant) => participant.state === 'present' && participant.characterId !== character.id,
  );

  if (character.relationshipStyle === 'monogamous' && ownStatus !== 'none') {
    const otherParticipant = others.find((participant) => {
      const status = currentStatus(getRelationship(participant.characterId));
      return status !== 'none' || romanticCompatFor(participant.characterId)?.mutual !== false;
    });
    if (otherParticipant) {
      const other = getCharacter(otherParticipant.characterId);
      return {
        kind: 'betrayed_partner',
        other,
        ownStatus,
        otherStatus: currentStatus(getRelationship(other.id)),
      };
    }
  }

  const actorIsRomanticDate = ownStatus !== 'none' || romanticCompatFor(character.id)?.mutual !== false;
  if (!actorIsRomanticDate) return null;
  const betrayedParticipant = others.find((participant) => {
    const other = getCharacter(participant.characterId);
    return other.relationshipStyle === 'monogamous'
      && currentStatus(getRelationship(other.id)) !== 'none';
  });
  if (!betrayedParticipant) return null;
  const other = getCharacter(betrayedParticipant.characterId);
  return {
    kind: 'unwitting_date',
    other,
    ownStatus,
    otherStatus: currentStatus(getRelationship(other.id)),
  };
}

/** Apply the face-to-face discovery once, before either opening line is generated.
 * Unlike ordinary jealousy this is not a rumor or a roll: everyone is in the room,
 * so the betrayal and the unwilling third party's offense are deterministic. */
function applyGroupDateRelationshipCollisions(
  session: ConversationSession,
  roster: SessionParticipant[],
): void {
  for (const participant of roster) {
    if (participant.state !== 'present') continue;
    const collision = groupDateRelationshipCollisionFor(session, roster, participant.characterId);
    if (!collision) continue;

    const character = getCharacter(participant.characterId);
    const relationship = getRelationship(character.id);
    if (relationship.flags[GROUP_DATE_COLLISION_SESSION_FLAG] === session.id) continue;

    const day = character.worldId ? ensureWorldState(character.worldId).day : 0;
    const betrayedPartner = collision.kind === 'betrayed_partner';
    const committed = betrayedPartner && isCommitted(relationship);
    applyRelationshipChange(
      character.id,
      {
        ...(betrayedPartner
          ? committed
            ? JEALOUSY_PENALTY_COMMITTED
            : JEALOUSY_PENALTY
          : GROUP_DATE_UNWITTING_PENALTY),
      },
      {
        source: 'group_date_collision',
        detail: {
          kind: collision.kind,
          sessionId: session.id,
          otherCharacterId: collision.other.id,
          ownStatus: collision.ownStatus,
          otherStatus: collision.otherStatus,
        },
      },
    );
    setRelationshipFlag(character.id, 'state:offended', true, { source: 'group_date_collision' });
    setRelationshipFlag(character.id, GROUP_DATE_COLLISION_SESSION_FLAG, session.id, { source: 'group_date_collision' });
    if (betrayedPartner) {
      setRelationshipFlag(character.id, 'state:jealous', true, { source: 'group_date_collision' });
      setRelationshipFlag(character.id, 'jealousy:lastRollDay', day, { source: 'group_date_collision' });
    }
    if (committed) {
      try {
        adjustDespair(character.id, DESPAIR.cheatHit, 'cheating', day);
      } catch {
        /* best-effort */
      }
    }
    const link = linkTo(character.links, collision.other.id);
    const event = recordEvent(betrayedPartner ? 'jealousy_triggered' : 'group_date_ambush', {
      characterId: character.id,
      otherCharacterId: collision.other.id,
      link: link?.kind ?? null,
      committed,
      collisionKind: collision.kind,
      witnessed: true,
      groupDate: true,
      sessionId: session.id,
      day,
    });
    addMemoriesFromEvaluation(
      character.id,
      [
        {
          text: betrayedPartner
            ? collision.otherStatus === 'none'
              ? `The player brought ${collision.other.name} as another romantic date while officially dating me. It felt like an ambush.`
              : `The player brought ${collision.other.name} and me on the same date, and I discovered they were officially dating both of us. It felt like an ambush.`
            : `The player brought me as another date alongside ${collision.other.name}, their monogamous partner, without warning either of us. I was dragged into their relationship conflict.`,
          importance: committed ? 5 : 4,
          tags: betrayedPartner ? ['jealousy', 'conflict', 'date'] : ['conflict', 'date'],
        },
      ],
      event.id,
      session.mode,
    );
  }
}

/**
 * Set the scene when a date opens, so the player has something to react to.
 *
 * - On a FIRST date the character breaks the ice: a single in-character opening
 *   greeting, persisted as the date's first (character) message, so the player
 *   isn't forced to open a date with a total stranger.
 * - On a REPEAT date there's no introduction to make, so instead we lay down a
 *   short third-person "venue flavor" beat — narration, not dialogue — describing
 *   where the character is, what they're doing, and the weather/time of day.
 *
 * Returns the persisted message, or null when it doesn't apply (plain chat, ended,
 * or the session already has turns) or generation fails. Best-effort: never throws —
 * on any failure the date simply falls back to the player opening (and the client's
 * static opening card). Plain chats and ended/active sessions short-circuit BEFORE
 * any LLM call.
 */
export async function openConversation(sessionId: string): Promise<Message | null> {
  let session: ConversationSession;
  try {
    session = getSession(sessionId);
  } catch {
    return null;
  }
  if (session.ended || !isMeetingMode(session.mode)) return null;
  if (messagesRepo.countBySession(sessionId) > 0) return null; // someone already spoke
  const character = getCharacter(session.characterId);
  const firstMeeting = isFirstMeeting(session, getRelationship(character.id));
  const hangout = session.mode === 'hangout';
  const playerName = getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId)).name;

  const settings = getLlmSettings();
  try {
    const roster = sessionParticipantsRepo.listBySession(sessionId);
    if (roster.length > 1) {
      let latest: Message | null = null;
      applyGroupDateRelationshipCollisions(session, roster);
      // A group outing opens as an actual shared scene: every attendee gets one
      // short line in seat order. Building each prompt after persisting the prior
      // line lets the next person hear and naturally follow the opener before them.
      for (const participant of roster) {
        try {
          const openerCharacter = getCharacter(participant.characterId);
          const meetingForFirstTime = isFirstMeeting(
            session,
            getRelationship(openerCharacter.id),
            openerCharacter.id,
          );
          const relationshipCollision = groupDateRelationshipCollisionFor(
            session,
            roster,
            openerCharacter.id,
          );
          const openingMessages = buildDialogueRequest(sessionId, null, openerCharacter.id);
          openingMessages.push({
            role: 'system',
            content:
              `OOC stage direction: this group ${hangout ? 'hangout' : 'date'} is just beginning. You speak now with one short, natural opening in your own voice. ` +
              (relationshipCollision
                ? relationshipCollision.kind === 'betrayed_partner'
                  ? relationshipCollision.otherStatus === 'none'
                    ? `You have just realized the player brought ${relationshipCollision.other.name} as another romantic date while already dating you. Skip the pleasantries: react immediately to the ambush and confront the situation in character. `
                    : `You have just realized the player is officially dating both you and ${relationshipCollision.other.name}. Skip the pleasantries: react immediately to the ambush and confront the situation in character. `
                  : `You have just realized the player brought you as another date alongside their monogamous partner, ${relationshipCollision.other.name}. Skip the pleasantries: react immediately to being dragged into the ambush. `
                : meetingForFirstTime
                  ? `This is the first time you and the player have met, so greet them and introduce yourself without giving a speech. `
                  : `You already know the player, so greet them in a way that fits your relationship. `) +
              `Speaker attribution is strict: the player is ${playerName}, and the player has not spoken yet. ` +
              `Any transcript turn labeled OTHER ATTENDEE came from that named character, never from the player. ` +
              `Track who addressed whom literally: if another attendee says ${playerName}'s name, they are speaking to the player (${playerName}), not to you. ` +
              `You may acknowledge what another attendee said, but do not answer their greeting with "you too," "me too," or similar wording as though the player greeted you. ` +
              `Greet ${playerName} independently, or reply directly to an attendee only when they actually addressed you. ` +
              `Keep it to one or two lines and do not write dialogue for anyone else.`,
          });
          const result = await getAdapter(settings).chat(
            { messages: openingMessages, temperature: settings.temperature, maxTokens: settings.maxTokens },
          );
          const text = stripThink(result.content).trim();
          if (!text) continue;
          latest = addCharacterMessage(
            sessionId,
            text,
            { opener: true, groupOpener: true },
            openerCharacter.id,
          );
        } catch {
          /* one missed opener should not silence the other attendee */
        }
      }
      if (latest) touchSession(session);
      return latest;
    }

    const messages = buildDialogueRequest(sessionId);
    if (firstMeeting) {
      messages.push({
        role: 'system',
        content:
          (hangout
            ? `OOC stage direction: the two of you are just meeting up to hang out, and this is the first time you've met. `
            : `OOC stage direction: the date is just beginning and this is the first time the two of you are meeting. `) +
          `You speak first — open the conversation yourself with a warm, natural greeting in your own voice: ` +
          `say hello, introduce yourself, and break the ice however suits you. Stay true to how guarded or outgoing you are, ` +
          `and keep it to just a line or two (an opening, not a monologue). Follow everything above about what you do and don't know about them.`,
      });
    } else {
      // Repeat sitting: no introduction needed — set the scene instead, in third person.
      messages.push({
        role: 'system',
        content:
          (hangout
            ? `OOC stage direction: set the scene for the moment the player turns up to hang out. `
            : `OOC stage direction: set the scene for the moment the player arrives at the start of this date. `) +
          `Write 2-3 sentences of vivid third-person narration: where ${character.name} is and what they're doing at the venue, ` +
          `the atmosphere of the place, and the weather and time of day (use the scene and world details above). ` +
          `Describe ${character.name} from the OUTSIDE, by name (e.g. "${character.name} is waiting at a corner table, ..."). ` +
          `This is stage-setting prose for the player to read — NOT a spoken line: do not write any dialogue, do not speak in ` +
          `${character.name}'s voice, no greeting, and no quotation marks or *asterisks* — write it as plain third-person prose. Just the scene.`,
      });
    }
    const adapter = getAdapter(settings);
    const res = await adapter.chat({ messages, temperature: settings.temperature, maxTokens: settings.maxTokens });
    const text = stripThink(res.content).trim();
    if (!text) return null;
    const message = firstMeeting
      ? addCharacterMessage(sessionId, text, { opener: true })
      : addNarratorMessage(sessionId, text, { venueFlavor: true });
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
  characterId: string;
}

/**
 * If the player's latest message is egregious, ask the model (structured) whether
 * the character ends the date and walks out. Applies the walkout's special penalty,
 * grievance, and memory, then voices the farewell — but does NOT end the session
 * itself: the CLIENT runs the normal end-and-evaluate flow next, so a blown-up date
 * is scored in full (stamina, evaluator deltas/memories, milestones, strain), exactly
 * like a date the player ended deliberately. Returns the farewell message + reason,
 * or null. Rare by design; fails safe (no walkout).
 */
export async function attemptWalkout(
  sessionId: string,
  playerText: string,
  signal?: AbortSignal,
  characterId?: string,
): Promise<WalkoutOutcome | null> {
  const session = getSession(sessionId);
  // Date machinery only — a hangout has no rapport to judge, nobody storms out of
  // one, and there is no date to break up or say goodnight to.
  if (session.ended || !isDateMode(session.mode)) return null;
  const targetId = characterId ?? session.characterId;
  const participant = sessionParticipantsRepo.get(sessionId, targetId);
  if ((participant && participant.state !== 'present') || (!participant && targetId !== session.characterId)) return null;
  const character = getCharacter(targetId);
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
    buildWalkoutReactionMessages({
      character,
      relationship,
      recentMessages: recent,
      playerName: getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId)).name,
      participantNames: Object.fromEntries(
        getConversationParticipants(session).map((attendee) => [attendee.characterId, attendee.characterName]),
      ),
    }),
    { settings, role: 'evaluator', task: 'Decide whether the character ends the date now.', schemaName: 'WalkoutReaction', signal },
  );
  if (!result.ok || !result.data.walkout) return null;

  // Apply the walkout's SPECIAL consequences — the things the normal date evaluator
  // can't infer: the penalty for egregious behavior, the carried-forward grievance
  // (state:offended), the same-day cooldown, the despair hit, and a durable conflict
  // memory. We deliberately DO NOT end the session here: like a date the player ends
  // with a natural goodbye (see attemptPlayerFarewell), the CLIENT then runs the
  // normal end-and-evaluate flow, so the blown-up date is still scored IN FULL —
  // stamina spent, evaluator deltas/memories, milestones, strain. endSession is told
  // (via the farewell's metadata) not to "air out" the offense it was the eval for.
  applyRelationshipChange(character.id, { ...WALKOUT_PENALTY }, { source: 'walkout', detail: { reason: result.data.reason } });
  setRelationshipFlag(character.id, 'state:offended', true, { source: 'walkout' });
  const walkoutDay = character.worldId ? ensureWorldState(character.worldId).day : 0;
  if (character.worldId) {
    setRelationshipFlag(character.id, 'walkout:lastDay', walkoutDay, { source: 'walkout' });
    // (Opt-in) cruelty severe enough to drive a deeply-attached partner out feeds
    // the despair spiral — no-op unless enabled AND they were close to you.
    try {
      adjustDespair(character.id, DESPAIR.hostility, 'hostility', walkoutDay);
    } catch {
      /* best-effort */
    }
  }
  const message = addCharacterMessage(
    sessionId,
    result.data.farewellLine.trim(),
    { walkout: true, walkoutReason: result.data.reason },
    character.id,
  );
  sessionParticipantsRepo.setState(sessionId, character.id, 'walked_out', Date.now());
  const walkoutEvent = recordEvent('walkout', {
    characterId: character.id,
    reason: result.data.reason,
    ...(character.worldId ? { day: walkoutDay } : {}),
  });
  // A durable, first-person grievance memory so they carry the blow-up forward (the
  // full evaluator may write its own too; this guarantees a conflict-tagged record).
  const walkoutPlayerName = getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId)).name;
  const walkoutMemory =
    result.data.memory.trim() ||
    (result.data.reason.trim()
      ? `On our date, ${walkoutPlayerName} ${result.data.reason.trim()} — I ended it and walked out.`
      : `${walkoutPlayerName} crossed a line on our date, so I ended it and left.`);
  try {
    addMemoriesFromEvaluation(
      character.id,
      [{ text: walkoutMemory.slice(0, GEN_TEXT.line), importance: 5, tags: ['conflict'] }],
      walkoutEvent.id,
      session.mode,
    );
  } catch {
    /* best-effort: remembering the blow-up must never block the farewell */
  }
  return { message, reason: result.data.reason, characterId: character.id };
}

// --- Live date dynamics (per-turn rapport) ----------------------------------

export interface TurnReadout {
  /** Attendee whose independent read this is. */
  characterId: string;
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
/**
 * Stamp the per-turn judge's read onto the player's message metadata, so a
 * resumed date re-renders its reaction chips instead of losing them with the
 * SSE stream. Engagement only — the chip is qualitative (no numbers shown).
 */
export function recordTurnReaction(messageId: string, engagement: number, characterId?: string): void {
  const message = messagesRepo.get(messageId);
  if (!message) return;
  const session = sessionsRepo.get(message.sessionId);
  const speakerId = characterId ?? session?.characterId;
  if (!speakerId) return;
  const existing = message.metadata.engagementByCharacter;
  const byCharacter =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  byCharacter[speakerId] = engagement;
  messagesRepo.mergeMetadata(messageId, {
    engagementByCharacter: byCharacter,
    // Preserve the original scalar for solo clients and the seat-0 host's chip.
    ...(speakerId === session?.characterId ? { engagement } : {}),
  });
}

export async function judgeTurn(
  sessionId: string,
  signal?: AbortSignal,
  characterId?: string,
): Promise<TurnReadout | null> {
  let session: ConversationSession;
  try {
    session = getSession(sessionId);
  } catch {
    return null;
  }
  // Date machinery only — a hangout has no rapport to judge, nobody storms out of
  // one, and there is no date to break up or say goodnight to.
  if (session.ended || !isDateMode(session.mode)) return null;
  const targetId = characterId ?? session.characterId;
  const participant = sessionParticipantsRepo.get(sessionId, targetId);
  if ((participant && participant.state !== 'present') || (!participant && targetId !== session.characterId)) return null;

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

  const character = getCharacter(targetId);
  const host = character.id === session.characterId;
  // Seed this date's rapport to the character's guarded opening BEFORE judging, so the
  // vibe label fed to the judge (and the first 'rapport' read) reflects a reserved
  // character's cooler start rather than the neutral 50. Idempotent after turn 1.
  const seededRapport = host
    ? ensureRapportSeeded(sessionId, character.guardedness)
    : ensureParticipantRapportSeeded(sessionId, character.id, character.guardedness);
  // Keep the seat-0 participant row in sync with the legacy session-level track so
  // old solo consumers and new roster consumers observe the same host value.
  if (host) sessionParticipantsRepo.setRapport(sessionId, character.id, seededRapport, Date.now(), false);
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
      relationship: getRelationship(character.id),
      needJudge: need?.judge ?? '',
      vibe: rapportLabel(host ? getRapport(sessionId) : getParticipantRapport(sessionId, character.id)),
      recentMessages: all.slice(-8),
      // More memories than the text judge (5): the date judge sees only 8 lines of the
      // live exchange, so it relies on shared history to recognize callbacks/inside jokes.
      memories: selectTopMemories(character.id, 8),
      playerName: getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId)).name,
      participantNames: Object.fromEntries(
        getConversationParticipants(session).map((attendee) => [attendee.characterId, attendee.characterName]),
      ),
    }),
    // Floor the output budget so a chatty `note` can't truncate the JSON mid-string
    // under the evaluator role's small maxTokens (truncation → parse fail → no rapport change).
    { settings, role: 'evaluator', minMaxTokens: 512, task: 'Judge how the last message landed on this date.', schemaName: 'TurnReaction', signal },
  );
  if (!result.ok) return null; // fail-safe — no rapport change

  const { rapport, delta } = host
    ? applyTurnEngagement(sessionId, result.data.engagement, character.guardedness, settings.difficulty)
    : applyParticipantTurnEngagement(
        sessionId,
        character.id,
        result.data.engagement,
        character.guardedness,
        settings.difficulty,
      );
  if (host) sessionParticipantsRepo.setRapport(sessionId, character.id, rapport, Date.now(), true);
  // Persist the mood next to rapport so a resumed date restores the portrait + chip.
  if (host) setLastExpression(sessionId, result.data.expression);
  setParticipantLastExpression(sessionId, character.id, result.data.expression);
  return {
    characterId: character.id,
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
  characterId: string;
}

/**
 * If this date's rapport has cratered (the character has quietly lost interest),
 * they call it a night themselves — a soft, non-hostile early exit (distinct from a
 * walkout, which is for egregious behavior). Runs BEFORE the reply on the player's
 * next message, so a "losing interest" turn warns first, then they leave. Applies the
 * leave penalty + a memory, then (like a natural farewell) leaves the session OPEN so
 * the CLIENT runs the normal end-and-evaluate flow — the flat date is scored in full
 * (stamina, deltas, memories, milestones, strain). Returns the farewell, or null.
 * Fails safe (no early exit on error).
 */
export async function maybeLeaveForLostInterest(
  sessionId: string,
  signal?: AbortSignal,
  characterId?: string,
): Promise<LeaveOutcome | null> {
  const session = getSession(sessionId);
  // Date machinery only — a hangout has no rapport to judge, nobody storms out of
  // one, and there is no date to break up or say goodnight to.
  if (session.ended || !isDateMode(session.mode)) return null;
  const targetId = characterId ?? session.characterId;
  const participant = sessionParticipantsRepo.get(sessionId, targetId);
  if ((participant && participant.state !== 'present') || (!participant && targetId !== session.characterId)) return null;
  const settings = getLlmSettings();
  const host = targetId === session.characterId;
  if (
    !(host
      ? hasLostInterest(sessionId, settings.difficulty)
      : participantHasLostInterest(sessionId, targetId, settings.difficulty))
  ) {
    return null;
  }
  // The character already made an exit this session (the line is in the transcript,
  // but the client may have missed the SSE event to a refresh/disconnect). Rapport is
  // deliberately left cratered for endSession to score, so without this check the
  // NEXT message after a resume would re-apply the leave penalty and stamp a second
  // goodbye. Same for a walkout/farewell exit: they're gone; don't leave twice.
  const priorExit = messagesRepo
    .listBySession(sessionId)
    .some(
      (m) =>
        m.role === 'character' &&
        (m.characterId ?? session.characterId) === targetId &&
        (m.metadata?.['left'] === true || m.metadata?.['walkout'] === true || m.metadata?.['farewell'] === true),
    );
  if (priorExit) return null;

  const character = getCharacter(targetId);

  // A brief, in-character "I should get going" — plain dialogue, low budget.
  let line = '';
  try {
    const messages = buildDialogueRequest(sessionId, null, character.id);
    messages.push({
      role: 'system',
      content:
        `OOC stage direction: this date isn't working for you — you've quietly lost interest and want to wrap it up now. ` +
        `Give a brief, in-character send-off — a few sentences (roughly two or three), not a single clipped line — making a polite excuse to wrap things up and head out (somewhere else to be, an early start tomorrow). ` +
        `Not cruel, just done — no questions, and no plans to meet again.`,
    });
    const adapter = getAdapter(settings);
    const res = await adapter.chat({ messages, temperature: settings.temperature, maxTokens: 300 }, signal);
    line = stripThink(res.content).trim();
  } catch {
    line = '';
  }
  if (!line) line = `Hey — it's been a long week and I'm pretty wiped. I think I'm gonna head out. Take care, okay?`;

  // Apply the soft-leave's penalty + a memory of the fizzle, then voice the goodbye —
  // but DON'T end the session: like a natural farewell, the CLIENT runs the normal
  // end-and-evaluate flow next, so the flat date is scored in full (stamina, evaluator
  // deltas/memories, the cratered-rapport consequence, milestones, strain). Rapport is
  // left intact on purpose so endSession's low-rapport effect still lands.
  applyRelationshipChange(character.id, { ...RAPPORT_LEAVE_PENALTY }, { source: 'rapport', detail: { reason: 'lost_interest' } });
  const message = addCharacterMessage(sessionId, line, { left: true }, character.id);
  sessionParticipantsRepo.setState(sessionId, character.id, 'left_early', Date.now());
  const leftEvent = recordEvent('date_left', { characterId: character.id, reason: 'lost_interest' });
  // Remember the fizzle so a run of flat dates registers (the evaluator may add its own).
  const leftPlayerName = getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId)).name;
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
      session.mode,
    );
  } catch {
    /* best-effort */
  }
  return { message, reason: 'lost_interest', characterId: character.id };
}

// --- Player-initiated breakup -----------------------------------------------

/** Cheap no-LLM screen for a player message that reads like ending the relationship. */
const BREAKUP_INTENT_RE =
  /\b(break(?:ing)?\s*up|broke\s*up|it'?s\s*over|we'?re\s*(?:over|through|done)|i'?m\s*done\s+with\s+(?:you|us|this)|end\s+(?:things|this|it|us|our\s+relationship)|leav(?:e|ing)\s+you|don'?t\s+want\s+to\s+(?:be\s+with\s+you|see\s+you|date\s+you|be\s+together)|not\s+work(?:ing)?\s+out\s+between\s+us)\b/i;

export interface BreakupIntentOutcome {
  /** The character's reaction line (persisted as a character message). */
  message: Message;
  reaction: 'accept' | 'hurt' | 'plead';
  characterId: string;
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
  characterId?: string,
): Promise<BreakupIntentOutcome | null> {
  const session = getSession(sessionId);
  // Date machinery only — a hangout has no rapport to judge, nobody storms out of
  // one, and there is no date to break up or say goodnight to.
  if (session.ended || !isDateMode(session.mode)) return null;
  if (!BREAKUP_INTENT_RE.test(playerText)) return null;

  const targetId = characterId ?? session.characterId;
  const participant = sessionParticipantsRepo.get(sessionId, targetId);
  if (!participant || participant.state !== 'present') return null;
  const character = getCharacter(targetId);
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
    { settings, role: 'evaluator', task: 'Decide whether the player is genuinely breaking up, and react in character.', schemaName: 'PlayerBreakupReaction', signal },
  );
  // Not genuine (joking/hypothetical/opposite) or a failed call → normal reply.
  if (!result.ok || !result.data.genuine) return null;

  // The reaction rides in the metadata so a resume can re-derive the confirm prompt
  // (the SSE event carrying it is lost if the tab closes before it arrives).
  const message = addCharacterMessage(sessionId, result.data.line.trim(), {
    breakupIntent: true,
    breakupReaction: result.data.reaction,
  }, character.id);
  return { message, reaction: result.data.reaction, characterId: character.id };
}

// --- Player-initiated farewell (natural end of date) ------------------------

/** Cheap no-LLM screen for a player message that reads like winding the date down. */
const FAREWELL_INTENT_RE =
  /\b(i\s*(?:should|gotta|have\s*to|need\s*to|better|ought\s*to|'?ll)\s+(?:get\s*going|get\s*home|head(?:ing)?\s*(?:out|home|off|back)|take\s*off|leave|go|run|call\s*it)|i'?m\s+(?:gonna|going\s*to)\s+(?:get\s*going|head(?:ing)?\s*(?:out|home)|take\s*off|call\s*it|go|leave)|head(?:ing)?\s+(?:out|home|off)\s*(?:now)?|get\s*going|call\s*it\s+(?:a\s+night|a\s+day|here|quits)|wrap(?:ping)?\s+(?:this|it)\s+up|let'?s\s+call\s+it|that'?s\s+my\s+cue|time\s+(?:for\s+me\s+)?to\s+(?:go|head\s*out|leave)|see\s+you\s+(?:around|later|next\s+time|soon)|good\s*night|i'?d\s+better\s+(?:go|get\s*going|head|run)|gotta\s+(?:run|go|head\s*out)|getting\s+late)\b/i;

export interface FarewellOutcome {
  /** The character's send-off, persisted as a character message. */
  message: Message;
  /** Expression for the live portrait as they say goodbye. */
  expression: string;
  characterId: string;
  /** True when nobody remains at the shared date. */
  terminal: boolean;
}

/**
 * If the player's latest message reads like an AMICABLE end to the date ("I
 * should get going") — not a breakup, not hostility — ask the model (structured)
 * whether they genuinely mean to leave now and, if so, voice the character's
 * goodbye. Unlike a walkout or a lost-interest exit, this does NOT end the
 * session itself: it persists the send-off and lets the CLIENT run the normal
 * end-and-evaluate flow, so a date the player chose to end naturally is scored in
 * full (deltas, memories, milestones). Returns the farewell + portrait
 * expression, or null (→ fall through to a normal reply) when there's no farewell
 * intent, the model judges it non-genuine (a bathroom break, proposing the next
 * thing, just musing about the time), or the structured call fails.
 */
export async function attemptPlayerFarewell(
  sessionId: string,
  playerText: string,
  signal?: AbortSignal,
  characterId?: string,
): Promise<FarewellOutcome | null> {
  const session = getSession(sessionId);
  // Date machinery only — a hangout has no rapport to judge, nobody storms out of
  // one, and there is no date to break up or say goodnight to.
  if (session.ended || !isDateMode(session.mode)) return null;
  if (!FAREWELL_INTENT_RE.test(playerText)) return null;

  const targetId = characterId ?? session.characterId;
  const participant = sessionParticipantsRepo.get(sessionId, targetId);
  if (!participant || participant.state !== 'present') return null;
  const character = getCharacter(targetId);
  const relationship = getRelationship(character.id);
  const settings = getLlmSettings();
  const recent = messagesRepo.listBySession(sessionId).slice(-12);
  const result = await callStructuredLlm(
    PlayerFarewellReactionSchema,
    buildPlayerFarewellMessages({
      character,
      relationship,
      vibe: rapportLabel(
        character.id === session.characterId
          ? getRapport(sessionId)
          : getParticipantRapport(sessionId, character.id),
      ),
      recentMessages: recent,
      playerName: getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId)).name,
    }),
    { settings, role: 'evaluator', task: 'Decide whether the player is ending the date, and voice the goodbye.', schemaName: 'PlayerFarewellReaction', signal },
  );
  // Not genuine (stepping away / proposing more / musing) or a failed call → normal reply.
  if (!result.ok || !result.data.ending) return null;

  const message = addCharacterMessage(
    sessionId,
    result.data.farewellLine.trim(),
    { farewell: true },
    character.id,
  );
  setParticipantLastExpression(sessionId, character.id, result.data.expression.trim());
  const groupDate = sessionParticipantsRepo.listBySession(sessionId).length > 1;
  if (groupDate) sessionParticipantsRepo.setState(sessionId, character.id, 'departed', Date.now());
  const terminal = !groupDate
    || sessionParticipantsRepo.listBySession(sessionId).every((entry) => entry.state !== 'present');
  return { message, expression: result.data.expression.trim(), characterId: character.id, terminal };
}

/**
 * The one-time costs + housekeeping EVERY concluding date/event owes, no matter
 * which path ends it: the venue charge, the day action, the last-seen/date
 * stamp, one session of buff decay, and the live-rapport cleanup.
 * endSessionInner applies this same set inline (staged around its required
 * evaluator); this helper exists for the paths that end a date WITHOUT the
 * evaluator — a confirmed player breakup, a DTR backfire — which previously
 * flipped `ended` directly and escaped every cost: free venue, free day action,
 * a stale session_rapport row, and a neglect clock that never stamped.
 *
 * These ends are FORCED (the exit already happened in-fiction, the session row
 * is already ended), so the venue charge clamps to the wallet instead of
 * throwing — a drained wallet must not block the conclusion.
 */
export function settleForcedDateEnd(session: ConversationSession): void {
  clearRapport(session.id);
  // Only dates reach here — the paths that force an end (a confirmed breakup, a DTR
  // backfire) are date-only — but gate anyway so a future caller can't sneak a
  // hangout into the venue charge.
  if (!isDateMode(session.mode)) return;
  const character = getCharacter(session.characterId);
  if (!character.worldId) return;
  const venue = resolveSessionLocation(session.locationId, character, worldsRepo.get(character.worldId) ?? null);
  const propVenue = propertyVenueInfo(session.locationId, character.worldId);
  const cost = propVenue ? 0 : venueCost(venue?.priceTier);
  const pid = playerIdForWorld(character.worldId);
  const charge = Math.min(cost, getOrCreatePlayer(pid).money);
  if (charge > 0) spendMoney(charge, pid);
  spendStamina(character.worldId);
  const attendeeIds = sessionParticipantsRepo.listBySession(session.id).map((entry) => entry.characterId);
  for (const characterId of attendeeIds.length > 0 ? attendeeIds : [session.characterId]) {
    stampLastDate(characterId, ensureWorldState(character.worldId).day);
    decayRelationshipBuffs(characterId);
  }
}

/**
 * Confirm a player-initiated breakup: apply it (server-owned, scarred like any
 * breakup) and end the date. Texting stays open afterward so the player can
 * still try to win them back later. Face-to-face, so NO breakup text is queued.
 */
export function confirmPlayerBreakup(sessionId: string, characterId?: string): PlayerBreakupResponse {
  const session = getSession(sessionId);
  if (session.ended) throw badRequest('This date has already ended.');
  const targetId = characterId ?? session.characterId;
  const participant = sessionParticipantsRepo.get(sessionId, targetId);
  if (!participant || participant.state !== 'present') {
    throw badRequest('Choose someone who is still at this date.');
  }
  const character = getCharacter(targetId);
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
  const groupDate = sessionParticipantsRepo.listBySession(sessionId).length > 1;
  if (groupDate) sessionParticipantsRepo.setState(sessionId, character.id, 'departed', Date.now());
  const terminal = !groupDate
    || sessionParticipantsRepo.listBySession(sessionId).every((entry) => entry.state !== 'present');
  const ended = sessionsRepo.update(
    ConversationSessionSchema.parse({ ...session, ended: terminal || session.ended, updatedAt: Date.now() }),
  );
  // Ending by breakup still CONCLUDES a real date — settle the one-time costs the
  // normal end path charges. Without this, "I think we should break up" + confirm
  // was a free exit from any date: no venue charge, no day action spent.
  if (terminal) settleForcedDateEnd(ended);

  const relationship: Relationship = getRelationship(character.id);
  return { characterId: character.id, relationship, fromStatus, ended: ended.ended };
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
  // Serialized with send/retry/end under the session's turn lock: the summary write
  // below rebuilds the session row from a pre-await snapshot, so racing a concurrent
  // reply or end would silently drop its ended/updatedAt write. Safe for the
  // fire-and-forget maybeAutoSummarize call inside a locked turn — it isn't awaited
  // there, so it just queues behind the turn that spawned it.
  return withKeyedLock(`conv-reply:${sessionId}`, () => summarizeSessionInner(sessionId));
}

async function summarizeSessionInner(sessionId: string): Promise<ConversationSession> {
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
 * End a session and run the STRUCTURED evaluator. The evaluator is REQUIRED to
 * conclude a plain manual "End & evaluate": if it fails (e.g. the model is offline),
 * the date is NOT ended — nothing is mutated and the session stays open so the player
 * can retry once the model is back. A NARRATIVE exit (walkout / lost-interest leave /
 * spoken farewell) has already played out in-fiction, so it still finalizes even if
 * the eval fails — it just carries no evaluator deltas/memories. Stat/memory mutations
 * from the evaluation happen only when the structured result validates.
 */
/**
 * Persist a concluded sitting's report card (best-effort). World-bound meetings
 * (dates, events, hangouts) only — a worldless chat has no Date tab to replay on,
 * and nothing at stake. The stored payload carries its `session.mode`, so the
 * replayed recap knows whether to read as a date or a hangout.
 */
function persistDateResult(response: EndSessionResponse): void {
  const s = response.session;
  if (!isMeetingMode(s.mode)) return;
  try {
    const worldId = charactersRepo.get(s.characterId)?.worldId;
    if (!worldId) return;
    dateResultsRepo.put(s.id, worldId, JSON.stringify(response), Date.now());
  } catch {
    /* the report card is best-effort; never block ending a date */
  }
}

/** Read and validate a durable report by session, regardless of seen state. */
function getPersistedDateResult(sessionId: string): EndSessionResponse | null {
  const row = dateResultsRepo.get(sessionId);
  if (!row) return null;
  try {
    return EndSessionResponseSchema.parse(JSON.parse(row.payload));
  } catch {
    // A malformed/outdated payload should not be returned on retries or replayed.
    dateResultsRepo.markSeen(sessionId);
    return null;
  }
}

/**
 * The world's newest end-of-date report the client hasn't acknowledged, if any —
 * the replay source for a report whose HTTP response died with a closed tab.
 *
 * DELIVER-ONCE: a successful read retires the report. The replay exists to recover
 * a LOST response; without self-acknowledging here, a report whose ack never fired
 * (the player left the recap via nav, a dropped ack request) would replay on every
 * Date-tab visit for the rest of the save.
 */
export function getPendingDateResult(worldId: string): EndSessionResponse | null {
  const row = dateResultsRepo.latestUnseenByWorld(worldId);
  if (!row) return null;
  const result = getPersistedDateResult(row.sessionId);
  if (result) dateResultsRepo.markSeen(row.sessionId);
  return result;
}

/** Acknowledge a session's end-of-date report (shown live, or replayed). */
export function markDateResultSeen(sessionId: string): void {
  dateResultsRepo.markSeen(sessionId);
}

/**
 * Pick the date's most striking JUDGED player line for the recap keepsake: the
 * best line if anything landed (engagement ≥ 1), else the worst if something
 * stung (≤ −1); ties go to the LATER line (the later moment reads truer). Null
 * when nothing was judged or everything read neutral.
 */
function pickJudgedLine(messages: Message[], characterId?: string): { text: string; engagement: number } | null {
  let best: { text: string; engagement: number } | null = null;
  let worst: { text: string; engagement: number } | null = null;
  for (const m of messages) {
    if (m.role !== 'player') continue;
    const raw = characterId
      ? (() => {
          const reads = m.metadata?.engagementByCharacter;
          return reads && typeof reads === 'object' && !Array.isArray(reads)
            ? (reads as Record<string, unknown>)[characterId]
            : undefined;
        })()
      : m.metadata?.engagement;
    if (typeof raw !== 'number') continue;
    const e = Math.max(-3, Math.min(3, Math.round(raw)));
    if (!best || e >= best.engagement) best = { text: m.text, engagement: e };
    if (!worst || e <= worst.engagement) worst = { text: m.text, engagement: e };
  }
  if (best && best.engagement >= 1) return best;
  if (worst && worst.engagement <= -1) return worst;
  return null;
}

/** Above this the keepsake quote is excerpted rather than shown whole. */
const BEST_LINE_MAX = 240;

/** Sentence-aware clip — the deterministic excerpt fallback. */
function clipLine(text: string, max = BEST_LINE_MAX): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentenceEnd > 60) return head.slice(0, sentenceEnd + 1);
  const space = head.lastIndexOf(' ');
  return `${head.slice(0, space > 60 ? space : max)}…`;
}

const BestLineExcerptSchema = z.object({ excerpt: z.string().min(1).max(360) });

/**
 * Ask the model for the most striking VERBATIM excerpt of a long keepsake line.
 * The result must be a substring of the original — it's the player's own words
 * or nothing; any paraphrase falls back to {@link clipLine}. Deliberately not in
 * the prompt registry: a mechanical utility, not a character voice.
 */
async function excerptLongLine(
  settings: ReturnType<typeof getLlmSettings>,
  text: string,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You select quotes. Given a long message, return the single most striking, self-contained excerpt — one or two sentences, VERBATIM: copied exactly, no rewording, no added words, no ellipses of your own.',
    },
    { role: 'user', content: text },
  ];
  const result = await callStructuredLlm(BestLineExcerptSchema, messages, {
    settings,
    role: 'evaluator',
    task: 'Pick the most striking verbatim excerpt of a line.',
    schemaName: 'BestLineExcerpt',
    minMaxTokens: 256,
  });
  if (!result.ok) return null;
  const excerpt = result.data.excerpt.trim();
  if (excerpt.length < 12 || excerpt.length > BEST_LINE_MAX + 120) return null;
  return text.includes(excerpt) ? excerpt : null;
}

const GROUP_FAVORITISM_GAP = 16;

/** A shared date makes favoritism visible in the room. This is deterministic (not
 * the ordinary later "finds out" roll): a bonded, monogamous attendee whose live
 * rapport trails the other seat by a wide margin notices and carries that sting. */
function applyObservedGroupFavoritism(
  session: ConversationSession,
  attendee: SessionParticipant,
  roster: SessionParticipant[],
  messages: Message[],
): JealousyOutcome | null {
  const character = getCharacter(attendee.characterId);
  if (!isDateMode(session.mode) || character.relationshipStyle !== 'monogamous') return null;
  const relationship = getRelationship(character.id);
  if (warmthOf(relationship) < JEALOUSY_MIN_WARMTH) return null;
  const attentionBonus = (characterId: string) => Math.min(
    24,
    messages.reduce((sum, message) => {
      if (message.role !== 'character' || (message.characterId ?? session.characterId) !== characterId) return sum;
      if (message.metadata?.gift) return sum + 18;
      if (message.metadata?.dtr === 'accept') return sum + 22;
      if (message.metadata?.dtr === 'deflect' || message.metadata?.dtr === 'backfire') return sum + 14;
      return sum;
    }, 0),
  );
  const attentionScore = (participant: SessionParticipant) =>
    (participant.rapport != null && participant.judged ? participant.rapport : 50)
    + attentionBonus(participant.characterId);
  const attendeeScore = attentionScore(attendee);
  const warmer = roster
    .filter((other) => other.characterId !== attendee.characterId)
    .sort((a, b) => attentionScore(b) - attentionScore(a))[0];
  const attentionGap = warmer ? attentionScore(warmer) - attendeeScore : 0;
  if (!warmer || attentionGap < GROUP_FAVORITISM_GAP) return null;

  const other = getCharacter(warmer.characterId);
  const committed = isCommitted(relationship);
  const penalty = committed
    ? { trust: -4, respect: -3, tension: 9 }
    : { respect: -2, tension: 5 };
  applyRelationshipChange(character.id, penalty, {
    source: 'jealousy',
    detail: { otherCharacterId: other.id, witnessed: true, sessionId: session.id },
  });
  setRelationshipFlag(character.id, 'state:jealous', true, { source: 'jealousy' });
  addMemoriesFromEvaluation(
    character.id,
    [
      {
        text: `On our group date, it felt like the player was much more interested in ${other.name} than in me.`,
        importance: committed ? 5 : 4,
        tags: ['jealousy', 'date'],
      },
    ],
    null,
    session.mode,
  );
  recordEvent('group_date_favoritism', {
    sessionId: session.id,
    characterId: character.id,
    favoredCharacterId: other.id,
    attentionGap,
    committed,
  });
  return {
    triggered: true,
    otherCount: 1,
    message: `${character.name} felt you were much more interested in ${other.name} — and noticed.`,
  };
}

/** End and evaluate a shared date or hangout once per attendee. All evaluator calls finish before
 * any relationship mutation, so a manual end is all-or-nothing just like a solo
 * outing: one failed read leaves the whole session open and re-endable. */
async function endGroupMeeting(
  session: ConversationSession,
  messages: Message[],
  roster: SessionParticipant[],
): Promise<EndSessionResponse> {
  const settings = getLlmSettings();
  const forcedEnd = roster.every((participant) => participant.state !== 'present');
  const endActor = getCharacter(session.characterId);

  let pendingCharge: { worldId: string; cost: number; pid: string } | null = null;
  if (endActor.worldId) {
    const venue = resolveSessionLocation(session.locationId, endActor, worldsRepo.get(endActor.worldId) ?? null);
    const propVenue = propertyVenueInfo(session.locationId, endActor.worldId);
    const cost = isDateMode(session.mode) ? (propVenue ? 0 : venueCost(venue?.priceTier)) : 0;
    const pid = playerIdForWorld(endActor.worldId);
    if (cost > 0 && getOrCreatePlayer(pid).money < cost) {
      throw badRequest(
        `You can no longer afford ${venue?.name ?? 'this venue'} (it costs ${cost}, you have ${getOrCreatePlayer(pid).money}). Settle up before ending the date.`,
      );
    }
    pendingCharge = { worldId: endActor.worldId, cost, pid };
  }

  const prepared = await Promise.all(
    roster.map(async (participant) => {
      const candidate = pickJudgedLine(messages, participant.characterId);
      const ctx = buildPromptContextForSession(session, messages.slice(-50), { characterId: participant.characterId });
      const [result, excerpt] = await Promise.all([
        callStructuredLlm(SessionEvaluationSchema, buildEvaluatorMessages(ctx), {
          settings,
          role: 'evaluator',
          task: `Evaluate how this shared ${session.mode === 'hangout' ? 'hangout' : 'date'} affected ${getCharacter(participant.characterId).name}'s relationship and memories.`,
          schemaName: 'SessionEvaluation',
          minMaxTokens: 3000,
        }),
        candidate && candidate.text.trim().length > BEST_LINE_MAX
          ? excerptLongLine(settings, candidate.text).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!result.ok) {
        recordEvent('session_eval_failed', {
          sessionId: session.id,
          characterId: participant.characterId,
          error: result.error,
          attempts: result.attempts,
        });
      }
      const bestLine: DateParticipantResult['bestLine'] = candidate
        ? {
            text: excerpt ?? clipLine(candidate.text),
            engagement: candidate.engagement,
            excerpted: excerpt != null || candidate.text.trim().length > BEST_LINE_MAX,
          }
        : null;
      return { participant, result, bestLine };
    }),
  );

  const failed = prepared.filter((entry) => !entry.result.ok);
  if (failed.length > 0 && !forcedEnd) {
    const participantResults: DateParticipantResult[] = prepared.map((entry) => {
      const character = getCharacter(entry.participant.characterId);
      return {
        characterId: character.id,
        characterName: character.name,
        state: entry.participant.state,
        evaluated: false,
        relationship: null,
        mood: null,
        expression: null,
        summaryLine: null,
        memoriesWritten: 0,
        evalError: entry.result.ok ? 'Another attendee could not be evaluated.' : entry.result.error,
        jealousy: null,
        milestone: null,
        breakup: null,
        onTheRocks: false,
        reconciled: false,
        ending: null,
        bestLine: null,
      };
    });
    return {
      session,
      evaluated: false,
      relationship: null,
      mood: null,
      expression: null,
      summaryLine: null,
      memoriesWritten: 0,
      evalError: failed.map((entry) => (entry.result.ok ? '' : entry.result.error)).filter(Boolean).join(' · '),
      jealousy: null,
      milestone: null,
      breakup: null,
      onTheRocks: false,
      reconciled: false,
      ending: null,
      bestLine: null,
      participantResults,
    };
  }

  if (pendingCharge) {
    if (pendingCharge.cost > 0) spendMoney(pendingCharge.cost, pendingCharge.pid);
    spendStamina(pendingCharge.worldId);
    const day = ensureWorldState(pendingCharge.worldId).day;
    for (const participant of roster) stampLastDate(participant.characterId, day);
  }

  const participantResults: DateParticipantResult[] = [];
  for (const entry of prepared) {
    const participant = entry.participant;
    const actor = getCharacter(participant.characterId);
    decayRelationshipBuffs(actor.id);

    if (!entry.result.ok) {
      participantResults.push({
        characterId: actor.id,
        characterName: actor.name,
        state: participant.state,
        evaluated: false,
        relationship: getRelationship(actor.id),
        mood: null,
        expression: participant.expression,
        summaryLine: null,
        memoriesWritten: 0,
        evalError: entry.result.error,
        jealousy: null,
        milestone: null,
        breakup: null,
        onTheRocks: false,
        reconciled: false,
        ending: null,
        bestLine: entry.bestLine,
      });
      continue;
    }

    const evaluation = entry.result.data;
    evaluation.mood = evaluation.mood.replace(/[\s.!?…]+$/u, '');
    const chronDay = actor.worldId ? ensureWorldState(actor.worldId).day : 0;
    const beforeRel = getRelationship(actor.id);
    const incomingJealous = beforeRel.flags['state:jealous'] === true;
    const incomingOffended = beforeRel.flags['state:offended'] === true;
    const walkedOut = participant.state === 'walked_out';
    const appliedDeltas = scaleEvaluationDeltas(evaluation.relationshipDeltas, settings.difficulty);
    const event = recordEvent('session_eval', {
      sessionId: session.id,
      characterId: actor.id,
      day: chronDay,
      groupDate: isDateMode(session.mode),
      mood: evaluation.mood,
      expression: evaluation.expression,
      deltas: appliedDeltas,
      summaryLine: evaluation.summaryLine,
    });
    applyRelationshipChange(actor.id, appliedDeltas, { source: 'session_eval', detail: { sessionId: session.id } });
    const memories = addMemoriesFromEvaluation(
      actor.id,
      evaluation.memoryCandidates,
      event.id,
      session.mode,
    );

    if (incomingOffended && !walkedOut) setRelationshipFlag(actor.id, 'state:offended', false, { source: 'state_resolved' });
    if (incomingJealous) setRelationshipFlag(actor.id, 'state:jealous', false, { source: 'state_resolved' });

    if (actor.worldId && isDateMode(session.mode)) {
      const weather = weatherForDay(actor.worldId, chronDay);
      const location = resolveSessionLocation(session.locationId, actor, worldsRepo.get(actor.worldId) ?? null);
      const weatherEffect = weatherDateEffect(actor, location, weather);
      if (Object.keys(weatherEffect).length > 0) {
        applyRelationshipChange(actor.id, weatherEffect, {
          source: 'weather',
          detail: { weather: weather.kind, locationId: session.locationId },
        });
      }
      const venueEffect = venueDateEffect(actor, location?.priceTier ?? 0);
      if (Object.keys(venueEffect).length > 0) {
        applyRelationshipChange(actor.id, venueEffect, {
          source: 'venue',
          detail: { priceTier: location?.priceTier ?? 0, locationId: session.locationId },
        });
      }
      const propVenue = propertyVenueInfo(session.locationId, actor.worldId);
      if (propVenue) {
        const buff = propertyDateBuff(propVenue.property.buffStat, propVenue.property.buffAmount, propVenue.owned);
        if (Object.keys(buff).length > 0) {
          applyRelationshipChange(actor.id, buff, {
            source: 'venue',
            detail: { propertyId: propVenue.property.id, owned: propVenue.owned },
          });
        }
      }
      const anniversary = anniversaryOn(getRelationship(actor.id), chronDay);
      if (anniversary) {
        applyRelationshipChange(actor.id, { ...ANNIVERSARY_DATE_BONUS[anniversary.kind] }, {
          source: 'anniversary',
          detail: { kind: anniversary.kind, seasons: anniversary.seasons },
        });
      }
      if (participant.rapport != null && participant.judged) {
        const rapportEffect = rapportEndEffect(participant.rapport, settings.difficulty);
        if (Object.keys(rapportEffect).length > 0) {
          applyRelationshipChange(actor.id, rapportEffect, {
            source: 'rapport',
            detail: { rapport: participant.rapport, groupDate: true },
          });
        }
      }
    }

    const jealousy = isDateMode(session.mode)
      ? applyObservedGroupFavoritism(session, participant, roster, messages)
      : null;
    if (actor.worldId && !walkedOut) {
      try {
        adjustDespair(actor.id, -DESPAIR.dateHeal, 'time_together', chronDay);
      } catch {
        /* best-effort */
      }
    }

    let relationship = getRelationship(actor.id);
    try {
      await maybeExtractExFacts(session, messages, actor, chronDay);
      await maybeExtractPlayerFacts(session, messages, actor, chronDay);
    } catch {
      /* knowledge capture is best-effort */
    }
    let milestone = null;
    try {
      milestone = detectMilestoneCrossing(actor.id, beforeRel, relationship, { day: chronDay, mode: session.mode });
    } catch {
      /* best-effort */
    }
    try {
      appendSessionToChronicle(actor.id, evaluation.summaryLine, session.mode, chronDay);
    } catch {
      /* best-effort */
    }
    if (isDateMode(session.mode)) {
      setRelationshipFlag(actor.id, AFTERGLOW_MOOD_FLAG, evaluation.mood, { source: 'date' });
      setRelationshipFlag(actor.id, AFTERGLOW_DAY_FLAG, chronDay, { source: 'date' });
    }

    let breakup: DateParticipantResult['breakup'] = null;
    let onTheRocks = false;
    let reconciled = false;
    const playerConfirmedBreakup =
      participant.state === 'departed'
      && isBrokenUp(beforeRel)
      && messages.some(
        (message) =>
          message.role === 'character'
          && (message.characterId ?? session.characterId) === actor.id
          && message.metadata?.breakupIntent === true,
      );
    if (actor.worldId && isDateMode(session.mode) && !playerConfirmedBreakup) {
      try {
        const outcome = evaluateRelationshipStrain(actor.id, { day: chronDay, trigger: 'date', mode: session.mode });
        if (outcome.kind === 'broke_up') breakup = { fromStatus: outcome.fromStatus!, line: outcome.line ?? '' };
        else if (outcome.kind === 'on_the_rocks') onTheRocks = true;
        else if (outcome.kind === 'reconciled') reconciled = true;
      } catch {
        /* best-effort */
      }
    }
    const strainChanged = breakup != null || onTheRocks || reconciled;
    let ending: DateParticipantResult['ending'] = null;
    if (actor.worldId && isDateMode(session.mode) && !strainChanged) {
      try {
        ending = await maybeReachEnding(actor.id, { day: chronDay, mode: session.mode });
      } catch {
        /* best-effort */
      }
    }
    relationship = getRelationship(actor.id);
    participantResults.push({
      characterId: actor.id,
      characterName: actor.name,
      state: participant.state,
      evaluated: true,
      relationship,
      mood: evaluation.mood,
      expression: evaluation.expression,
      summaryLine: evaluation.summaryLine,
      memoriesWritten: memories.length,
      evalError: null,
      jealousy,
      milestone,
      breakup,
      onTheRocks,
      reconciled,
      ending,
      bestLine: entry.bestLine,
    });
  }

  clearRapport(session.id);
  const ended = sessionsRepo.update(
    ConversationSessionSchema.parse({ ...session, ended: true, updatedAt: Date.now() }),
  );
  const host = participantResults.find((result) => result.characterId === session.characterId) ?? participantResults[0]!;
  const response: EndSessionResponse = {
    session: ended,
    evaluated: participantResults.every((result) => result.evaluated),
    relationship: host.relationship,
    mood: host.mood,
    expression: host.expression,
    summaryLine: host.summaryLine,
    memoriesWritten: participantResults.reduce((sum, result) => sum + result.memoriesWritten, 0),
    evalError: participantResults.some((result) => result.evalError)
      ? participantResults.map((result) => result.evalError).filter(Boolean).join(' · ')
      : null,
    jealousy: host.jealousy,
    milestone: host.milestone,
    breakup: host.breakup,
    onTheRocks: host.onTheRocks,
    reconciled: host.reconciled,
    ending: host.ending,
    bestLine: host.bestLine,
    participantResults,
  };
  persistDateResult(response);
  return response;
}

export async function endSession(sessionId: string): Promise<EndSessionResponse> {
  // Serialize the end per session under the SAME key as send/retry/regenerate, so two
  // concurrent ends can't both evaluate + spend, an end can't interleave with a send,
  // and the session.ended re-check inside runs against committed state. This replaces
  // the old claimEnd flip — which had to mark the session ended BEFORE the evaluator
  // await, the very reason a failed eval used to finalize the date anyway.
  return withKeyedLock(`conv-reply:${sessionId}`, () => endSessionInner(sessionId));
}

async function endSessionInner(sessionId: string): Promise<EndSessionResponse> {
  const session = getSession(sessionId);
  const messages = messagesRepo.listBySession(sessionId);

  // Already over (e.g. the character walked out, or a double end-request).
  // Do NOT re-run the evaluator/jealousy — that would double-apply deltas.
  if (session.ended) {
    clearRapport(sessionId);
    // Give duplicate/retried end requests the winning request's full durable result.
    // Otherwise the client can acknowledge a synthetic "already ended" response and
    // permanently hide the real evaluation without displaying it.
    const persisted = getPersistedDateResult(sessionId);
    if (persisted) return persisted;
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
      bestLine: null,
      participantResults: [],
    };
  }

  // The keepsake quote — assigned after the evaluator/excerpt awaits below, and
  // captured by endBase's closure so every real end carries it.
  let bestLine: EndSessionResponse['bestLine'] = null;

  const endBase = (
    evaluated: boolean,
    evalError: string | null,
    extra: Partial<EndSessionResponse> = {},
  ): EndSessionResponse => {
    const ended = sessionsRepo.update(
      ConversationSessionSchema.parse({ ...session, ended: true, updatedAt: Date.now() }),
    );
    const response: EndSessionResponse = {
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
      bestLine,
      participantResults: [],
      ...extra,
    };
    // Persist the report so a client that lost this HTTP response (tab closed or
    // refreshed during the evaluator) can replay it on its next visit — the costs
    // and consequences above are already committed either way.
    persistDateResult(response);
    return response;
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
      evalError:
        session.mode === 'hangout'
          ? "You didn't say anything, so this hangout doesn't count."
          : "You didn't say anything, so this date doesn't count.",
      jealousy: null,
      milestone: null,
      breakup: null,
      onTheRocks: false,
      reconciled: false,
      ending: null,
      bestLine: null,
      participantResults: [],
    };
  }

  const groupRoster = sessionParticipantsRepo.listBySession(session.id);
  if (groupRoster.length > 1) {
    return endGroupMeeting(session, messages, groupRoster);
  }

  // A real date occurred.
  const endActor = getCharacter(session.characterId);

  // Read-only affordability gate FIRST (no mutation): funds were checked at
  // createSession; re-check here in case the wallet was drained mid-date. A property
  // you own or lease is FREE (the lease rent / purchase covers it); any other venue
  // charges its full tier price. Refusing here — BEFORE we spend/end anything — keeps
  // the date OPEN and re-endable once funds return, rather than ending it then
  // bouncing the charge. A hangout has no venue spend, so its cost is always 0 —
  // it still books the day action and the last-seen stamp, because it WAS a meeting.
  let pendingCharge: { worldId: string; cost: number; pid: string } | null = null;
  if (endActor.worldId && isMeetingMode(session.mode)) {
    const venue = resolveSessionLocation(session.locationId, endActor, worldsRepo.get(endActor.worldId) ?? null);
    const propVenue = propertyVenueInfo(session.locationId, endActor.worldId);
    const cost = isDateMode(session.mode) ? (propVenue ? 0 : venueCost(venue?.priceTier)) : 0;
    const pid = playerIdForWorld(endActor.worldId);
    if (cost > 0 && getOrCreatePlayer(pid).money < cost) {
      throw badRequest(
        `You can no longer afford ${venue?.name ?? 'this venue'} (it costs ${cost}, you have ${getOrCreatePlayer(pid).money}). Settle up before ending the date.`,
      );
    }
    pendingCharge = { worldId: endActor.worldId, cost, pid };
  }

  // Emotional state carried INTO this date should be resolved by having had it out
  // here — captured (read-only) before any mutation. Jealousy freshly discovered
  // below must persist to color the NEXT date, so record the pre-roll state now.
  const incomingFlags = getRelationship(session.characterId).flags;
  const incomingJealous = incomingFlags['state:jealous'] === true;
  const incomingOffended = incomingFlags['state:offended'] === true;
  // A date that ENDED in a walkout (the character stormed out this very session)
  // shouldn't have that fresh offense "aired out" by the same eval — they carry it
  // INTO the next date. Detect it from the walkout message's metadata so the grievance
  // attemptWalkout just set survives, and so a cruel night doesn't also heal the
  // despair spiral like a normal evening together would.
  const endedInWalkout = messages.some((m) => m.role === 'character' && m.metadata?.['walkout'] === true);
  // A NARRATIVE exit (walkout / lost-interest leave / spoken farewell) has already
  // played out in-fiction — the character is gone, so the date CANNOT resume and must
  // finalize even if the evaluator fails (it just carries no eval deltas). A plain
  // manual "End & evaluate" has no such marker; for it the evaluator is REQUIRED.
  const forcedEnd =
    endedInWalkout ||
    messages.some((m) => m.role === 'character' && (m.metadata?.['farewell'] === true || m.metadata?.['left'] === true));

  // --- The evaluator concludes the date. Run it FIRST and, for a manual end, finalize
  //     NOTHING until it succeeds — so a model outage leaves the date OPEN and
  //     re-endable rather than silently ending it un-evaluated. ---
  const settings = getLlmSettings();
  // Keepsake quote: computed from the stamped per-turn reads. A long line's
  // excerpt call runs CONCURRENTLY with the evaluator (no added latency) and
  // falls back to a deterministic sentence clip on any failure.
  const keepsakeCandidate = pickJudgedLine(messages);
  const excerptPromise: Promise<string | null> =
    keepsakeCandidate && keepsakeCandidate.text.trim().length > BEST_LINE_MAX
      ? excerptLongLine(settings, keepsakeCandidate.text).catch(() => null)
      : Promise.resolve(null);

  const evalMessages = messages.slice(-50);
  const ctx = buildPromptContextForSession(session, evalMessages);
  const result = await callStructuredLlm(SessionEvaluationSchema, buildEvaluatorMessages(ctx), {
    settings,
    role: 'evaluator',
    task: 'Evaluate how this dating-sim conversation affected the relationship and record memories.',
    schemaName: 'SessionEvaluation',
    // A maximal eval (summaryLine + up to 8 memories) plus a reasoning model's
    // think tokens can outgrow a user-lowered budget; the whole eval is fail-safe
    // DISCARDED on a truncated/invalid response (recap, memories, and deltas all
    // lost), so floor the headroom (against the evaluator's own budget).
    minMaxTokens: 3000,
  });

  if (!result.ok) recordEvent('session_eval_failed', { sessionId, error: result.error, attempts: result.attempts });

  // Resolve the keepsake now that the concurrent excerpt has settled.
  const keepsakeExcerpt = await excerptPromise;
  bestLine = keepsakeCandidate
    ? {
        text: keepsakeExcerpt ?? clipLine(keepsakeCandidate.text),
        engagement: keepsakeCandidate.engagement,
        excerpted: keepsakeExcerpt != null || keepsakeCandidate.text.trim().length > BEST_LINE_MAX,
      }
    : null;

  // Manual end + the required evaluator failed → DO NOT end the date. Nothing is
  // mutated (no ended flag, no stamina/money spent, no jealousy, no buff decay, rapport
  // preserved); the session stays open so the player can end again once the model is back.
  if (!result.ok && !forcedEnd) {
    return {
      session,
      evaluated: false,
      relationship: null,
      mood: null,
      expression: null,
      summaryLine: null,
      memoriesWritten: 0,
      evalError: result.error,
      jealousy: null,
      milestone: null,
      breakup: null,
      onTheRocks: false,
      reconciled: false,
      ending: null,
      bestLine: null,
      participantResults: [],
    };
  }

  // The date is now truly ending (the eval succeeded, or a narrative exit forces it).
  // Commit the one-time costs + rolls exactly once — the per-session lock in
  // endSession() prevents a concurrent double-end.
  if (pendingCharge) {
    // Money FIRST: spendMoney is the only call in this block that can throw (the
    // wallet may have been drained from another tab during the evaluator await,
    // after the read-only gate above). If it throws, nothing here has committed —
    // the date stays open and cleanly re-endable, instead of stamina being spent
    // now and spent AGAIN when the player settles up and re-ends.
    if (pendingCharge.cost > 0) spendMoney(pendingCharge.cost, pendingCharge.pid);
    spendStamina(pendingCharge.worldId);
    // Inside the meeting-only guard (pendingCharge is set exactly for dates, events
    // and hangouts): a plain chat costs nothing, so it must not reset the neglect
    // clock or the "it's been a while" greeting clock for free either.
    stampLastDate(session.characterId, ensureWorldState(pendingCharge.worldId).day);
  }

  // A monogamous character may "find out" about other people you've seen lately.
  // Rolled only now that the date is truly ending — never on a manual failed eval.
  // Date-only: a hangout is not the night you get caught out.
  const jealousy = isDateMode(session.mode) ? maybeRollJealousy(getCharacter(session.characterId)) : null;

  // The session is ending → decay temporary buffs by one session now that the
  // evaluator (which ran with them still active) is done. Only on a real end, so a
  // manual failed-eval retry doesn't decay buffs twice.
  decayRelationshipBuffs(session.characterId);

  if (!result.ok) {
    // Narrative exit whose evaluator failed: end best-effort, WITHOUT eval deltas.
    return endBase(false, result.error, { jealousy });
  }

  const evaluation = result.data;
  // The evaluator is asked for a short mood word, but models sometimes hand back a
  // whole sentence (or a word with a trailing period). Strip any trailing
  // sentence-ending punctuation so it slots cleanly into the templates that append
  // their own — the "Mood: {mood}." banner, the "A date — {mood}" moment, and the
  // afterglow prompt ("...was {mood}.") — instead of producing a stray double period.
  evaluation.mood = evaluation.mood.replace(/[\s.!?…]+$/u, '');
  const actor = getCharacter(session.characterId);
  const chronDay = actor.worldId ? ensureWorldState(actor.worldId).day : 0;
  // Difficulty scales the evaluator's proposed deltas before anything sees them —
  // harm-aware (a tension RISE is a setback despite its + sign), identity on
  // normal. The event records what was actually applied, not the raw proposal.
  const appliedDeltas = scaleEvaluationDeltas(evaluation.relationshipDeltas, settings.difficulty);
  const event = recordEvent('session_eval', {
    sessionId,
    characterId: session.characterId,
    day: chronDay,
    mood: evaluation.mood,
    expression: evaluation.expression,
    deltas: appliedDeltas,
    summaryLine: evaluation.summaryLine,
  });

  // Capture warmth BEFORE the eval delta so we can detect a band crossing.
  const beforeRel = getRelationship(session.characterId);
  applyRelationshipChange(session.characterId, appliedDeltas, {
    source: 'session_eval',
    detail: { sessionId },
  });
  const memories = addMemoriesFromEvaluation(
    session.characterId,
    evaluation.memoryCandidates,
    event.id,
    session.mode, // so the profile can label these "From a hangout" vs "From a date"
  );

  // Resolve the emotional state carried INTO this date — they've now had the
  // chance to air it. Keep jealousy that was freshly discovered this turn so it
  // colors the NEXT date instead.
  if (incomingOffended && !endedInWalkout) setRelationshipFlag(session.characterId, 'state:offended', false, { source: 'state_resolved' });
  if (incomingJealous && !jealousy?.triggered) {
    setRelationshipFlag(session.characterId, 'state:jealous', false, { source: 'state_resolved' });
  }
  const stateResolved = (incomingOffended && !endedInWalkout) || (incomingJealous && !jealousy?.triggered);

  // The day's weather + the venue (indoor/outdoor) nudge the date. Server-owned,
  // clamped — and applied BEFORE milestone detection so it can tip a crossing.
  if (actor.worldId && isDateMode(session.mode)) {
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

    // Taking them out ON a remembrance day (a season since the first date / the
    // commitment — see shared anniversaryOn) lands a server-owned bonus GRADED
    // by the anniversary's weight (a commitment kept outweighs a first-date
    // callback). Sibling to the weather/venue effects, applied before
    // milestone/strain so it can tip a crossing.
    const anniv = anniversaryOn(getRelationship(session.characterId), chronDay);
    if (anniv) {
      applyRelationshipChange(session.characterId, { ...ANNIVERSARY_DATE_BONUS[anniv.kind] }, {
        source: 'anniversary',
        detail: { kind: anniv.kind, seasons: anniv.seasons },
      });
      recordEvent('anniversary_date', {
        characterId: session.characterId,
        day: chronDay,
        kind: anniv.kind,
        seasons: anniv.seasons,
      });
    }
  }

  // The date's overall RAPPORT applies its consequence — the core "dates can go
  // wrong" lever. A great date boosts warmth; a flat/bad one nets negative and
  // more tense, feeding the strain check below over repeated bad nights. Default
  // rapport (no per-turn judging happened) sits in the neutral band → no effect.
  // Server-owned + clamped, applied BEFORE milestone/strain see the state.
  if (actor.worldId && isDateMode(session.mode)) {
    const finalRapport = getRapport(session.id);
    // Difficulty shifts how the final rapport GRADES (never where it started) —
    // and only when a turn was actually judged, so a date the judge never read
    // (periodic cadence, judge outage) can't be pushed out of the neutral band
    // by the difficulty shift alone.
    const eff = rapportEndEffect(finalRapport, hasJudgedTurn(session.id) ? settings.difficulty : 'normal');
    if (Object.keys(eff).length > 0) {
      applyRelationshipChange(session.characterId, eff, { source: 'rapport', detail: { rapport: finalRapport } });
      recordEvent('date_rapport', { characterId: session.characterId, rapport: finalRapport });
    }
  }
  clearRapport(session.id);

  // (Opt-in) showing up for a real, non-cruel evening helps pull a struggling
  // partner back from the despair spiral — the off-ramp. Turning up to hang out
  // counts: it's the showing-up that helps, not the occasion. A date that ended in a
  // walkout is the opposite of that, so it never heals (the walkout already applied
  // its own hostility hit). (No-op unless enabled.)
  if (actor.worldId && isMeetingMode(session.mode) && !endedInWalkout) {
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

  // Carry the date's emotional register forward briefly: stamp the evaluator's mood
  // (plus the day) so the next day-or-so of texts honor how the night left them
  // feeling instead of snapping straight back to breezy texting. A fresh date
  // overwrites it; the read side (text prompts) lets it fade after DATE_AFTERGLOW_DAYS.
  if (isDateMode(session.mode)) {
    setRelationshipFlag(session.characterId, AFTERGLOW_MOOD_FLAG, evaluation.mood, { source: 'date' });
    setRelationshipFlag(session.characterId, AFTERGLOW_DAY_FLAG, chronDay, { source: 'date' });
  }

  // Endgame: a committed relationship may go on the rocks / break up after a bad
  // date, or a broken-up one may reconcile after enough warming back up. Runs
  // after milestone detection so a crossing isn't pre-empted by a breakup check.
  let breakup: EndSessionResponse['breakup'] = null;
  let onTheRocks = false;
  let reconciled = false;
  if (actor.worldId && isDateMode(session.mode)) {
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
  if (actor.worldId && isDateMode(session.mode) && !strainChanged) {
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

/**
 * Estimate what the NEXT character reply must fit into the model context. This
 * assembles the real dialogue prompt with a representative upcoming player line
 * and verdict, then takes the largest prompt among everyone still at the table.
 * Tokenization is deliberately approximate (chars/4), matching the offline prompt
 * estimator. Output allowance is returned separately: the meter describes input
 * context already occupied, not the largest reply the user has permitted.
 */
const contextWindowCache = new Map<
  string,
  { expiresAt: number; tokens: number | null; source: 'model' | 'unavailable' }
>();

async function resolveDialogueContextWindow(): Promise<{
  tokens: number | null;
  source: 'model' | 'unavailable';
}> {
  const settings = getLlmSettings();
  const key = `${settings.endpointMode}\n${settings.baseUrl}\n${settings.model}`;
  const cached = contextWindowCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;

  try {
    const models = await getAdapter(settings).listModels(AbortSignal.timeout(5_000));
    const exact = models.find((model) => model.id === settings.model && model.contextLength != null);
    const loaded = models.filter((model) => model.loaded === true && model.contextLength != null);
    const reported = exact ?? (loaded.length === 1 ? loaded[0] : undefined);
    if (reported?.contextLength) {
      const result = {
        tokens: reported.contextLength,
        source: 'model' as const,
        expiresAt: Date.now() + 60_000,
      };
      contextWindowCache.set(key, result);
      return result;
    }
  } catch {
    /* Some OpenAI-compatible endpoints do not expose model metadata. */
  }

  // An output-token ceiling is not a context-window measurement. If the adapter
  // cannot report the loaded allocation, leave it unknown so the UI shows only the
  // prompt-length estimate instead of inventing a denominator and percentage.
  const result = {
    tokens: null,
    source: 'unavailable' as const,
    expiresAt: Date.now() + 30_000,
  };
  contextWindowCache.set(key, result);
  return result;
}

export async function estimateNextTurnContext(sessionId: string): Promise<ConversationContextEstimate> {
  const session = getSession(sessionId);
  const storedMessages = messagesRepo.listBySession(sessionId);
  const representativePlayerTurn = MessageSchema.parse({
    id: 'context-estimate-next-turn',
    sessionId,
    role: 'player',
    text:
      'I want to respond thoughtfully to what was just said, add one concrete detail of my own, and ask a natural follow-up question that keeps the conversation moving.',
    metadata: {},
    createdAt: Date.now(),
  });
  const nextMessages = [...storedMessages, representativePlayerTurn];
  const presentIds = sessionParticipantsRepo
    .listBySession(sessionId)
    .filter((participant) => participant.state === 'present')
    .sort((a, b) => a.seat - b.seat)
    .map((participant) => participant.characterId);
  // Legacy/imported sessions can predate participant rows; their seat-0 host is
  // still the character who will answer and must remain estimable.
  const candidateIds = presentIds.length > 0 ? presentIds : [session.characterId];

  let promptChars = 0;
  let promptMessageCount = 0;
  for (const characterId of candidateIds) {
    const ctx = buildPromptContextForSession(session, nextMessages, {
      characterId,
      // Include the realistic post-judge block. It is small, but omitting it makes
      // the readout systematically optimistic on scored dates.
      turnVerdict: isDateMode(session.mode)
        ? { engagement: 1, label: 'engaged', note: 'responded with a specific, attentive follow-up' }
        : null,
    });
    const prompt = buildDialogueMessages(ctx);
    const chars = estimatePromptChars(prompt);
    if (chars > promptChars) {
      promptChars = chars;
      promptMessageCount = prompt.length;
    }
  }

  const estimatedPromptTokens = Math.ceil(promptChars / 4);
  const settings = getLlmSettings();
  const contextWindow = await resolveDialogueContextWindow();
  return ConversationContextEstimateSchema.parse({
    estimatedPromptTokens,
    reservedResponseTokens: settings.maxTokens,
    contextWindowTokens: contextWindow.tokens,
    contextWindowSource: contextWindow.source,
    promptChars,
    promptMessageCount,
    participantCount: candidateIds.length,
    method: 'estimated',
  });
}
