import type { FastifyInstance } from 'fastify';
import { ConversationCreateSchema, GiftOnDateSchema, RelationshipCheckRecoveryRequestSchema, SendMessageSchema, isDateMode, type Message, type RelationshipCheckKey, type RelationshipCheckRecovery } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import {
  addPlayerMessage,
  advanceRelationshipCheck,
  assertNoUnresolvedRelationshipCheck,
  beginRelationshipChecks,
  attemptPlayerBreakupIntent,
  attemptPlayerFarewell,
  attemptWalkout,
  confirmPlayerBreakup,
  createSession,
  dropReplyForRegen,
  endSession,
  estimateNextTurnContext,
  generateReply,
  getSessionWithMessages,
  getRecordedGroupSpeakerIds,
  judgeTurn,
  currentRelationshipCheckTask,
  recordGroupSpeakerPlan,
  selectGroupSpeakers,
  listSessions,
  markDateResultSeen,
  maybeAutoSummarize,
  maybeLeaveForLostInterest,
  openConversation,
  persistStreamedReply,
  previewSessionPrompt,
  failRelationshipCheck,
  relationshipCheckTerminalOutcome,
  requireRelationshipCheckRecovery,
  resolveRelationshipChecks,
  skipRelationshipChecks,
  streamReply,
  summarizeSession,
} from '../services/conversation-service';
import { assertNoDtrInFlight, attemptDtr } from '../services/dtr-service';
import { giveGiftOnDate } from '../services/gift-service';
import { docSchema } from '../lib/openapi-schema';
import { withKeyedLock } from '../lib/keyed-lock';
import { badRequest } from '../lib/errors';
import { reportOperationFailure } from '../lib/operation-warning';

type RelationshipCheckEventSender = (event: string, data: unknown) => void;
type TurnRead = NonNullable<Awaited<ReturnType<typeof judgeTurn>>>;
type RelationshipCheckRunResult = { terminal: boolean; turnReads: Map<string, TurnRead> };

function sendRelationshipCheckState(send: RelationshipCheckEventSender, messageId: string, state: RelationshipCheckRecovery): void {
  send('relationship_checks', { messageId, state });
}

function sendRelationshipTerminal(send: RelationshipCheckEventSender, outcome: NonNullable<ReturnType<typeof relationshipCheckTerminalOutcome>>, terminal: boolean): void {
  const characterId = outcome.message.characterId ?? undefined;
  if (outcome.kind === 'walkout') send('walkout', { message: outcome.message, reason: outcome.reason, characterId, terminal });
  if (outcome.kind === 'breakup') send('breakup_intent', { message: outcome.message, reaction: outcome.reaction, characterId });
  if (outcome.kind === 'farewell') send('farewell', { message: outcome.message, expression: outcome.expression, characterId, terminal });
  if (outcome.kind === 'left') send('left', { message: outcome.message, reason: outcome.reason, characterId, terminal });
}

