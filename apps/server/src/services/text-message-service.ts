import {
  DEFAULT_PLAYER_ID,
  GIFTABLE_RARITIES,
  MessageThreadSchema,
  TextMessageSchema,
  TextReplySchema,
  TextJudgeSchema,
  TEXT_DAILY_GAIN_CAP,
  isMemorialized,
  phaseIndex,
  textEngagementDelta,
  positiveWarmth,
  capWarmthGain,
  type Character,
  type GiftSentiment,
  type MessageThread,
  type PhoneThreadSummary,
  type RelationshipStatKey,
  type TextMessage,
} from '@dsim/shared';
import { charactersRepo, chroniclesRepo, messagesRepo, sessionsRepo, threadsRepo, textMessagesRepo, worldStatesRepo } from '../db/repositories';
import { getDb } from '../db/index';
import { newId, playerIdForWorldOrDefault } from '../lib/ids';
import { badRequest } from '../lib/errors';
import { withKeyedLock } from '../lib/keyed-lock';
import { getCharacter, listAcquaintances } from './character-service';
import { readAssetFile } from './asset-service';
import { getCharacterAvailability, currentAvailabilityFor, currentAvailabilityMap } from './availability-service';
import { getRelationship } from './relationship-service';
import { selectTopMemories } from './memory-service';
import { getOrCreatePlayer } from './player-service';
import { applyRelationshipChange, setRelationshipFlag, stampLastSeen } from './stat-service';
import { ensureWorldState } from './world-clock-service';
import { getLlmSettings } from './settings-service';
import { grantItem, getShopItem } from './shop-service';
import { reactToGift } from './gift-service';
import { callStructuredLlm } from '../llm/structured';
import { buildTextReplyMessages, buildTextJudgeMessages } from '../prompt/prompt-builder';
import { recordEvent } from './event-service';

/**
 * True once the player has been on a REAL date (or event) with this character —
 * a session they actually participated in. A date that was started but never
 * spoken in does not count (it has no messages), so it never enables texting.
 */
export function hasDated(characterId: string): boolean {
  return sessionsRepo
    .listByCharacter(characterId)
    .some((s) => (s.mode === 'date' || s.mode === 'event') && messagesRepo.hasRole(s.id, 'player'));
}

/** Characters the player may text — only those they've actually dated (optionally
 *  scoped to one world). Each carries current-day availability so the contact
 *  picker can flag a busy person before the player tries to message them. */
export function listContactableCharacters(
  worldId?: string,
): Array<{ id: string; name: string; portraitAssetId: string | null; available: boolean; unavailableReason: string | null }> {
  const characters = charactersRepo
    .list()
    .filter((c) => (worldId ? c.worldId === worldId : true))
    .filter((c) => hasDated(c.id));
  const avail = currentAvailabilityMap(characters);
  return characters.map((c) => {
    const a = avail.get(c.id);
    return {
      id: c.id,
      name: c.name,
      portraitAssetId: c.portraitAssetId,
      available: a?.available ?? true,
      unavailableReason: a?.reason ?? null,
    };
  });
}

export function getOrCreateThread(characterId: string, playerId: string = DEFAULT_PLAYER_ID): MessageThread {
  const existing = threadsRepo.getByCharacter(characterId, playerId);
  if (existing) return existing;
  const now = Date.now();
  return threadsRepo.insert(
    MessageThreadSchema.parse({
      id: newId('thread'),
      characterId,
      playerId,
      lastMessageAt: null,
      unreadCount: 0,
      createdAt: now,
      updatedAt: now,
    }),
  );
}

/**
 * Deliver any queued character texts whose scheduled (day, phase) has arrived
 * for that character's world. Idempotent — safe to call on every read.
 */
