import {
  ConversationSessionSchema,
  DtrReactionSchema,
  MessageSchema,
  DTR_COOLDOWN_DAYS,
  RELATIONSHIP_STATUS_LABELS,
  currentStatus,
  isBrokenUp,
  nextDtrRung,
  type DtrResponse,
  type RelationshipStatus,
} from '@dsim/shared';
import { messagesRepo, sessionsRepo } from '../db/repositories';
import { badRequest, notFound } from '../lib/errors';
import { newId, playerIdForWorldOrDefault } from '../lib/ids';
import { getCharacter } from './character-service';
import { getRelationship } from './relationship-service';
import { getOrCreatePlayer } from './player-service';
import { applyRelationshipChange, setRelationshipFlag } from './stat-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { appendChronicleLine } from './chronicle-service';
import { rippleSocialVouch } from './social-ripple-service';
import { evaluateRelationshipStrain } from './breakup-service';
import { recordEvent } from './event-service';
import { getLlmSettings } from './settings-service';
import { ensureWorldState } from './world-clock-service';
import { callStructuredLlm } from '../llm/structured';
import { buildDtrReactionMessages } from '../prompt/prompt-builder';

/** First-person memory written when a commitment is accepted. */
const ACCEPT_MEMORY: Record<RelationshipStatus, string> = {
  none: '',
  dating: 'We agreed to start dating.',
  exclusive: 'We became exclusive — just the two of us now.',
  cohabiting: 'We decided to move in together.',
};

/** DTR attempts in flight, keyed by sessionId (= the POST /conversations/:id/dtr
 *  path id). A second concurrent attempt on the same date — a double-click, or a
 *  retry across the LLM await — is rejected so the accept branch can't double-apply
 *  the commitment deltas, milestone memory, and social vouch. */
const dtrInFlight = new Set<string>();

/**
 * Attempt to advance the relationship status (the DTR ladder). Mirrors the
 * walkout/jealousy pattern: gate (rung unlocked + cooldown) → structured judge →
 * SERVER applies all deltas/flags. Accept advances `status`; deflect just sets a
 * cooldown; backfire stings (tension) and ends a date. Fails safe (no mutation)
 * if the structured call fails. Serialized per session (in-flight lock) so a
 * double-fire across the LLM await can't double-commit.
 */
export async function attemptDtr(sessionId: string, signal?: AbortSignal): Promise<DtrResponse> {
  if (dtrInFlight.has(sessionId)) {
    throw badRequest('Hang on — that question is still landing.');
  }
  dtrInFlight.add(sessionId);
  try {
    return await attemptDtrInner(sessionId, signal);
  } finally {
    dtrInFlight.delete(sessionId);
  }
}

