import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_PLAYER_ID, MessageSchema, TextMessageSchema } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import {
  addPlayerMessage,
  createSession,
  dropReplyForRegen,
  getSessionWithMessages,
  persistStreamedReply,
} from './conversation-service';
import { getOrCreateThread, regenerateTextReply, sendPlayerText } from './text-message-service';
import { getRelationship } from './relationship-service';
import { messagesRepo, threadsRepo, textMessagesRepo } from '../db/repositories';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

/** Mark a character as "dated" so texting is unlocked (a real date with a player turn). */
function dateOnce(characterId: string) {
  const session = createSession({ characterId, mode: 'date', locationId: null });
  addPlayerMessage(session.id, 'hey, nice to see you');
  return session;
}

// --- date reply regeneration (dropReplyForRegen) ----------------------------

describe('date reply regeneration', () => {
  it('drops the trailing character reply so it can be rewritten against the player turn', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'so what do you do for fun?');
    persistStreamedReply(session.id, 'I I I I I I I'); // a looping, bad reply

    dropReplyForRegen(session.id);

    const { messages } = getSessionWithMessages(session.id);
    expect(messages.filter((m) => m.role === 'character').length).toBe(0);
    expect(messages[messages.length - 1]!.role).toBe('player'); // ready to regenerate
  });

  it('refuses when the last message is a player turn (nothing to rewrite)', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'hello?');
    expect(() => dropReplyForRegen(session.id)).toThrow(/no reply/i);
  });

  it('refuses to regenerate the character\'s opener before the player has spoken', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    // The character opened the scene, but the player hasn't said anything yet.
    persistStreamedReply(session.id, 'Hey! So glad you could make it.');
    expect(() => dropReplyForRegen(session.id)).toThrow(/nothing of yours/i);
  });

  it('refuses a consequence-bearing line (a walkout) whose effects are already applied', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'you are the worst');
    messagesRepo.insert(
      MessageSchema.parse({
        id: 'msg_walkout',
        sessionId: session.id,
        role: 'character',
        text: 'We’re done here.',
        metadata: { walkout: true },
        createdAt: Date.now(),
      }),
    );
    expect(() => dropReplyForRegen(session.id)).toThrow(/regenerated/i);
    // The walkout line is still there — never silently dropped.
    const { messages } = getSessionWithMessages(session.id);
    expect(messages[messages.length - 1]!.metadata?.walkout).toBe(true);
  });
});

// --- text reply regeneration (regenerateTextReply) --------------------------

describe('text reply regeneration', () => {
  it('rewrites the last reply WITHOUT re-running the judge (relationship unchanged)', async () => {
    const { character } = seedWorldAndCharacter();
    dateOnce(character.id);

    // Initial send: a reply + the impartial judge (which moves the relationship +1).
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({ body: 'sure, sounds good', tone: 'warm' }),
        JSON.stringify({ engagement: 1, hostile: false, note: 'friendly' }),
      ]),
    );
    await sendPlayerText(character.id, 'wanna hang out?');
    const relAfterSend = getRelationship(character.id);

    // Regenerate: a single scripted response. If the judge wrongly re-ran it would
    // consume a second call — so asserting exactly ONE call proves the judge is skipped.
    const regen = new ScriptedAdapter([JSON.stringify({ body: 'yeah, I’d love that', tone: 'warm' })]);
    setAdapterOverride(regen);
    const res = await regenerateTextReply(character.id);

    expect(res.reply?.body).toBe('yeah, I’d love that');
    expect(res.error).toBeNull();
    expect(regen.calls).toBe(1); // reply only — no judge call
    expect(res.relationshipDelta).toEqual({}); // a regenerate never moves the relationship

    const relAfter = getRelationship(character.id);
    expect(relAfter.comfort).toBe(relAfterSend.comfort);
    expect(relAfter.affection).toBe(relAfterSend.affection);

    // The old reply was replaced, not appended: one player text, one character reply.
    const thread = threadsRepo.getByCharacter(character.id, DEFAULT_PLAYER_ID)!;
    const msgs = textMessagesRepo.listDeliveredByThread(thread.id);
    expect(msgs.filter((m) => m.sender === 'player').length).toBe(1);
    expect(msgs.filter((m) => m.sender === 'character').length).toBe(1);
    expect(msgs[msgs.length - 1]!.body).toBe('yeah, I’d love that');
  });

  it('keeps the original reply intact when the regenerate fails', async () => {
    const { character } = seedWorldAndCharacter();
    dateOnce(character.id);
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({ body: 'the original reply', tone: 'warm' }),
        JSON.stringify({ engagement: 0, hostile: false, note: 'neutral' }),
      ]),
    );
    await sendPlayerText(character.id, 'hey there');

    // The model can't produce valid JSON → the regenerate fails; the original stays.
    setAdapterOverride(new ScriptedAdapter(['not json at all']));
    const res = await regenerateTextReply(character.id);
    expect(res.error).toBeTruthy();

    const thread = threadsRepo.getByCharacter(character.id, DEFAULT_PLAYER_ID)!;
    const msgs = textMessagesRepo.listDeliveredByThread(thread.id);
    expect(msgs.filter((m) => m.sender === 'character').length).toBe(1);
    expect(msgs[msgs.length - 1]!.body).toBe('the original reply');
  });

  it('refuses when there is no reply to regenerate', async () => {
    const { character } = seedWorldAndCharacter();
    dateOnce(character.id);
    // A send whose reply fails leaves the player's text trailing (no reply).
    setAdapterOverride(new ScriptedAdapter(['not json at all']));
    await sendPlayerText(character.id, 'you around?');
    await expect(regenerateTextReply(character.id)).rejects.toThrow(/no reply/i);
  });

  it('refuses to regenerate a proactive text the character sent on their own', async () => {
    const { character } = seedWorldAndCharacter();
    dateOnce(character.id);
    // A daily/proactive character text with no message of yours preceding it.
    const thread = getOrCreateThread(character.id);
    const now = Date.now();
    textMessagesRepo.insert(
      TextMessageSchema.parse({
        id: 'txt_daily',
        threadId: thread.id,
        sender: 'character',
        body: 'thinking of you today',
        status: 'delivered',
        deliveredAt: now,
        createdAt: now,
      }),
    );
    await expect(regenerateTextReply(character.id)).rejects.toThrow(/no text of yours/i);
  });

  it('refuses to regenerate a gift reaction', async () => {
    const { character } = seedWorldAndCharacter();
    dateOnce(character.id);
    // A gift exchange: the player's gift-bearing text, then the character's reaction.
    const thread = getOrCreateThread(character.id);
    const now = Date.now();
    textMessagesRepo.insert(
      TextMessageSchema.parse({
        id: 'txt_gift',
        threadId: thread.id,
        sender: 'player',
        body: 'for you',
        status: 'delivered',
        attachment: { shopItemId: 'item_x', name: 'Daisy', claimed: true },
        deliveredAt: now,
        createdAt: now,
      }),
    );
    textMessagesRepo.insert(
      TextMessageSchema.parse({
        id: 'txt_reaction',
        threadId: thread.id,
        sender: 'character',
        body: 'aww, thank you!',
        status: 'delivered',
        deliveredAt: now + 1,
        createdAt: now + 1,
      }),
    );
    await expect(regenerateTextReply(character.id)).rejects.toThrow(/gift/i);
  });
});
