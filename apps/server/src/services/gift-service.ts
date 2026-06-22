import {
  GiftReactionSchema,
  MessageSchema,
  RELATIONSHIP_STAT_KEYS,
  isGiftableItem,
  type GiftReaction,
  type GiftReactionResponse,
  type GiftSentiment,
  type InventoryItem,
  type Message,
  type Relationship,
  type RelationshipStatKey,
  type ShopItem,
} from '@dsim/shared';
import { inventoryRepo, messagesRepo, sessionsRepo } from '../db/repositories';
import { getDb } from '../db/index';
import { badRequest, notFound } from '../lib/errors';
import { newId, playerIdForWorldOrDefault } from '../lib/ids';
import { getCharacter } from './character-service';
import { getRelationship } from './relationship-service';
import { getOrCreatePlayer } from './player-service';
import { applyRelationshipChange, setRelationshipFlag } from './stat-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { appendChronicleLine } from './chronicle-service';
import { recordEvent } from './event-service';
import { getLlmSettings } from './settings-service';
import { ensureWorldState } from './world-clock-service';
import { consumeInventoryItem, getShopItem } from './shop-service';
import { callStructuredLlm } from '../llm/structured';
import { buildGiftReactionMessages } from '../prompt/prompt-builder';

/** A gift is a gesture, not a grand event — each delta is capped to this nudge. */
const GIFT_MAX_DELTA = 6;

const WARMTH_KEYS: readonly RelationshipStatKey[] = ['affection', 'trust', 'chemistry', 'comfort', 'respect'];

/** Server-derived read of how a gift landed, from the deltas actually applied. */
function giftSentiment(d: Partial<Record<RelationshipStatKey, number>>): GiftSentiment {
  const warmth = WARMTH_KEYS.reduce((s, k) => s + (d[k] ?? 0), 0);
  const net = warmth - (d.tension ?? 0);
  if (net > 0) return 'positive';
  if (net < 0 || (d.tension ?? 0) > 0) return 'negative';
  return 'neutral';
}

export interface ReactToGiftResult {
  reaction: GiftReaction;
  appliedDeltas: Partial<Record<RelationshipStatKey, number>>;
  sentiment: GiftSentiment;
  relationship: Relationship;
  item: ShopItem;
  inventoryItem: InventoryItem;
  memoryWritten: boolean;
}

/**
 * Core gift reaction shared by both entry points (in-date + by text). The model
 * reads the item + who the character is + the relationship and proposes a spoken
 * line, expression, modest deltas, and an optional keepsake. The SERVER owns the
 * outcome: it caps each delta to a gift-sized nudge, applies a same-day
 * diminishing scale to POSITIVE warmth (so repeat-gifting can't grind — negatives
 * always land in full), applies via the stat service, writes the keepsake +
 * chronicle + event, and only THEN consumes the item. Fails safe (nothing
 * mutated, nothing consumed) if the structured call fails.
 */