export function deliverDueTexts(): number {
  const now = Date.now();
  let delivered = 0;
  // At most ONE text per thread per delivery tick — so a backlog (e.g. a swept
  // prior-day text alongside today's) trickles in one at a time instead of
  // landing as a burst. Belt-and-suspenders now that generation queues only one
  // text per character per day.
  const deliveredThisTick = new Set<string>();
  for (const t of textMessagesRepo.listQueued()) {
    if (t.sender !== 'character') continue;
    if (deliveredThisTick.has(t.threadId)) continue;
    const thread = threadsRepo.get(t.threadId);
    if (!thread) continue;
    const character = charactersRepo.get(thread.characterId);

    let due = false;
    if (!character?.worldId) {
      due = true; // world-less character → no clock to schedule against
    } else {
      const state = worldStatesRepo.get(character.worldId);
      if (state) {
        if (t.dayNumber == null) {
          due = true; // untagged (shouldn't happen for generated texts)
        } else if (t.dayNumber < state.day) {
          due = true; // a prior day's text never delivered — sweep it
        } else if (
          t.dayNumber === state.day &&
          t.scheduledPhase &&
          phaseIndex(t.scheduledPhase) <= phaseIndex(state.phase)
        ) {
          due = true;
        }
      }
      // else: world-bound but no clock yet → wait (do not deliver early)
    }
    if (!due) continue;

    textMessagesRepo.update({ ...t, status: 'delivered', deliveredAt: now });
    threadsRepo.update({ ...thread, unreadCount: thread.unreadCount + 1, lastMessageAt: now, updatedAt: now });
    recordEvent('text_delivered', { threadId: t.threadId, characterId: thread.characterId });
    deliveredThisTick.add(t.threadId);
    delivered += 1;
  }
  return delivered;
}

export function listThreadSummaries(
  worldId?: string,
  playerId: string = DEFAULT_PLAYER_ID,
): PhoneThreadSummary[] {
  deliverDueTexts();
  const rows = threadsRepo
    .listByPlayer(playerId)
    .map((thread) => ({ thread, character: charactersRepo.get(thread.characterId) }))
    // Scope to the active world's characters (when a world is given).
    .filter(({ character }) => (worldId ? character?.worldId === worldId : true));
  const avail = currentAvailabilityMap(rows.map((r) => r.character).filter((c): c is Character => !!c));
  return rows.map(({ thread, character }) => {
    const last = textMessagesRepo.lastDelivered(thread.id);
    const a = character ? avail.get(character.id) : undefined;
    return {
      characterId: thread.characterId,
      characterName: character?.name ?? 'Unknown',
      portraitAssetId: character?.portraitAssetId ?? null,
      lastBody: last?.body ?? null,
      lastAt: last ? last.deliveredAt ?? last.createdAt : thread.lastMessageAt,
      lastFromPlayer: last?.sender === 'player',
      unread: thread.unreadCount,
      available: a?.available ?? true,
      unavailableReason: a?.reason ?? null,
    };
  });
}

/** Last N delivered texts in a thread (no side effects) — for date-prompt continuity.
 *  Carries each text's in-world `day` so the date prompt can tell how long ago the
 *  texting happened (and not treat stale "see you tomorrow" plans as current). */
export function getRecentTexts(
  characterId: string,
  limit = 6,
  playerId: string = DEFAULT_PLAYER_ID,
): Array<{ sender: 'player' | 'character'; body: string; day: number | null }> {
  const thread = threadsRepo.getByCharacter(characterId, playerId);
  if (!thread) return [];
  return textMessagesRepo
    .listDeliveredByThread(thread.id)
    .slice(-limit)
    .map((t) => ({ sender: t.sender, body: textBodyForPrompt(t), day: t.dayNumber }));
}

/** A text's body as it should read in a transcript — marks photo attachments so
 *  the model knows an image was sent even though it isn't shown here. */
function textBodyForPrompt(t: TextMessage): string {
  if (!t.imageAssetId) return t.body;
  return t.body.trim() ? `${t.body} [photo]` : '[sent a photo]';
}

