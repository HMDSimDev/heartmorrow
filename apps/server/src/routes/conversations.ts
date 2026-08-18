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
  generateReply,
  getSessionWithMessages,
  judgeTurn,
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
type RelationshipCheckRunResult = { terminal: boolean; turnRead: Awaited<ReturnType<typeof judgeTurn>> };

function sendRelationshipCheckState(send: RelationshipCheckEventSender, messageId: string, state: RelationshipCheckRecovery): void {
  send('relationship_checks', { messageId, state });
}

function sendRelationshipTerminal(send: RelationshipCheckEventSender, outcome: NonNullable<ReturnType<typeof relationshipCheckTerminalOutcome>>): void {
  if (outcome.kind === 'walkout') send('walkout', { message: outcome.message, reason: outcome.reason });
  if (outcome.kind === 'breakup') send('breakup_intent', { message: outcome.message, reaction: outcome.reaction });
  if (outcome.kind === 'farewell') send('farewell', { message: outcome.message, expression: outcome.expression });
  if (outcome.kind === 'left') send('left', { message: outcome.message, reason: outcome.reason });
}

async function runRelationshipChecks(sessionId: string, playerMessage: Message, signal: AbortSignal, send: RelationshipCheckEventSender): Promise<RelationshipCheckRunResult> {
  let { state } = requireRelationshipCheckRecovery(sessionId, playerMessage.id);
  let turnRead: Awaited<ReturnType<typeof judgeTurn>> = null;
  const existingTerminal = relationshipCheckTerminalOutcome(sessionId, playerMessage.id);
  if (existingTerminal) {
    state = resolveRelationshipChecks(playerMessage.id);
    sendRelationshipCheckState(send, playerMessage.id, state);
    sendRelationshipTerminal(send, existingTerminal);
    return { terminal: true, turnRead };
  }
  while (state.next !== null) {
    const key = state.next;
    let reportedFailure: { code: string; error: unknown } | null = null;
    const captureFailure = (code: string, error: unknown): void => { reportedFailure = { code, error }; };
    try {
      if (key === 'walkout') {
        const walkout = await attemptWalkout(sessionId, playerMessage.text, signal, captureFailure, playerMessage.id);
        if (reportedFailure) return failRelationshipCheckRun(sessionId, playerMessage.id, key, reportedFailure, send, turnRead);
        state = advanceRelationshipCheck(playerMessage.id, key);
        if (walkout) {
          state = resolveRelationshipChecks(playerMessage.id);
          sendRelationshipCheckState(send, playerMessage.id, state);
          send('walkout', { message: walkout.message, reason: walkout.reason });
          return { terminal: true, turnRead };
        }
        continue;
      }
      if (key === 'breakup') {
        const breakupIntent = await attemptPlayerBreakupIntent(sessionId, playerMessage.text, signal, captureFailure, playerMessage.id);
        if (reportedFailure) return failRelationshipCheckRun(sessionId, playerMessage.id, key, reportedFailure, send, turnRead);
        state = advanceRelationshipCheck(playerMessage.id, key);
        if (breakupIntent) {
          state = resolveRelationshipChecks(playerMessage.id);
          sendRelationshipCheckState(send, playerMessage.id, state);
          send('breakup_intent', { message: breakupIntent.message, reaction: breakupIntent.reaction });
          return { terminal: true, turnRead };
        }
        continue;
      }
      if (key === 'farewell') {
        const farewell = await attemptPlayerFarewell(sessionId, playerMessage.text, signal, captureFailure, playerMessage.id);
        if (reportedFailure) return failRelationshipCheckRun(sessionId, playerMessage.id, key, reportedFailure, send, turnRead);
        state = advanceRelationshipCheck(playerMessage.id, key);
        if (farewell) {
          state = resolveRelationshipChecks(playerMessage.id);
          sendRelationshipCheckState(send, playerMessage.id, state);
          send('farewell', { message: farewell.message, expression: farewell.expression });
          return { terminal: true, turnRead };
        }
        continue;
      }
      if (key === 'rapport') {
        const freshMessage = requireRelationshipCheckRecovery(sessionId, playerMessage.id).message;
        if (typeof freshMessage.metadata.engagement === 'number') {
          state = advanceRelationshipCheck(playerMessage.id, key);
          continue;
        }
        turnRead = await judgeTurn(sessionId, signal, captureFailure, playerMessage.id);
        if (reportedFailure) return failRelationshipCheckRun(sessionId, playerMessage.id, key, reportedFailure, send, turnRead);
        state = advanceRelationshipCheck(playerMessage.id, key);
        if (turnRead) send('rapport', { label: turnRead.label, expression: turnRead.expression, rapport: turnRead.rapport, delta: turnRead.delta, engagement: turnRead.engagement, messageId: playerMessage.id });
        continue;
      }
      if (key === 'lostInterest') {
        const left = await maybeLeaveForLostInterest(sessionId, signal, playerMessage.id);
        state = advanceRelationshipCheck(playerMessage.id, key);
        if (left) {
          state = resolveRelationshipChecks(playerMessage.id);
          sendRelationshipCheckState(send, playerMessage.id, state);
          send('left', { message: left.message, reason: left.reason });
          return { terminal: true, turnRead };
        }
        continue;
      }
    } catch (error) {
      return failRelationshipCheckRun(sessionId, playerMessage.id, key, { code: `${key}_check_failed`, error }, send, turnRead);
    }
  }
  sendRelationshipCheckState(send, playerMessage.id, state);
  return { terminal: false, turnRead };
}