async function runRelationshipChecks(sessionId: string, playerMessage: Message, signal: AbortSignal, send: RelationshipCheckEventSender): Promise<RelationshipCheckRunResult> {
  let { state } = requireRelationshipCheckRecovery(sessionId, playerMessage.id);
  const { session } = getSessionWithMessages(sessionId);
  const turnReads = new Map<string, TurnRead>();
  while (state.next !== null) {
    const task = currentRelationshipCheckTask(state, session.characterId);
    if (!task) break;
    const key = task.key;
    const characterId = task.characterId;
    const present = getSessionWithMessages(sessionId).participants.filter((participant) => participant.state === 'present');
    const participantPresent = present.some((participant) => participant.characterId === characterId);
    const existingOutcome = relationshipCheckTerminalOutcome(sessionId, playerMessage.id, key, characterId);
    if (existingOutcome) {
      state = advanceRelationshipCheck(playerMessage.id, key);
      const currentParticipants = getSessionWithMessages(sessionId).participants;
      const remaining = currentParticipants.filter((participant) => participant.state === 'present');
      let terminal = remaining.length === 0 || existingOutcome.kind === 'breakup';
      if (existingOutcome.kind === 'farewell' && currentParticipants.length === 1) terminal = true;
      sendRelationshipTerminal(send, existingOutcome, terminal);
      if (existingOutcome.kind === 'breakup' || terminal) {
        state = resolveRelationshipChecks(playerMessage.id);
        sendRelationshipCheckState(send, playerMessage.id, state);
        return { terminal: true, turnReads };
      }
      continue;
    }
    if (present.length === 0) {
      state = resolveRelationshipChecks(playerMessage.id);
      sendRelationshipCheckState(send, playerMessage.id, state);
      return { terminal: true, turnReads };
    }
    if (!participantPresent) {
      state = advanceRelationshipCheck(playerMessage.id, key);
      continue;
    }
    let reportedFailure: { code: string; error: unknown } | null = null;
    const captureFailure = (code: string, error: unknown): void => { reportedFailure = { code, error }; };
    try {
      if (key === 'walkout') {
        const walkout = await attemptWalkout(sessionId, playerMessage.text, signal, captureFailure, playerMessage.id, characterId);
        if (reportedFailure) return failRelationshipCheckRun(sessionId, playerMessage.id, key, characterId, reportedFailure, send, turnReads);
        state = advanceRelationshipCheck(playerMessage.id, key);
        if (walkout) {
          const remaining = getSessionWithMessages(sessionId).participants.filter((participant) => participant.state === 'present');
          const terminal = remaining.length === 0;
          send('walkout', { message: walkout.message, reason: walkout.reason, characterId: walkout.characterId, terminal });
          if (terminal) {
            state = resolveRelationshipChecks(playerMessage.id);
            sendRelationshipCheckState(send, playerMessage.id, state);
            return { terminal: true, turnReads };
          }
        }
        continue;
      }
      if (key === 'breakup') {
        const breakupIntent = await attemptPlayerBreakupIntent(sessionId, playerMessage.text, signal, captureFailure, playerMessage.id, characterId);
        if (reportedFailure) return failRelationshipCheckRun(sessionId, playerMessage.id, key, characterId, reportedFailure, send, turnReads);
        state = advanceRelationshipCheck(playerMessage.id, key);
        if (breakupIntent) {
          state = resolveRelationshipChecks(playerMessage.id);
          sendRelationshipCheckState(send, playerMessage.id, state);
          send('breakup_intent', { message: breakupIntent.message, reaction: breakupIntent.reaction, characterId: breakupIntent.characterId });
          return { terminal: true, turnReads };
        }
        continue;
      }
      if (key === 'farewell') {
        const farewell = await attemptPlayerFarewell(sessionId, playerMessage.text, signal, captureFailure, playerMessage.id, characterId);
        if (reportedFailure) return failRelationshipCheckRun(sessionId, playerMessage.id, key, characterId, reportedFailure, send, turnReads);
        state = advanceRelationshipCheck(playerMessage.id, key);
        if (farewell) {
          send('farewell', { message: farewell.message, expression: farewell.expression, characterId: farewell.characterId, terminal: farewell.terminal });
          if (farewell.terminal) {
            state = resolveRelationshipChecks(playerMessage.id);
            sendRelationshipCheckState(send, playerMessage.id, state);
            return { terminal: true, turnReads };
          }
        }
        continue;
      }
      if (key === 'rapport') {
        const freshMessage = requireRelationshipCheckRecovery(sessionId, playerMessage.id).message;
        const existingReads = freshMessage.metadata.engagementByCharacter;
        const legacyReadExists = characterId === session.characterId && typeof freshMessage.metadata.engagement === 'number';
        if (legacyReadExists) {
          state = advanceRelationshipCheck(playerMessage.id, key);
          continue;
        }
        if (existingReads && typeof existingReads === 'object' && !Array.isArray(existingReads) && typeof (existingReads as Record<string, unknown>)[characterId] === 'number') {
          state = advanceRelationshipCheck(playerMessage.id, key);
          continue;
        }
        const turnRead = await judgeTurn(sessionId, signal, captureFailure, playerMessage.id, characterId);
        if (reportedFailure) return failRelationshipCheckRun(sessionId, playerMessage.id, key, characterId, reportedFailure, send, turnReads);
        state = advanceRelationshipCheck(playerMessage.id, key);
        if (turnRead) {
          turnReads.set(characterId, turnRead);
          send('rapport', { characterId, label: turnRead.label, expression: turnRead.expression, rapport: turnRead.rapport, delta: turnRead.delta, engagement: turnRead.engagement, messageId: playerMessage.id });
        }
        continue;
      }
      if (key === 'lostInterest') {
        const left = await maybeLeaveForLostInterest(sessionId, signal, playerMessage.id, characterId);
        state = advanceRelationshipCheck(playerMessage.id, key);
        if (left) {
          const remaining = getSessionWithMessages(sessionId).participants.filter((participant) => participant.state === 'present');
          const terminal = remaining.length === 0;
          send('left', { message: left.message, reason: left.reason, characterId: left.characterId, terminal });
          if (terminal) {
            state = resolveRelationshipChecks(playerMessage.id);
            sendRelationshipCheckState(send, playerMessage.id, state);
            return { terminal: true, turnReads };
          }
        }
        continue;
      }
    } catch (error) {
      return failRelationshipCheckRun(sessionId, playerMessage.id, key, characterId, { code: `${key}_check_failed`, error }, send, turnReads);
    }
  }
  sendRelationshipCheckState(send, playerMessage.id, state);
  return { terminal: false, turnReads };
}