export interface ThreadView {
  character: Character;
  messages: TextMessage[];
  /** Whether the character can be texted right now (today, in their world). */
  available: boolean;
  /** Why they can't be texted, when unavailable (e.g. "is buried in work today"). */
  unavailableReason: string | null;
}

export function getThreadView(characterId: string, playerId: string = DEFAULT_PLAYER_ID): ThreadView {
  const character = getCharacter(characterId);
  if (!hasDated(characterId)) {
    throw badRequest(`You haven't been on a date with ${character.name} yet — go on a date before texting.`);
  }
  deliverDueTexts();
  const thread = getOrCreateThread(characterId, playerId);
  if (thread.unreadCount > 0) {
    threadsRepo.update({ ...thread, unreadCount: 0, updatedAt: Date.now() });
  }
  const avail = currentAvailabilityFor(character);
  return {
    character,
    messages: textMessagesRepo.listDeliveredByThread(thread.id),
    available: avail.available,
    unavailableReason: avail.reason,
  };
}

export function unreadTextCount(worldId?: string, playerId: string = DEFAULT_PLAYER_ID): number {
  deliverDueTexts();
  return threadsRepo
    .listByPlayer(playerId)
    .filter((t) => (worldId ? charactersRepo.get(t.characterId)?.worldId === worldId : true))
    .reduce((n, t) => n + t.unreadCount, 0);
}

export interface SendTextResult {
  playerMessage: TextMessage;
  reply: TextMessage | null;
  error: string | null;
  /** Small relationship change this exchange caused (empty if none). */
  relationshipDelta: Partial<Record<RelationshipStatKey, number>>;
  /** Present when the player attached a gift — the character's reaction to it. */
  giftReaction?: { line: string; expression: string; sentiment: GiftSentiment; itemName: string } | null;
}

/** Player texts a character; the character replies (short, structured). Free — no stamina.
 *  An optional `imageAssetId` attaches a photo the player uploaded — the server reads
 *  it from the uploads dir, base64-encodes it, and routes the reply + judge through the
 *  configured VISION model so the character actually reacts to what's in the picture. */