async function attemptDtrInner(sessionId: string, signal?: AbortSignal): Promise<DtrResponse> {
  const session = sessionsRepo.get(sessionId);
  if (!session) throw notFound(`Session ${sessionId} not found.`);
  if (session.ended) throw badRequest('This date has already ended.');
  // A date you never spoke in isn't a real date (endSession would discard it),
  // so it must not be able to advance the relationship. Require a player turn.
  if (!messagesRepo.listBySession(sessionId).some((m) => m.role === 'player')) {
    throw badRequest('Say something first before defining the relationship.');
  }

  const character = getCharacter(session.characterId);
  const relationship = getRelationship(character.id);

  // A broken-up relationship can ONLY come back through reconciliation (which
  // requires warmth >= RECONCILE_WARMTH and clears state:brokenUp). Re-running the
  // DTR ladder here would set status:'dating' while leaving state:brokenUp=true — an
  // impossible combined state that also skips the warmth floor and can permanently
  // block the happy ending. Guard it like createSession / sendChatMessage do.
  if (isBrokenUp(relationship)) {
    throw badRequest("You've broken up — you'll have to win them back before you can define things again.");
  }

  const next = nextDtrRung(relationship);
  if (!next) throw badRequest("You're already as committed as it gets.");
  if (!next.warmthMet) throw badRequest(`It's too soon to ${next.rung.label.toLowerCase()} — grow closer first.`);

  let day = 0;
  if (character.worldId) {
    day = ensureWorldState(character.worldId).day;
    const last = relationship.flags['dtr:lastAttemptDay'];
    if (typeof last === 'number' && day - last < DTR_COOLDOWN_DAYS) {
      throw badRequest('Give it a little time before bringing that up again.');
    }
  }

  const settings = getLlmSettings();
  const recent = messagesRepo.listBySession(sessionId).slice(-12);
  const result = await callStructuredLlm(
    DtrReactionSchema,
    buildDtrReactionMessages({
      character,
      relationship,
      rung: next.rung,
      recentMessages: recent,
      playerName: getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId)).name,
    }),
    { settings, role: 'evaluator', task: 'Decide how the character responds to defining the relationship.', schemaName: 'DtrReaction', signal },
  );
  if (!result.ok) {
    // FAIL SAFE: do not mutate state (no status change, no cooldown).
    recordEvent('dtr_failed', { characterId: character.id, error: result.error });
    throw badRequest('Could not read the moment just now — try again.');
  }

  const { decision, line } = result.data;
  const setCooldown = () => {
    if (character.worldId) setRelationshipFlag(character.id, 'dtr:lastAttemptDay', day, { source: 'dtr' });
  };
  let ended = false;

  if (decision === 'accept') {
    setRelationshipFlag(character.id, 'status', next.rung.status, { source: 'dtr' });
    applyRelationshipChange(character.id, { affection: 5, comfort: 5, trust: 3 }, {
      source: 'dtr',
      detail: { status: next.rung.status },
    });
    addMemoriesFromEvaluation(
      character.id,
      [{ text: ACCEPT_MEMORY[next.rung.status], importance: 5, tags: ['relationship', 'milestone'] }],
      null,
    );
    try {
      appendChronicleLine(
        character.id,
        day,
        session.mode,
        `💞 We became ${RELATIONSHIP_STATUS_LABELS[next.rung.status].toLowerCase()}.`,
        { bumpSession: false },
      );
    } catch {
      /* chronicle is best-effort */
    }
    setCooldown(); // don't climb multiple rungs in a single sitting
    recordEvent('dtr_accepted', { characterId: character.id, status: next.rung.status, day });
    try {
      rippleSocialVouch(character.id); // their friends warm to you, their rivals cool
    } catch {
      /* ripple is best-effort */
    }
  } else if (decision === 'backfire') {
    applyRelationshipChange(character.id, { tension: 12, comfort: -4 }, { source: 'dtr', detail: { decision } });
    setRelationshipFlag(character.id, 'state:offended', true, { source: 'dtr' });
    setCooldown();
    recordEvent('dtr_backfired', { characterId: character.id, day });
    // A badly-received DTR ask spikes tension — if the relationship was already
    // committed, that can push it onto the rocks (or break it).
    if (character.worldId) {
      try {
        evaluateRelationshipStrain(character.id, { day, trigger: 'date', mode: session.mode });
      } catch {
        /* strain is best-effort */
      }
    }
    // A bad ask blows up a real date (chat mode just gets the cold reply).
    ended = session.mode !== 'chat';
  } else {
    setCooldown();
    recordEvent('dtr_deflected', { characterId: character.id });
  }

  const now = Date.now();
  const message = messagesRepo.insert(
    MessageSchema.parse({
      id: newId('msg'),
      sessionId,
      role: 'character',
      text: line.trim(),
      metadata: { dtr: decision },
      createdAt: now,
    }),
  );
  const savedSession = sessionsRepo.update(
    ConversationSessionSchema.parse({ ...session, ended: ended || session.ended, updatedAt: now }),
  );

  const relAfter = getRelationship(character.id);
  return {
    decision,
    attempted: next.rung.status,
    status: currentStatus(relAfter),
    line: line.trim(),
    message,
    relationship: relAfter,
    ended: savedSession.ended,
  };
}
