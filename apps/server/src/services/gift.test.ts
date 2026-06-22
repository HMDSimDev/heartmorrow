import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { type ShopItemCreate } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { createShopItem, grantItem } from './shop-service';
import { getRelationship } from './relationship-service';
import { listMemories } from './memory-service';
import { createSession } from './conversation-service';
import { giveGiftOnDate } from './gift-service';
import { playerIdForWorld } from '../lib/ids';
import { inventoryRepo, messagesRepo } from '../db/repositories';

function item(partial: Partial<ShopItemCreate> & { name: string }): ShopItemCreate {
  return {
    name: partial.name,
    description: partial.description ?? '',
    price: partial.price ?? 0,
    category: partial.category ?? 'gift',
    rarity: partial.rarity ?? 'common',
    effects: partial.effects ?? [],
    infiniteStock: partial.infiniteStock ?? true,
    stock: partial.stock ?? 0,
    assetId: partial.assetId ?? null,
  };
}

const reply = (o: object) => new ScriptedAdapter([JSON.stringify(o)]);

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('gift reactions (on a date)', () => {
  it('applies a CAPPED warmth gain, writes a keepsake, consumes the item, and posts a beat', async () => {
    const { world, character } = seedWorldAndCharacter();
    const gift = createShopItem(item({ name: 'Jazz Record' }));
    const inv = grantItem(gift.id, 1, playerIdForWorld(world.id)).inventoryItem;
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    const before = getRelationship(character.id).affection;
    // Model proposes +12 (within the schema bound of 15); the server caps a gift
    // to GIFT_MAX_DELTA (6).
    setAdapterOverride(
      reply({
        expression: 'happy',
        line: 'I love this!',
        relationshipDeltas: { affection: 12 },
        memory: { text: 'They got me a record by my favourite band.', importance: 4, tags: ['gift'] },
      }),
    );

    const res = await giveGiftOnDate(session.id, inv.id);
    expect(res.sentiment).toBe('positive');
    expect(res.deltas.affection).toBe(6); // capped
    expect(getRelationship(character.id).affection).toBe(before + 6);
    expect(res.memoryWritten).toBe(true);
    expect(listMemories(character.id).some((m) => m.tags.includes('gift'))).toBe(true);
    expect(inventoryRepo.get(inv.id)?.quantity).toBe(0); // consumed

    const msgs = messagesRepo.listBySession(session.id);
    expect(msgs.filter((m) => m.role === 'narrator')).toHaveLength(1);
    expect(msgs.some((m) => m.role === 'character' && /love/i.test(m.text))).toBe(true);
  });

  it('a disliked gift lands negative — cooler + tension', async () => {
    const { world, character } = seedWorldAndCharacter();
    const gift = createShopItem(item({ name: 'Cheap Mug' }));
    const inv = grantItem(gift.id, 1, playerIdForWorld(world.id)).inventoryItem;
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    const beforeTension = getRelationship(character.id).tension;
    setAdapterOverride(
      reply({ expression: 'annoyed', line: 'Oh. Thanks.', relationshipDeltas: { affection: -3, tension: 5 }, memory: null }),
    );

    const res = await giveGiftOnDate(session.id, inv.id);
    expect(res.sentiment).toBe('negative');
    expect(getRelationship(character.id).tension).toBe(beforeTension + 5);
  });

  it('halves a repeat gift’s warmth the same day (anti-grind), full caps untouched on the first', async () => {
    const { world, character } = seedWorldAndCharacter();
    const gift = createShopItem(item({ name: 'Pastry' }));
    const inv = grantItem(gift.id, 2, playerIdForWorld(world.id)).inventoryItem;
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    const a0 = getRelationship(character.id).affection;
    setAdapterOverride(reply({ expression: 'happy', line: 'Yum!', relationshipDeltas: { affection: 12 }, memory: null }));

    await giveGiftOnDate(session.id, inv.id); // capped to +6
    const a1 = getRelationship(character.id).affection;
    expect(a1).toBe(a0 + 6);
    await giveGiftOnDate(session.id, inv.id); // capped 6, then scaled ×0.5 → +3
    expect(getRelationship(character.id).affection).toBe(a1 + 3);
  });

  it('fails safe: a malformed reaction changes nothing and consumes nothing', async () => {
    const { world, character } = seedWorldAndCharacter();
    const gift = createShopItem(item({ name: 'Locket' }));
    const inv = grantItem(gift.id, 1, playerIdForWorld(world.id)).inventoryItem;
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    const before = getRelationship(character.id).affection;
    setAdapterOverride(new ScriptedAdapter(['not valid json {']));

    await expect(giveGiftOnDate(session.id, inv.id)).rejects.toThrow();
    expect(getRelationship(character.id).affection).toBe(before);
    expect(inventoryRepo.get(inv.id)?.quantity).toBe(1); // NOT consumed
  });

  it('rejects a non-giftable (consumable) item', async () => {
    const { world, character } = seedWorldAndCharacter();
    const snack = createShopItem(item({ name: 'Energy Bar', category: 'consumable' }));
    const inv = grantItem(snack.id, 1, playerIdForWorld(world.id)).inventoryItem;
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    await expect(giveGiftOnDate(session.id, inv.id)).rejects.toThrow(/gift/i);
  });

  it('a concurrent double-gift of the LAST unit applies warmth + keepsake exactly once', async () => {
    // Regression: deltas used to be applied BEFORE consuming the item, so two
    // overlapping gifts of a quantity-1 item both credited warmth before the second
    // consume failed. Now we consume-first inside a transaction, so the loser rolls
    // back entirely.
    const { world, character } = seedWorldAndCharacter();
    const gift = createShopItem(item({ name: 'Single Rose' }));
    const inv = grantItem(gift.id, 1, playerIdForWorld(world.id)).inventoryItem;
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    const before = getRelationship(character.id).affection;
    setAdapterOverride(
      reply({
        expression: 'happy',
        line: 'A rose — lovely!',
        relationshipDeltas: { affection: 6 },
        memory: { text: 'They gave me a single rose.', importance: 3, tags: ['gift'] },
      }),
    );

    const results = await Promise.allSettled([
      giveGiftOnDate(session.id, inv.id),
      giveGiftOnDate(session.id, inv.id),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(getRelationship(character.id).affection).toBe(before + 6); // credited ONCE
    expect(inventoryRepo.get(inv.id)?.quantity).toBe(0); // consumed once, never negative
    expect(listMemories(character.id).filter((m) => m.tags.includes('gift'))).toHaveLength(1);
  });
});