export async function reactToGift(args: {
  characterId: string;
  inventoryItemId: string;
  playerId: string;
  scene: 'date' | 'text';
  /** The accompanying message sent with the gift, if any. */
  playerText?: string;
  /** Recent date turns for in-scene context (date scene only). */
  recentMessages?: Message[];
  signal?: AbortSignal;
}): Promise<ReactToGiftResult> {
  const { characterId, inventoryItemId, playerId, scene, playerText, recentMessages, signal } = args;

  // Validate the item BEFORE the model call so we never burn a call on something
  // the player doesn't own; it's consumed only after a successful reaction.
  const inv = inventoryRepo.get(inventoryItemId);
  if (!inv || inv.playerId !== playerId) throw notFound('Inventory item not found.');
  if (inv.quantity <= 0) throw badRequest('You have none of this item left.');
  const item = getShopItem(inv.shopItemId);
  if (!isGiftableItem(item)) throw badRequest(`${item.name} isn't something you can give as a gift.`);

  const character = getCharacter(characterId);
  const relationship = getRelationship(characterId);
  const day = character.worldId ? ensureWorldState(character.worldId).day : 0;
  const playerName = getOrCreatePlayer(playerId).name;

  const settings = getLlmSettings();
  const result = await callStructuredLlm(
    GiftReactionSchema,
    buildGiftReactionMessages({ character, relationship, item, scene, playerName, playerText, recentMessages }),
    { settings, task: 'Decide how the character reacts to receiving a gift.', schemaName: 'GiftReaction', signal },
  );
  if (!result.ok) {
    // FAIL SAFE: do not apply deltas, write a memory, or consume the item.
    recordEvent('gift_reaction_failed', { characterId, itemId: item.id, error: result.error });
    throw badRequest('They didn’t quite know how to react just now — try again.');
  }
  const reaction = result.data;

  // Anti-grind: scale POSITIVE warmth for repeat gifts the same day. Inventory
  // scarcity (gifts cost money) is the primary limiter; this is the backstop.
  const giftsToday =
    relationship.flags['gift:day'] === day && typeof relationship.flags['gift:count'] === 'number'
      ? (relationship.flags['gift:count'] as number)
      : 0;
  const positiveScale = giftsToday <= 0 ? 1 : giftsToday === 1 ? 0.5 : 0;

  const applied: Partial<Record<RelationshipStatKey, number>> = {};
  for (const key of RELATIONSHIP_STAT_KEYS) {
    const raw = reaction.relationshipDeltas[key];
    if (typeof raw !== 'number' || raw === 0) continue;
    let v = Math.max(-GIFT_MAX_DELTA, Math.min(GIFT_MAX_DELTA, raw));
    // Tension is not "warmth" — a positive tension delta is a BAD thing, so it's
    // never softened by the anti-grind scale; only genuine warmth gains are.
    if (key !== 'tension' && v > 0) v = Math.round(v * positiveScale);
    if (v !== 0) applied[key] = v;
  }

  // Commit atomically, consuming the item FIRST. Consuming up front means a
  // concurrent gift of the same last unit — or any later failure in this block —
  // rolls back ALL deltas instead of crediting warmth + a keepsake for an item that
  // was never actually given. (The LLM await above is the yield point; two requests
  // both passed the quantity guard on the pre-await snapshot.) Mirrors
  // shop-service.useItem: consume-then-apply, one transaction.
  return getDb().transaction<ReactToGiftResult>(() => {
    // Re-validates ownership + quantity > 0 and decrements; THROWS (rolling the
    // transaction back) if the unit is already gone — the double-spend guard.
    const inventoryItem = consumeInventoryItem(inventoryItemId, playerId);

    let relAfter = relationship;
    if (Object.keys(applied).length > 0) {
      relAfter = applyRelationshipChange(characterId, applied, { source: 'gift', detail: { itemId: item.id, scene } });
    }
    setRelationshipFlag(characterId, 'gift:day', day, { source: 'gift' });
    setRelationshipFlag(characterId, 'gift:count', giftsToday + 1, { source: 'gift' });

    const event = recordEvent('gift_given', {
      characterId,
      itemId: item.id,
      itemName: item.name,
      scene,
      day,
      deltas: applied,
      expression: reaction.expression,
    });

    let memoryWritten = false;
    if (reaction.memory) {
      addMemoriesFromEvaluation(characterId, [reaction.memory], event.id);
      memoryWritten = true;
    }
    try {
      appendChronicleLine(
        characterId,
        day,
        scene === 'date' ? 'date' : 'chat',
        `🎁 ${reaction.memory?.text ?? `${playerName} gave me ${item.name}.`}`,
        { bumpSession: false },
      );
    } catch {
      /* chronicle is best-effort; never block the gift */
    }

    return {
      reaction,
      appliedDeltas: applied,
      sentiment: giftSentiment(applied),
      relationship: relAfter,
      item,
      inventoryItem,
      memoryWritten,
    };
  });
}

/**
 * Give a held item to your date in-session. Runs the gift reaction, then writes a
 * "🎁 you gave …" narrator beat + the character's spoken reaction into the
 * transcript (so the conversation — and the end-of-date evaluator — stay coherent).
 */
export async function giveGiftOnDate(
  sessionId: string,
  inventoryItemId: string,
  signal?: AbortSignal,
): Promise<GiftReactionResponse> {
  const session = sessionsRepo.get(sessionId);
  if (!session) throw notFound(`Session ${sessionId} not found.`);
  if (session.ended) throw badRequest('This date has already ended.');

  const character = getCharacter(session.characterId);
  const playerId = playerIdForWorldOrDefault(character.worldId);
  const recent = messagesRepo.listBySession(sessionId).slice(-12);

  const r = await reactToGift({
    characterId: character.id,
    inventoryItemId,
    playerId,
    scene: 'date',
    recentMessages: recent,
    signal,
  });

  const now = Date.now();
  const narratorMessage = messagesRepo.insert(
    MessageSchema.parse({
      id: newId('msg'),
      sessionId,
      role: 'narrator',
      text: `🎁 You gave ${character.name} ${r.item.name}.`,
      metadata: { gift: r.item.id },
      createdAt: now,
    }),
  );
  const message = messagesRepo.insert(
    MessageSchema.parse({
      id: newId('msg'),
      sessionId,
      role: 'character',
      text: r.reaction.line.trim(),
      metadata: { gift: r.item.name, expression: r.reaction.expression },
      createdAt: now + 1,
    }),
  );

  return {
    narratorMessage,
    message,
    line: r.reaction.line.trim(),
    expression: r.reaction.expression,
    sentiment: r.sentiment,
    deltas: r.appliedDeltas,
    relationship: r.relationship,
    item: r.item,
    memoryWritten: r.memoryWritten,
  };
}