export async function sendPlayerText(
  characterId: string,
  text: string,
  imageAssetId: string | null = null,
  playerId: string = DEFAULT_PLAYER_ID,
  giftId: string | null = null,
): Promise<SendTextResult> {
  const character = getCharacter(characterId);
  if (isMemorialized(getRelationship(characterId))) {
    throw badRequest(`${character.name} is no longer with us.`);
  }
  if (!hasDated(characterId)) {
    throw badRequest(`You can only text someone you've been on a date with.`);
  }
  if (!text.trim() && !imageAssetId && !giftId) {
    throw badRequest('Type a message, attach an image, or send a gift.');
  }
  const day = character.worldId ? ensureWorldState(character.worldId).day : null;
  if (character.worldId && day != null) {
    const avail = getCharacterAvailability(character.worldId, day, characterId);
    if (!avail.available) throw badRequest(`${character.name} ${avail.reason ?? 'is unavailable right now'}.`);
  }

  // Gift path: a held item sent with (or instead of) a text. The gift REACTION is
  // the character's reply, so we skip the normal reply + judge flow. reactToGift is
  // fail-safe (nothing applied or consumed if the model can't read it); only then do
  // we record the player's text WITH the gift attached and the reaction as the reply.
  if (giftId) {
    const r = await reactToGift({
      characterId,
      inventoryItemId: giftId,
      playerId: playerIdForWorldOrDefault(character.worldId),
      scene: 'text',
      playerText: text,
    });
    const giftThread = getOrCreateThread(characterId, playerId);
    const sentAt = Date.now();
    const giftPlayerMessage = textMessagesRepo.insert(
      TextMessageSchema.parse({
        id: newId('txt'),
        threadId: giftThread.id,
        sender: 'player',
        body: text,
        status: 'delivered',
        dayNumber: day,
        // Claimed already — it's a gift the player SENT, not one to accept.
        attachment: { shopItemId: r.item.id, name: r.item.name, claimed: true },
        deliveredAt: sentAt,
        createdAt: sentAt,
      }),
    );
    if (character.worldId) stampLastSeen(characterId, day ?? 1);
    const giftReplyAt = Date.now();
    const giftReply = textMessagesRepo.insert(
      TextMessageSchema.parse({
        id: newId('txt'),
        threadId: giftThread.id,
        sender: 'character',
        body: r.reaction.line.trim(),
        status: 'delivered',
        dayNumber: day,
        deliveredAt: giftReplyAt,
        createdAt: giftReplyAt,
      }),
    );
    threadsRepo.update({ ...giftThread, lastMessageAt: giftReplyAt, updatedAt: giftReplyAt });
    recordEvent('text_reply', { characterId, tone: 'gift' });
    return {
      playerMessage: giftPlayerMessage,
      reply: giftReply,
      error: null,
      relationshipDelta: r.appliedDeltas,
      giftReaction: { line: r.reaction.line.trim(), expression: r.reaction.expression, sentiment: r.sentiment, itemName: r.item.name },
    };
  }

  // Load + base64 the attached photo (if any) once, for both the reply and the judge.
  // The browser already downscaled it (≈512px tall), so this stays small + fast.
  let imageDataUrl: string | null = null;
  if (imageAssetId) {
    const { buffer, mimeType } = readAssetFile(imageAssetId); // throws notFound if the asset is gone
    imageDataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
  }

  // Serialize per character so the player-insert + reply generation can't interleave
  // with a concurrent send/retry for the same thread (two tabs, a double-fire) — which
  // would otherwise duplicate the reply and double-apply the judge delta.
  return withKeyedLock(`text-reply:${characterId}`, async () => {
    const thread = getOrCreateThread(characterId, playerId);
    const now = Date.now();

    const playerMessage = textMessagesRepo.insert(
      TextMessageSchema.parse({
        id: newId('txt'),
        threadId: thread.id,
        sender: 'player',
        body: text,
        status: 'delivered',
        dayNumber: day,
        imageAssetId,
        deliveredAt: now,
        createdAt: now,
      }),
    );
    threadsRepo.update({ ...thread, lastMessageAt: now, updatedAt: now });

    // Texting counts as staying in touch — reset the neglect clock.
    if (character.worldId) stampLastSeen(characterId, day ?? 1);

    return generateTextReply(character, thread, playerMessage, day, imageDataUrl, playerId);
  });
}

/**
 * Generate (and persist) the character's reply to the player's most-recent text in
 * a thread, then run the IMPARTIAL judge that moves the relationship. Shared by the
 * initial send and the retry path — so a reply that failed the first time (the
 * player's text is already saved) can be regenerated WITHOUT re-inserting (and
 * duplicating) the player's message. Returns `{ reply: null, error }` on a model
 * failure (the player's text stays put, ready to retry); never throws on a bad
 * model response (callStructuredLlm fails safe).
 */
