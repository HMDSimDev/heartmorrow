import type { FastifyInstance } from 'fastify';
import { ConversationCreateSchema, GiftOnDateSchema, SendMessageSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import {
  addPlayerMessage,
  attemptPlayerBreakupIntent,
  attemptPlayerFarewell,
  attemptWalkout,
  confirmPlayerBreakup,
  createSession,
  endSession,
  generateReply,
  getSessionWithMessages,
  judgeTurn,
  listSessions,
  maybeAutoSummarize,
  maybeLeaveForLostInterest,
  openConversation,
  persistStreamedReply,
  previewSessionPrompt,
  streamReply,
  summarizeSession,
} from '../services/conversation-service';
import { attemptDtr } from '../services/dtr-service';
import { giveGiftOnDate } from '../services/gift-service';
import { docSchema } from '../lib/openapi-schema';

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.post('/conversations', { schema: docSchema({ tags: ['conversations'], summary: 'Create a conversation session', body: ConversationCreateSchema }) }, async (req, reply) => {
    const input = parseInput(ConversationCreateSchema, req.body);
    const session = createSession(input);
    // On a first date the character breaks the ice (best-effort; a no-op for plain
    // chats and repeat dates, so only first meetings pay the model latency). The
    // opening line is persisted; the client loads it via GET /conversations/:id.
    await openConversation(session.id);
    reply.code(201);
    return session;
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
    const playerMessage = addPlayerMessage(id, text, intent);
    const reply = await generateReply(id);
    void maybeAutoSummarize(id);
    return { playerMessage, reply };
  });

  // Streaming send via Server-Sent Events.
  app.post('/conversations/:id/stream', { schema: docSchema({ tags: ['conversations'], summary: 'Send a message, stream reply via SSE', body: SendMessageSchema }) }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text, intent } = parseInput(SendMessageSchema, req.body);
    const playerMessage = addPlayerMessage(id, text, intent);

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

    send('player', playerMessage);

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

    // The character may end the date themselves over egregious behavior (rare).
    try {
      const walkout = await attemptWalkout(id, text, ac.signal);
      if (walkout) {
        send('walkout', { message: walkout.message, reason: walkout.reason });
        finished = true;
        raw.off('close', onClose);
        raw.end();
        return;
      }
    } catch {
      /* walkout check is best-effort; fall through to a normal reply */
    }

    // The player may be trying to break up. If so, surface the character's
    // reaction and ask the client to confirm — do NOT end the relationship yet.
    try {
      const intent = await attemptPlayerBreakupIntent(id, text, ac.signal);
      if (intent) {
        send('breakup_intent', { message: intent.message, reaction: intent.reaction });
        finished = true;
        raw.off('close', onClose);
        raw.end();
        return;
      }
    } catch {
      /* breakup-intent check is best-effort; fall through to a normal reply */
    }

    // The player may be winding the date down to a natural close ("I should get
    // going"). If so, voice the character's goodbye and tell the client to run the
    // normal end-and-evaluate flow — the date is scored in full, exactly as if the
    // player had clicked "End & evaluate". Best-effort: falls through on any miss.
    try {
      const farewell = await attemptPlayerFarewell(id, text, ac.signal);
      if (farewell) {
        send('farewell', { message: farewell.message, expression: farewell.expression });
        finished = true;
        raw.off('close', onClose);
        raw.end();
        return;
      }
    } catch {
      /* farewell check is best-effort; fall through to a normal reply */
    }

    // Judge how the player's LATEST message landed BEFORE writing the reply, so the
    // character's tone can honestly reflect it (no more "judge says dismissive while
    // the character gushes"). The live 'rapport' read is emitted up front — the
    // trajectory bar + portrait react during the typing indicator, then the reply
    // lands in that register. Best-effort: a failed/skipped read = no verdict this turn.
    let turnRead: Awaited<ReturnType<typeof judgeTurn>> = null;
    try {
      turnRead = await judgeTurn(id, ac.signal);
      if (turnRead) {
        send('rapport', {
          label: turnRead.label,
          expression: turnRead.expression,
          rapport: turnRead.rapport,
          delta: turnRead.delta,
        });
      }
    } catch {
      /* rapport judging is best-effort; never block the turn */
    }

    // If rapport has cratered (now INCLUDING this turn), the character loses interest
    // and ends the evening early (a soft exit, NOT a walkout) rather than replying —
    // so a final-straw message makes them leave instead of gamely replying. Real cost.
    try {
      const left = await maybeLeaveForLostInterest(id, ac.signal);
      if (left) {
        send('left', { message: left.message, reason: left.reason });
        finished = true;
        raw.off('close', onClose);
        raw.end();
        return;
      }
    } catch {
      /* lost-interest check is best-effort; fall through to a normal reply */
    }

    try {
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
    } catch (err) {
      // Don't surface an error that was caused by the client disconnecting.
      if (!ac.signal.aborted) send('error', { message: (err as Error).message });
    } finally {
      finished = true;
      raw.off('close', onClose);
      raw.end();
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

  // Define-the-Relationship: try to advance the commitment status.
  app.post('/conversations/:id/dtr', { schema: docSchema({ tags: ['conversations'], summary: 'Attempt to advance the relationship status' }) }, async (req) => {
    const { id } = req.params as { id: string };
    return attemptDtr(id);
  });

  // Give a held item to your date in-session — triggers a structured gift reaction.
  app.post('/conversations/:id/gift', { schema: docSchema({ tags: ['conversations'], summary: 'Give a held item to your date', body: GiftOnDateSchema }) }, async (req) => {
    const { id } = req.params as { id: string };
    const { inventoryItemId } = parseInput(GiftOnDateSchema, req.body);
    return giveGiftOnDate(id, inventoryItemId);
  });

  // Confirm a player-initiated breakup (the client first sees the reaction via
  // the `breakup_intent` stream event, then confirms here).
  app.post('/conversations/:id/breakup', { schema: docSchema({ tags: ['conversations'], summary: 'Confirm a player-initiated breakup' }) }, async (req) => {
    const { id } = req.params as { id: string };
    return confirmPlayerBreakup(id);
  });

  app.get('/conversations/:id/prompt-preview', { schema: docSchema({ tags: ['conversations'], summary: 'Preview the assembled session prompt' }) }, async (req) => {
    const { id } = req.params as { id: string };
    return previewSessionPrompt(id);
  });
}