function failRelationshipCheckRun(sessionId: string, messageId: string, key: RelationshipCheckKey, characterId: string, failure: { code: string; error: unknown }, send: RelationshipCheckEventSender, turnReads: Map<string, TurnRead>): RelationshipCheckRunResult {
  reportOperationFailure(failure.code, 'A relationship read failed during the date turn.', failure.error, { sessionId, messageId, check: key, characterId });
  const state = failRelationshipCheck(messageId, key, failure.code, characterId);
  sendRelationshipCheckState(send, messageId, state);
  return { terminal: false, turnReads };
}

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.post('/conversations', { schema: docSchema({ tags: ['conversations'], summary: 'Create a conversation session', body: ConversationCreateSchema }) }, async (req, reply) => {
    const input = parseInput(ConversationCreateSchema, req.body);
    const session = createSession(input);
    // Set the scene as the date opens (best-effort; a no-op for plain chats): on a
    // first date the character breaks the ice, on a repeat date we lay down a short
    // third-person "venue flavor" beat. The line is persisted; the client loads it
    // via GET /conversations/:id.
    const opening = await openConversation(session.id);
    let openingFailed = false;
    if (input.mode !== 'chat' && !opening) openingFailed = true;
    if (openingFailed) req.log.warn({ sessionId: session.id, characterId: session.characterId, mode: session.mode }, 'The model failed to generate the opening scene; the player will be asked to open the conversation.');
    reply.code(201);
    return { ...session, openingFailed };
  });

  app.get('/conversations', { schema: docSchema({ tags: ['conversations'], summary: 'List conversation sessions' }) }, async () => listSessions());

  app.get('/conversations/:id', { schema: docSchema({ tags: ['conversations'], summary: 'Get a session with its messages' }) }, async (req) => {
    const { id } = req.params as { id: string };
    return getSessionWithMessages(id);
  });

  // Non-streaming send: add player message, get a full reply.
  app.post('/conversations/:id/messages', { schema: docSchema({ tags: ['conversations'], summary: 'Send a message and get a full reply', body: SendMessageSchema }) }, async (req) => {
    const { id } = req.params as { id: string };
    const { text, intent } = parseInput(SendMessageSchema, req.body);
    // Serialize per session under the SAME key as the streaming/retry/regenerate paths
    // so two concurrent sends can't interleave (add player turn -> await LLM -> insert
    // reply) and stack duplicated/interleaved turns.
    return withKeyedLock(`conv-reply:${id}`, async () => {
      // Re-check inside the lock (parity with /stream + /retry-stream): a send queued
      // behind a concurrent end/reply must not append to an already-ended session.
      const { session, participants } = getSessionWithMessages(id);
      if (session.ended) throw badRequest('This date has already ended.');
      const playerMessage = addPlayerMessage(id, text, intent);
      const present = participants.filter((entry) => entry.state === 'present');
      const plan = present.length > 1
        ? await selectGroupSpeakers(id, present.map((participant) => participant.characterId))
        : null;
      if (plan) recordGroupSpeakerPlan(playerMessage.id, plan);
      const speakers = plan
        ? plan.characterIds
            .map((characterId) => present.find((participant) => participant.characterId === characterId))
            .filter((participant): participant is NonNullable<typeof participant> => participant != null)
        : present;
      const replies = [];
      for (const participant of speakers) {
        replies.push(await generateReply(id, participant.characterId));
      }
      void maybeAutoSummarize(id);
      return { playerMessage, reply: replies[0] ?? null, replies };
    });
  });

  // Streaming send via Server-Sent Events.
  app.post('/conversations/:id/stream', { schema: docSchema({ tags: ['conversations'], summary: 'Send a message, stream reply via SSE', body: SendMessageSchema }) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text, intent, targetCharacterId } = parseInput(SendMessageSchema, req.body);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Cancel the upstream LLM call only if the CLIENT actually disconnects.
    // We listen on the RESPONSE socket (reply.raw), not req.raw — req.raw's
    // 'close' fires as soon as the request body is consumed (i.e. immediately),
    // which would abort the model call before it ever produced a reply.
    const ac = new AbortController();
    let finished = false;
    const onClose = () => {
      if (!finished) ac.abort();
    };
    raw.on('close', onClose);
    const finish = () => {
      finished = true;
      raw.off('close', onClose);
      raw.end();
    };

    try {
      // Serialize the whole mutating turn per session under the SAME key as the
      // retry/regenerate handlers, so two concurrent sends (a double-fire, a second
      // tab, a server-truth resume) can't interleave "add player turn -> await LLM ->
      // persist reply" and thereby double-judge rapport, double-apply the walkout
      // penalty, or stack duplicated/interleaved turns. The player message is added
      // INSIDE the lock so a queued second request sees the first turn's committed
      // state (matching the retry-stream re-check pattern).
      await withKeyedLock(`conv-reply:${id}`, async () => {
        const { session, participants } = getSessionWithMessages(id);
        if (session.ended) {
          send('error', { message: 'This date has already ended.' });
          return;
        }
        // The client may have disconnected while queued for the lock — don't strand a
        // player turn no one is listening for.
        if (ac.signal.aborted) return;

        let playerMessage = addPlayerMessage(id, text, intent);
        const initialPresent = participants.filter((participant) => participant.state === 'present');
        if (isDateMode(session.mode)) playerMessage = beginRelationshipChecks(playerMessage.id, initialPresent.map((participant) => participant.characterId), targetCharacterId);
        send('player', playerMessage);

        const groupDate = participants.length > 1;
        let present = participants.filter((participant) => participant.state === 'present');
        const readsByCharacter = new Map<string, TurnRead>();
        if (isDateMode(session.mode)) {
          const relationshipChecks = await runRelationshipChecks(id, playerMessage, ac.signal, send);
          if (relationshipChecks.terminal) return;
          for (const [characterId, turnRead] of relationshipChecks.turnReads) readsByCharacter.set(characterId, turnRead);
          present = getSessionWithMessages(id).participants.filter((participant) => participant.state === 'present');
        }
        if (present.length === 0) return;

        // The player may be trying to break up. If so, surface the character's
        // reaction and ask the client to confirm — do NOT end the relationship yet.

        // The player may be winding the date down to a natural close ("I should get
        // going"). If so, voice the character's goodbye and tell the client to run the
        // normal end-and-evaluate flow — the date is scored in full, exactly as if the
        // player had clicked "End & evaluate". Best-effort: falls through on any miss.

        // Judge how the player's LATEST message landed BEFORE writing the reply, so the
        // character's tone can honestly reflect it (no more "judge says dismissive while
        // the character gushes"). The live 'rapport' read is emitted up front — the
        // trajectory bar + portrait react during the typing indicator, then the reply
        // lands in that register. Best-effort: a failed/skipped read = no verdict this turn.

        // If rapport has cratered (now INCLUDING this turn), the character loses interest
        // and ends the evening early (a soft exit, NOT a walkout) rather than replying —
        // so a final-straw message makes them leave instead of gamely replying. Real cost.
        if (present.length === 0) return;

        // The per-character judges above still let everyone privately hear/react to
        // the line. The shared-scene director now decides who has enough reason to
        // speak aloud, using those reads plus the full room context. Persisting this
        // plan makes a dropped-stream retry preserve both selection and order.
        let speakers = present;
        if (groupDate) {
          const plan = await selectGroupSpeakers(
            id,
            present.map((participant) => participant.characterId),
            {
              latestReads: Object.fromEntries(
                [...readsByCharacter.entries()].map(([characterId, read]) => [
                  characterId,
                  { engagement: read.engagement, label: read.label, note: read.note },
                ]),
              ),
              signal: ac.signal,
            },
          );
          recordGroupSpeakerPlan(playerMessage.id, plan);
          const presentById = new Map(present.map((participant) => [participant.characterId, participant]));
          const selected = plan.characterIds
            .map((characterId) => presentById.get(characterId))
            .filter((participant): participant is NonNullable<typeof participant> => participant != null);
          // A participant can leave between earlier checks only through this locked
          // flow; still fail safe to somebody answering if a future exit path grows.
          if (selected.length > 0) speakers = selected;
        }

        for (let index = 0; index < speakers.length; index += 1) {
          const participant = speakers[index]!;
          const turnRead = readsByCharacter.get(participant.characterId) ?? null;
          send('speaker', { characterId: participant.characterId });
          const { content, finishReason } = await streamReply(
            id,
            (delta) => send('delta', { text: delta, characterId: participant.characterId }),
            ac.signal,
            turnRead,
            participant.characterId,
          );
          if (!content.trim()) {
            send('error', {
              message:
                finishReason === 'length'
                  ? 'The model ran out of tokens before answering (likely spent on reasoning). Raise "Max tokens" in Settings.'
                  : 'The model returned an empty reply.',
            });
            return;
          }

          const message = persistStreamedReply(id, content, participant.characterId);
          if (finishReason === 'length') {
            send('notice', { message: 'Reply was cut off (token limit reached). Raise Max tokens in Settings.' });
          }
          send('done', { message, complete: index === speakers.length - 1 });
        }
        void maybeAutoSummarize(id);
        // Each live rapport read was emitted before the replies, so every attendee's
        // verdict shapes their own reply without judging the player turn twice.
      });
    } catch (err) {
      // Don't surface an error that was caused by the client disconnecting.
      if (!ac.signal.aborted) send('error', { message: (err as Error).message || 'The reply failed unexpectedly — tap retry.' });
    } finally {
      finish();
    }
  });

  app.post('/conversations/:id/relationship-checks/retry', { schema: docSchema({ tags: ['conversations'], summary: 'Retry interrupted relationship checks', body: RelationshipCheckRecoveryRequestSchema }) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { messageId } = parseInput(RelationshipCheckRecoveryRequestSchema, req.body);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: string, data: unknown): void => { raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const ac = new AbortController();
    let finished = false;
    const onClose = (): void => { if (!finished) ac.abort(); };
    raw.on('close', onClose);
    const finish = (): void => { finished = true; raw.off('close', onClose); raw.end(); };
    try {
      await withKeyedLock(`conv-reply:${id}`, async () => {
        const { session } = getSessionWithMessages(id);
        if (session.ended) {
          send('error', { message: 'This date has already ended.' });
          return;
        }
        if (ac.signal.aborted) return;
        const { message } = requireRelationshipCheckRecovery(id, messageId);
        await runRelationshipChecks(id, message, ac.signal, send);
      });
    } catch (error) {
      if (!ac.signal.aborted) send('error', { message: (error as Error).message || 'The relationship checks could not be retried.' });
    } finally {
      finish();
    }
  });

  app.post('/conversations/:id/relationship-checks/skip', { schema: docSchema({ tags: ['conversations'], summary: 'Continue without interrupted relationship checks', body: RelationshipCheckRecoveryRequestSchema }) }, async (req) => {
    const { id } = req.params as { id: string };
    const { messageId } = parseInput(RelationshipCheckRecoveryRequestSchema, req.body);
    return withKeyedLock(`conv-reply:${id}`, async () => {
      const { session } = getSessionWithMessages(id);
      if (session.ended) throw badRequest('This date has already ended.');
      const state = skipRelationshipChecks(id, messageId);
      return { messageId, state };
    });
  });

  // Retry the character's reply via SSE when a prior turn saved the player's
  // message but the reply failed (errored, or the stream dropped mid-reply). The
  // player message is already persisted, so this regenerates ONLY the reply — it
  // does NOT add a player message (no duplicate) and deliberately skips the
  // walkout/breakup/farewell/rapport pre-screens (they already ran, and re-judging
  // would double-move rapport). Streams delta → done|error|notice, just like /stream.
  app.post('/conversations/:id/retry-stream', { schema: docSchema({ tags: ['conversations'], summary: 'Retry a failed reply, stream via SSE' }) }, async (req, reply) => {
    const { id } = req.params as { id: string };

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const ac = new AbortController();
    let finished = false;
    const onClose = () => {
      if (!finished) ac.abort();
    };
    raw.on('close', onClose);

    const finish = () => {
      finished = true;
      raw.off('close', onClose);
      raw.end();
    };

    try {
      // Serialize reply production per session and re-check the trailing message
      // INSIDE the lock, so two concurrent retry-streams (two tabs, a double-fire)
      // can't both pass the player-turn check and persist two replies — the second
      // sees the freshly-persisted reply and replays it instead.
      await withKeyedLock(`conv-reply:${id}`, async () => {
        const { session, messages, participants } = getSessionWithMessages(id);
        if (session.ended) {
          send('error', { message: 'This date has already ended.' });
          return;
        }
        const playerIndex = messages.findLastIndex((message) => message.role === 'player');
        if (playerIndex < 0) {
          send('error', { message: 'There’s no message here to reply to.' });
          return;
        }

        const playerMessage = messages[playerIndex]!;
        const existing = messages.slice(playerIndex + 1).filter((message) => message.role === 'character');
        const answered = new Set(existing.map((message) => message.characterId ?? session.characterId));
        const recordedSpeakerIds = getRecordedGroupSpeakerIds(playerMessage);
        const present = participants.filter((participant) => participant.state === 'present');
        const planned = recordedSpeakerIds
          ? recordedSpeakerIds
              .map((characterId) => present.find((participant) => participant.characterId === characterId))
              .filter((participant): participant is NonNullable<typeof participant> => participant != null)
          : present;
        const pending = planned.filter((participant) => !answered.has(participant.characterId));
        const noOnePresent = participants.every((participant) => participant.state !== 'present');
        const total = existing.length + pending.length;

        for (let index = 0; index < existing.length; index += 1) {
          const message = existing[index]!;
          const characterId = message.characterId ?? session.characterId;
          if (message.metadata.walkout === true) {
            send('walkout', {
              message,
              reason: typeof message.metadata.walkoutReason === 'string' ? message.metadata.walkoutReason : 'walkout',
              characterId,
              terminal: noOnePresent && index === existing.length - 1,
            });
          } else if (message.metadata.left === true) {
            send('left', {
              message,
              reason: 'lost_interest',
              characterId,
              terminal: noOnePresent && index === existing.length - 1,
            });
          } else {
            send('done', { message, complete: index === total - 1 });
          }
        }

        for (let index = 0; index < pending.length; index += 1) {
          const participant = pending[index]!;
          send('speaker', { characterId: participant.characterId });
          const { content, finishReason } = await streamReply(
            id,
            (delta) => send('delta', { text: delta, characterId: participant.characterId }),
            ac.signal,
            null,
            participant.characterId,
          );
          if (!content.trim()) {
            send('error', {
              message:
                finishReason === 'length'
                  ? 'The model ran out of tokens before answering (likely spent on reasoning). Raise "Max tokens" in Settings.'
                  : 'The model returned an empty reply.',
            });
            return;
          }

          const message = persistStreamedReply(id, content, participant.characterId);
          if (finishReason === 'length') {
            send('notice', { message: 'Reply was cut off (token limit reached). Raise Max tokens in Settings.' });
          }
          send('done', { message, complete: existing.length + index === total - 1 });
        }
        if (total > 0) void maybeAutoSummarize(id);
      });
    } catch (err) {
      if (!ac.signal.aborted) send('error', { message: (err as Error).message || 'The reply failed unexpectedly — tap retry.' });
    } finally {
      finish();
    }
  });

  // Regenerate the character's MOST RECENT reply via SSE — for when the model
  // produced a bad/looping line. Drops the trailing reply and rewrites it against
  // the same player turn. Like retry-stream, it streams delta → done|error|notice
  // and deliberately skips the walkout/breakup/farewell/rapport judges: the turn was
  // already scored when it was first sent, so a regenerate only rewrites the prose —
  // it never moves the relationship (no double-judging).
  app.post('/conversations/:id/regenerate-stream', { schema: docSchema({ tags: ['conversations'], summary: 'Regenerate the last reply, stream via SSE' }) }, async (req, reply) => {
    const { id } = req.params as { id: string };

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const ac = new AbortController();
    let finished = false;
    const onClose = () => {
      if (!finished) ac.abort();
    };
    raw.on('close', onClose);

    const finish = () => {
      finished = true;
      raw.off('close', onClose);
      raw.end();
    };

    try {
      // Share retry-stream's per-session lock so a regenerate can't interleave with a
      // send/retry. Drop the trailing reply INSIDE the lock, then rewrite it (null
      // verdict → no re-judge) against the now-trailing player turn.
      await withKeyedLock(`conv-reply:${id}`, async () => {
        const dropped = dropReplyForRegen(id); // throws → caught below → SSE 'error'
        const { session } = getSessionWithMessages(id);
        const characterId = dropped.characterId ?? session.characterId;
        send('speaker', { characterId });
        const { content, finishReason } = await streamReply(
          id,
          (delta) => send('delta', { text: delta, characterId }),
          ac.signal,
          null,
          characterId,
        );
        if (!content.trim()) {
          send('error', {
            message:
              finishReason === 'length'
                ? 'The model ran out of tokens before answering (likely spent on reasoning). Raise "Max tokens" in Settings.'
                : 'The model returned an empty reply.',
          });
        } else {
          const message = persistStreamedReply(id, content, characterId);
          if (finishReason === 'length') {
            send('notice', { message: 'Reply was cut off (token limit reached). Raise Max tokens in Settings.' });
          }
          send('done', { message, complete: true });
          void maybeAutoSummarize(id);
        }
      });
    } catch (err) {
      if (!ac.signal.aborted) send('error', { message: (err as Error).message || 'Couldn’t regenerate the reply — try again.' });
    } finally {
      finish();
    }
  });

  app.post('/conversations/:id/summarize', { schema: docSchema({ tags: ['conversations'], summary: 'Summarize a conversation session' }) }, async (req) => {
    const { id } = req.params as { id: string };
    return summarizeSession(id);
  });

  app.post('/conversations/:id/end', { schema: docSchema({ tags: ['conversations'], summary: 'End a conversation session' }) }, async (req) => {
    const { id } = req.params as { id: string };
    return endSession(id);
  });

  // Acknowledge the end-of-date report (shown live, or replayed after a refresh)
  // so the Date tab doesn't offer it again.
  app.post('/conversations/:id/result-seen', { schema: docSchema({ tags: ['conversations'], summary: 'Acknowledge the end-of-date report' }) }, async (req) => {
    const { id } = req.params as { id: string };
    markDateResultSeen(id);
    return { ok: true };
  });

  // Define-the-Relationship: try to advance the commitment status.
  // Serialized under the session's turn lock: a DTR checks `session.ended` and then
  // awaits its judge, so unserialized it could land its reaction (and even flip
  // `ended` on a backfire) in the middle of a streaming turn or a concurrent end.
  app.post('/conversations/:id/dtr', { schema: docSchema({ tags: ['conversations'], summary: 'Attempt to advance the relationship status' }) }, async (req) => {
    const { id } = req.params as { id: string };
    const characterId = (req.body as { characterId?: string } | undefined)?.characterId;
    // Reject a double-fire BEFORE queueing on the turn lock — queued, the second
    // request would wait out the first and run a full second attempt instead of
    // being rejected as an overlap (see assertNoDtrInFlight).
    assertNoDtrInFlight(id);
    return withKeyedLock(`conv-reply:${id}`, () => {
      assertNoUnresolvedRelationshipCheck(id, 'defining the relationship');
      return attemptDtr(id, undefined, characterId);
    });
  });

  // Give a held item to your date in-session — triggers a structured gift reaction.
  // Same turn lock: the gift's ended-check + transcript writes must not interleave
  // with a streaming reply or an end — otherwise its reaction can land inside an
  // ended/evaluating session, or become the trailing message a retry replays as the
  // "answer" to a still-unanswered player turn.
  app.post('/conversations/:id/gift', { schema: docSchema({ tags: ['conversations'], summary: 'Give a held item to your date', body: GiftOnDateSchema }) }, async (req) => {
    const { id } = req.params as { id: string };
    const { inventoryItemId, characterId } = parseInput(GiftOnDateSchema, req.body);
    return withKeyedLock(`conv-reply:${id}`, () => {
      assertNoUnresolvedRelationshipCheck(id, 'giving a gift');
      return giveGiftOnDate(id, inventoryItemId, undefined, characterId ?? undefined);
    });
  });

  // Confirm a player-initiated breakup (the client first sees the reaction via
  // the `breakup_intent` stream event, then confirms here). Locked so the ended
  // flip can't race a concurrent turn's session update (lost update).
  app.post('/conversations/:id/breakup', { schema: docSchema({ tags: ['conversations'], summary: 'Confirm a player-initiated breakup' }) }, async (req) => {
    const { id } = req.params as { id: string };
    const characterId = (req.body as { characterId?: string } | undefined)?.characterId;
    return withKeyedLock(`conv-reply:${id}`, async () => confirmPlayerBreakup(id, characterId));
  });

  app.get('/conversations/:id/prompt-preview', { schema: docSchema({ tags: ['conversations'], summary: 'Preview the assembled session prompt' }) }, async (req) => {
    const { id } = req.params as { id: string };
    return previewSessionPrompt(id);
  });

  app.get('/conversations/:id/context-estimate', { schema: docSchema({ tags: ['conversations'], summary: 'Estimate context required for the next reply' }) }, async (req) => {
    const { id } = req.params as { id: string };
    return estimateNextTurnContext(id);
  });
}