async function generateTextReply(
  character: Character,
  thread: MessageThread,
  playerMessage: TextMessage,
  day: number | null,
  imageDataUrl: string | null,
  playerId: string,
): Promise<SendTextResult> {
  const settings = getLlmSettings();
  // Route image-bearing texts to the vision model (falls back to the main model
  // when none is configured); plain texts use the normal model untouched.
  const effectiveSettings = imageDataUrl
    ? { ...settings, model: settings.visionModel.trim() || settings.model }
    : settings;
  const player = getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId));
  const playerName = player.name;
  const memories = selectTopMemories(character.id, 5);
  // The last 12 delivered texts (each carrying its in-world day so the reply can
  // flag stale plans), plus the folded cross-date history so the reply reflects
  // the last date the player and character actually shared.
  const recentTexts = getRecentTexts(character.id, 12, playerId);
  const chronicleRow = chroniclesRepo.getByCharacter(character.id, DEFAULT_PLAYER_ID);
  const chronicle = chronicleRow ? { chronicle: chronicleRow.chronicle, recentLines: chronicleRow.recentLines } : null;
  const result = await callStructuredLlm(
    TextReplySchema,
    buildTextReplyMessages({
      character,
      relationship: getRelationship(character.id),
      recentTexts,
      playerName,
      playerGender: player.gender,
      worldDay: day,
      chronicle,
      memories,
      acquaintances: listAcquaintances(character),
      imageDataUrl,
    }),
    { settings: effectiveSettings, task: 'Reply to the player’s text in character (short).', schemaName: 'TextReply' },
  );

  if (!result.ok) {
    recordEvent('text_reply_failed', { characterId: character.id, error: result.error });
    return { playerMessage, reply: null, error: result.error, relationshipDelta: {} };
  }

  const replyAt = Date.now();
  const reply = textMessagesRepo.insert(
    TextMessageSchema.parse({
      id: newId('txt'),
      threadId: thread.id,
      sender: 'character',
      body: result.data.body,
      status: 'delivered',
      dayNumber: day,
      deliveredAt: replyAt,
      createdAt: replyAt,
    }),
  );
  threadsRepo.update({ ...thread, lastMessageAt: replyAt, updatedAt: replyAt });
  recordEvent('text_reply', { characterId: character.id, tone: result.data.tone });

  // How the relationship moves is decided by an IMPARTIAL judge of how the
  // PLAYER's text landed — NOT by the character's self-reported reply tone (a
  // warm character will text back warmly even to an insult, which used to launder
  // hostility into a warmth gain). The server owns the delta from that read
  // (`recentTexts` already ends with the player's just-sent message). Positive
  // warmth is still capped per in-world day (no grinding by spamming nice texts);
  // negative reads always land — being rude over text costs you, just like a date.
  let applied: Partial<Record<RelationshipStatKey, number>> = {};
  const judge = await callStructuredLlm(
    TextJudgeSchema,
    buildTextJudgeMessages({ character, relationship: getRelationship(character.id), recentTexts, playerName, memories, imageDataUrl }),
    { settings: effectiveSettings, role: 'evaluator', task: "Judge how the player's most recent text landed for this character.", schemaName: 'TextJudge' },
  );
  if (judge.ok) {
    const base = textEngagementDelta(judge.data.engagement);
    const gain = positiveWarmth(base);
    applied = base;
    if (gain > 0) {
      const rel = getRelationship(character.id);
      const bucket = day ?? 0;
      const usedToday =
        rel.flags['text:gainDay'] === bucket && typeof rel.flags['text:gainAmt'] === 'number'
          ? (rel.flags['text:gainAmt'] as number)
          : 0;
      // Trim the positive warmth to the remaining daily headroom so a single
      // high-engagement text can't exceed TEXT_DAILY_GAIN_CAP (negatives untouched).
      const { delta: capped, applied: spent } = capWarmthGain(base, TEXT_DAILY_GAIN_CAP - usedToday);
      applied = capped;
      if (spent > 0) {
        setRelationshipFlag(character.id, 'text:gainDay', bucket, { source: 'text' });
        setRelationshipFlag(character.id, 'text:gainAmt', usedToday + spent, { source: 'text' });
      }
    }
    if (Object.keys(applied).length > 0) {
      applyRelationshipChange(character.id, applied, {
        source: 'text',
        detail: { engagement: judge.data.engagement, hostile: judge.data.hostile },
      });
    } else {
      applied = {};
    }
  } else {
    // Fail safe: an unreadable judge response leaves the relationship untouched.
    recordEvent('text_judge_failed', { characterId: character.id, error: judge.error });
  }

  return { playerMessage, reply, error: null, relationshipDelta: applied };
}