function failRelationshipCheckRun(sessionId: string, messageId: string, key: RelationshipCheckKey, failure: { code: string; error: unknown }, send: RelationshipCheckEventSender, turnRead: Awaited<ReturnType<typeof judgeTurn>>): RelationshipCheckRunResult {
  reportOperationFailure(failure.code, 'A relationship read failed during the date turn.', failure.error, { sessionId, messageId, check: key });
  const state = failRelationshipCheck(messageId, key, failure.code);
  sendRelationshipCheckState(send, messageId, state);
  return { terminal: false, turnRead };
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
      const { session } = getSessionWithMessages(id);
      if (session.ended) throw badRequest('This date has already ended.');
      const playerMessage = addPlayerMessage(id, text, intent);
      const reply = await generateReply(id);
      void maybeAutoSummarize(id);
      return { playerMessage, reply };
    });
  });

  // Streaming send via Server-Sent Events.
  app.post('/conversations/:id/stream', { schema: docSchema({ tags: ['conversations'], summary: 'Send a message, stream reply via SSE', body: SendMessageSchema }) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text, intent } = parseInput(SendMessageSchema, req.body);

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
        const { session } = getSessionWithMessages(id);
        if (session.ended) {
          send('error', { message: 'This date has already ended.' });
          return;
        }
        // The client may have disconnected while queued for the lock — don't strand a
        // player turn no one is listening for.
        if (ac.signal.aborted) return;

        let playerMessage = addPlayerMessage(id, text, intent);
        if (isDateMode(session.mode)) playerMessage = beginRelationshipChecks(playerMessage.id);
        send('player', playerMessage);

        let turnRead: Awaited<ReturnType<typeof judgeTurn>> = null;
        if (isDateMode(session.mode)) {
          const relationshipChecks = await runRelationshipChecks(id, playerMessage, ac.signal, send);
          if (relationshipChecks.terminal) return;
          turnRead = relationshipChecks.turnRead;
        }

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

        const { content, finishReason } = await streamReply(
          id,
          (delta) => send('delta', { text: delta }),
          ac.signal,
          turnRead,
        );
        if (!content.trim()) {
          send('error', {
            message:
              finishReason === 'length'
                ? 'The model ran out of tokens before answering (likely spent on reasoning). Raise "Max tokens" in Settings.'
                : 'The model returned an empty reply.',
          });
        } else {
          const message = persistStreamedReply(id, content);
          if (finishReason === 'length') {
            send('notice', { message: 'Reply was cut off (token limit reached). Raise Max tokens in Settings.' });
          }
          send('done', { message });
          void maybeAutoSummarize(id);
          // The live rapport read was already emitted up front (before the reply), so the
          // turn's vibe + verdict shaped the reply itself — nothing more to judge here.
        }
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
        const { session, messages } = getSessionWithMessages(id);
        if (session.ended) {
          send('error', { message: 'This date has already ended.' });
          return;
        }
        const last = messages[messages.length - 1];
        // Already answered (a prior retry landed, or the original reply actually
        // persisted before the connection dropped) — replay it as a clean success.
        if (last && last.role === 'character') {
          send('done', { message: last });
          return;
        }
        if (!last || last.role !== 'player') {
          send('error', { message: 'There’s no message here to reply to.' });
          return;
        }

        const { content, finishReason } = await streamReply(id, (delta) => send('delta', { text: delta }), ac.signal, null);
        if (!content.trim()) {
          send('error', {
            message:
              finishReason === 'length'
                ? 'The model ran out of tokens before answering (likely spent on reasoning). Raise "Max tokens" in Settings.'
                : 'The model returned an empty reply.',
          });
        } else {
          const message = persistStreamedReply(id, content);
          if (finishReason === 'length') {
            send('notice', { message: 'Reply was cut off (token limit reached). Raise Max tokens in Settings.' });
          }
          send('done', { message });
          void maybeAutoSummarize(id);
        }
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
        dropReplyForRegen(id); // throws → caught below → SSE 'error'
        const { content, finishReason } = await streamReply(id, (delta) => send('delta', { text: delta }), ac.signal, null);
        if (!content.trim()) {
          send('error', {
            message:
              finishReason === 'length'
                ? 'The model ran out of tokens before answering (likely spent on reasoning). Raise "Max tokens" in Settings.'
                : 'The model returned an empty reply.',
          });
        } else {
          const message = persistStreamedReply(id, content);
          if (finishReason === 'length') {
            send('notice', { message: 'Reply was cut off (token limit reached). Raise Max tokens in Settings.' });
          }
          send('done', { message });
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
    // Reject a double-fire BEFORE queueing on the turn lock — queued, the second
    // request would wait out the first and run a full second attempt instead of
    // being rejected as an overlap (see assertNoDtrInFlight).
    assertNoDtrInFlight(id);
    return withKeyedLock(`conv-reply:${id}`, () => {
      assertNoUnresolvedRelationshipCheck(id, 'defining the relationship');
      return attemptDtr(id);
    });
  });

  // Give a held item to your date in-session — triggers a structured gift reaction.
  // Same turn lock: the gift's ended-check + transcript writes must not interleave
  // with a streaming reply or an end — otherwise its reaction can land inside an
  // ended/evaluating session, or become the trailing message a retry replays as the
  // "answer" to a still-unanswered player turn.
  app.post('/conversations/:id/gift', { schema: docSchema({ tags: ['conversations'], summary: 'Give a held item to your date', body: GiftOnDateSchema }) }, async (req) => {
    const { id } = req.params as { id: string };
    const { inventoryItemId } = parseInput(GiftOnDateSchema, req.body);
    return withKeyedLock(`conv-reply:${id}`, () => {
      assertNoUnresolvedRelationshipCheck(id, 'giving a gift');
      return giveGiftOnDate(id, inventoryItemId);
    });
  });

  // Confirm a player-initiated breakup (the client first sees the reaction via
  // the `breakup_intent` stream event, then confirms here). Locked so the ended
  // flip can't race a concurrent turn's session update (lost update).
  app.post('/conversations/:id/breakup', { schema: docSchema({ tags: ['conversations'], summary: 'Confirm a player-initiated breakup' }) }, async (req) => {
    const { id } = req.params as { id: string };
    return withKeyedLock(`conv-reply:${id}`, async () => confirmPlayerBreakup(id));
  });

  app.get('/conversations/:id/prompt-preview', { schema: docSchema({ tags: ['conversations'], summary: 'Preview the assembled session prompt' }) }, async (req) => {
    const { id } = req.params as { id: string };
    return previewSessionPrompt(id);
  });
}