/**
 * Retry the character's reply after a send whose reply failed to generate. The
 * player's text is already saved (the send persists it BEFORE asking the model),
 * so this regenerates the reply against the existing thread WITHOUT inserting a
 * second copy of the player's message. Idempotent-ish: if the thread's last
 * message is already a character reply (a prior retry landed, or a race), it
 * returns that reply untouched rather than generating another.
 */
export async function retryPlayerTextReply(
  characterId: string,
  playerId: string = DEFAULT_PLAYER_ID,
): Promise<SendTextResult> {
  const character = getCharacter(characterId);
  if (isMemorialized(getRelationship(characterId))) {
    throw badRequest(`${character.name} is no longer with us.`);
  }
  if (!hasDated(characterId)) {
    throw badRequest(`You can only text someone you've been on a date with.`);
  }
  // Same per-character lock as sendPlayerText: re-evaluate the trailing message
  // INSIDE the critical section so two concurrent retries (or a retry racing a
  // send) can't both generate — the second sees the reply and no-ops.
  return withKeyedLock(`text-reply:${characterId}`, async () => {
    const thread = getOrCreateThread(characterId, playerId);
    const msgs = textMessagesRepo.listDeliveredByThread(thread.id);
    const last = msgs[msgs.length - 1];
    if (!last) throw badRequest('There’s nothing here to reply to yet.');
    // Already answered — return the existing reply (and its prompting player text)
    // so a double-tap / race is a harmless no-op rather than a duplicate reply.
    if (last.sender === 'character') {
      const lastPlayer = [...msgs].reverse().find((m) => m.sender === 'player');
      return { playerMessage: lastPlayer ?? last, reply: last, error: null, relationshipDelta: {} };
    }
    // A gift text always persists its reaction reply atomically with the player
    // message, so an unanswered trailing text is never a gift — guard anyway.
    if (last.attachment) throw badRequest('That message has already been handled.');
    const day = character.worldId ? ensureWorldState(character.worldId).day : null;
    // Rebuild the attached photo (if any) so the regenerated reply still reacts to it.
    let imageDataUrl: string | null = null;
    if (last.imageAssetId) {
      try {
        const { buffer, mimeType } = readAssetFile(last.imageAssetId);
        imageDataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
      } catch {
        imageDataUrl = null; // the asset is gone — reply to the text alone
      }
    }
    return generateTextReply(character, thread, last, day, imageDataUrl, playerId);
  });
}

export function claimTextGift(textId: string, playerId: string = DEFAULT_PLAYER_ID) {
  // One atomic unit: mark claimed FIRST (gates re-entry), then grant. If the
  // grant throws, the whole transaction — including the claimed flag — rolls back.
  return getDb().transaction(() => {
    const text = textMessagesRepo.get(textId);
    if (!text || !text.attachment) throw badRequest('No gift is attached to that message.');
    if (text.attachment.claimed) throw badRequest('You already claimed this gift.');
    const item = getShopItem(text.attachment.shopItemId); // throws if the item is gone
    // Defense in depth: only low-rarity items are giftable, re-checked at claim time.
    if (!(GIFTABLE_RARITIES as readonly string[]).includes(item.rarity)) {
      throw badRequest('That gift is no longer available.');
    }
    textMessagesRepo.update({ ...text, attachment: { ...text.attachment, claimed: true } });
    // The gift lands in the per-world inventory: derive the world from the text's
    // thread → character (the gift came from someone in a specific world).
    const thread = threadsRepo.get(text.threadId);
    const giftWorldId = thread ? charactersRepo.get(thread.characterId)?.worldId ?? null : null;
    const grantPlayerId = giftWorldId ? playerIdForWorldOrDefault(giftWorldId) : playerId;
    const { inventoryItem } = grantItem(text.attachment.shopItemId, 1, grantPlayerId);
    recordEvent('gift_claimed', { worldId: giftWorldId, textId, shopItemId: text.attachment.shopItemId });
    return { item, inventoryItem };
  });
}
