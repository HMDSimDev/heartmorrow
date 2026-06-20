import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_PLAYER_ID, LAST_SEEN_FLAG, TextMessageSchema } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { getRelationship } from './relationship-service';
import { ensureWorldState, spendStamina } from './world-clock-service';
import { addPlayerMessage, createSession } from './conversation-service';
import { generateDailyTextsForDay } from './text-generation-service';
import {
  claimTextGift,
  deliverDueTexts,
  getOrCreateThread,
  sendPlayerText,
} from './text-message-service';
import { createShopItem, grantItem } from './shop-service';
import { generateDailyEmails } from './email-service';
import { applyRelationshipChange, setRelationshipFlag } from './stat-service';
import { getOrCreatePlayer } from './player-service';
import { emailsRepo, threadsRepo, textMessagesRepo } from '../db/repositories';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

const PLAN = JSON.stringify({ texts: [{ body: 'morning text', phase: 'morning', attachShopItemId: null }] });

/** Mark a character as "dated" by going on a date the player actually spoke in. */
function dateOnce(characterId: string) {
  const session = createSession({ characterId, mode: 'date', locationId: null });
  addPlayerMessage(session.id, 'hey, nice to see you'); // a real date has >= 1 player turn
}

describe('daily text generation eligibility', () => {
  it('never texts a character the player has not dated', async () => {
    const { world, character } = seedWorldAndCharacter();
    setAdapterOverride(new ScriptedAdapter([PLAN]));
    await generateDailyTextsForDay(world.id, 1);
    expect(threadsRepo.getByCharacter(character.id, DEFAULT_PLAYER_ID)).toBeUndefined();
  });

  it('texts a character once they have been dated (when the daily roll hits)', async () => {
    const { world, character } = seedWorldAndCharacter();
    dateOnce(character.id);
    setAdapterOverride(new ScriptedAdapter([PLAN]));
    await generateDailyTextsForDay(world.id, 1, DEFAULT_PLAYER_ID, () => 0); // force a text
    expect(threadsRepo.getByCharacter(character.id, DEFAULT_PLAYER_ID)).toBeDefined();
  });
});

describe('queued text delivery by phase', () => {
  it('holds a night text until the world reaches night', async () => {
    const { world, character } = seedWorldAndCharacter();
    dateOnce(character.id);
    ensureWorldState(world.id); // day 1, morning
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ texts: [{ body: 'up late?', phase: 'night', attachShopItemId: null }] })]));
    // rng: gate passes (0), phase roll high → night phase (server picks the phase now).
    await generateDailyTextsForDay(world.id, 1, DEFAULT_PLAYER_ID, (seed) => (seed.startsWith('textphase') ? 0.9 : 0));

    deliverDueTexts();
    expect(threadsRepo.getByCharacter(character.id, DEFAULT_PLAYER_ID)!.unreadCount).toBe(0);

    spendStamina(world.id);
    spendStamina(world.id);
    spendStamina(world.id); // → night
    deliverDueTexts();
    expect(threadsRepo.getByCharacter(character.id, DEFAULT_PLAYER_ID)!.unreadCount).toBe(1);
  });
});

describe('text cadence + gifts (server-decided)', () => {
  const charTexts = (characterId: string, day?: number) => {
    const thread = threadsRepo.getByCharacter(characterId, DEFAULT_PLAYER_ID);
    if (!thread) return [];
    return textMessagesRepo
      .listAllByThread(thread.id)
      .filter((m) => m.sender === 'character' && (day == null || m.dayNumber === day));
  };

  it('skips the daily text when the roll misses (most days: no text)', async () => {
    const { world, character } = seedWorldAndCharacter();
    dateOnce(character.id);
    setAdapterOverride(new ScriptedAdapter([PLAN]));
    await generateDailyTextsForDay(world.id, 1, DEFAULT_PLAYER_ID, () => 1); // roll misses
    expect(charTexts(character.id).length).toBe(0);
  });

  it('queues exactly ONE text on a hit, never in the afternoon', async () => {
    const { world, character } = seedWorldAndCharacter();
    dateOnce(character.id);
    setAdapterOverride(new ScriptedAdapter([PLAN]));
    await generateDailyTextsForDay(world.id, 1, DEFAULT_PLAYER_ID, () => 0);
    const texts = charTexts(character.id, 1);
    expect(texts.length).toBe(1);
    expect(texts[0]!.scheduledPhase).not.toBe('afternoon');
    expect(['morning', 'evening', 'night']).toContain(texts[0]!.scheduledPhase);
  });

  it('is idempotent — re-running the same day never double-texts', async () => {
    const { world, character } = seedWorldAndCharacter();
    dateOnce(character.id);
    setAdapterOverride(new ScriptedAdapter([PLAN]));
    await generateDailyTextsForDay(world.id, 1, DEFAULT_PLAYER_ID, () => 0);
    await generateDailyTextsForDay(world.id, 1, DEFAULT_PLAYER_ID, () => 0);
    expect(charTexts(character.id, 1).length).toBe(1);
  });

  it('attaches a gift only when the relationship is warm enough', async () => {
    const { world, character } = seedWorldAndCharacter();
    dateOnce(character.id);
    const item = createShopItem({ name: 'Daisy', price: 5, rarity: 'common' });
    const giftPlan = JSON.stringify({ texts: [{ body: 'thought of you', phase: 'morning', attachShopItemId: item.id }] });

    // Cold relationship: gift chance is 0, so no attachment even with a passing gift roll.
    setAdapterOverride(new ScriptedAdapter([giftPlan]));
    await generateDailyTextsForDay(world.id, 1, DEFAULT_PLAYER_ID, () => 0);
    expect(charTexts(character.id, 1)[0]!.attachment).toBeNull();

    // Warm relationship: gift chance > 0; a low gift roll attaches it.
    applyRelationshipChange(character.id, { affection: 80, trust: 80, chemistry: 80, comfort: 80, respect: 80 }, { source: 'test' });
    setAdapterOverride(new ScriptedAdapter([giftPlan]));
    await generateDailyTextsForDay(world.id, 2, DEFAULT_PLAYER_ID, (seed) => (seed.startsWith('gift') ? 0.001 : 0));
    expect(charTexts(character.id, 2)[0]!.attachment?.shopItemId).toBe(item.id);
  });

  it('does not text — not even a queued beat — while the character is unavailable', async () => {
    const { world, character } = seedWorldAndCharacter();
    dateOnce(character.id);
    // A pending breakup beat bypasses the daily cadence, but must still respect
    // availability. Memorializing the character makes them permanently unavailable
    // (a deterministic stand-in for any busy day; dead characters never text).
    setRelationshipFlag(character.id, 'beat:pending', 'breakup', { source: 'test' });
    setRelationshipFlag(character.id, 'harm:memorial', true, { source: 'test' });
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ body: 'we should end things' })]));

    await generateDailyTextsForDay(world.id, 1, DEFAULT_PLAYER_ID, () => 0); // cadence would otherwise fire

    expect(charTexts(character.id, 1).length).toBe(0);
    // The beat is HELD, not consumed — it can fire on a future available day.
    expect(getRelationship(character.id).flags['beat:pending']).toBe('breakup');
  });
});

describe('email cadence', () => {
  it('skips emails on a missed day-roll (no LLM call, no emails)', async () => {
    const { world } = seedWorldAndCharacter();
    const adapter = new ScriptedAdapter([JSON.stringify({ emails: [{ senderName: 'Cafe', senderHandle: 'hi@cafe.test', subject: 'Hi', body: 'Welcome' }] })]);
    setAdapterOverride(adapter);
    await generateDailyEmails(world.id, 1, DEFAULT_PLAYER_ID, () => 1); // roll misses
    expect(emailsRepo.listDeliveredByPlayer(DEFAULT_PLAYER_ID).length).toBe(0);
    expect(adapter.calls).toBe(0);
  });

  it('delivers emails on a hit day-roll', async () => {
    const { world } = seedWorldAndCharacter();
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ emails: [{ senderName: 'Cafe', senderHandle: 'hi@cafe.test', subject: 'Hi', body: 'Welcome' }] })]));
    await generateDailyEmails(world.id, 1, DEFAULT_PLAYER_ID, () => 0); // roll hits
    expect(emailsRepo.listDeliveredByPlayer(DEFAULT_PLAYER_ID).length).toBe(1);
  });

  it('does not double-generate emails when re-run for the same day', async () => {
    const { world } = seedWorldAndCharacter();
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ emails: [{ senderName: 'Cafe', senderHandle: 'hi@cafe.test', subject: 'Hi', body: 'Welcome' }] })]));
    await generateDailyEmails(world.id, 1, DEFAULT_PLAYER_ID, () => 0);
    await generateDailyEmails(world.id, 1, DEFAULT_PLAYER_ID, () => 0); // dev route re-fire
    expect(emailsRepo.listDeliveredByPlayer(DEFAULT_PLAYER_ID).length).toBe(1);
  });
});

describe('gifts', () => {
  it('grantItem adds inventory without charging money', () => {
    const before = getOrCreatePlayer().money;
    const item = createShopItem({ name: 'Trinket', price: 0 });
    const { inventoryItem } = grantItem(item.id, 1);
    expect(inventoryItem.quantity).toBe(1);
    expect(getOrCreatePlayer().money).toBe(before);
  });

  it('claims an attached gift exactly once', () => {
    const { character } = seedWorldAndCharacter();
    const item = createShopItem({ name: 'Charm', price: 0 });
    const thread = getOrCreateThread(character.id);
    const now = Date.now();
    const txt = textMessagesRepo.insert(
      TextMessageSchema.parse({
        id: 'txt_test',
        threadId: thread.id,
        sender: 'character',
        body: 'a little something',
        status: 'delivered',
        attachment: { shopItemId: item.id, name: item.name, claimed: false },
        deliveredAt: now,
        createdAt: now,
      }),
    );
    const res = claimTextGift(txt.id);
    expect(res.inventoryItem.quantity).toBe(1);
    expect(() => claimTextGift(txt.id)).toThrow(/already claimed/i);
  });
});

describe('player texting', () => {
  it('blocks texting a character you have never dated', async () => {
    const { character } = seedWorldAndCharacter();
    await expect(sendPlayerText(character.id, 'hi')).rejects.toThrow(/date/i);
  });

  it('after a date, replies and resets neglect without spending stamina', async () => {
    const { world, character } = seedWorldAndCharacter();
    dateOnce(character.id);
    const before = ensureWorldState(world.id).stamina;
    // Two structured calls now: the in-character reply, then the impartial judge
    // of how the player's text landed (the judge drives the relationship delta).
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({ body: 'sure, sounds good', tone: 'warm' }),
        JSON.stringify({ engagement: 1, hostile: false, note: 'friendly' }),
      ]),
    );
    const res = await sendPlayerText(character.id, 'wanna hang out?');
    expect(res.reply?.body).toBe('sure, sounds good');
    expect(res.relationshipDelta.comfort).toBe(1); // +1 engagement → small warmth
    expect(getRelationship(character.id).flags[LAST_SEEN_FLAG]).toBeDefined();
    expect(ensureWorldState(world.id).stamina).toBe(before);
  });

  it('a hostile text cools the relationship even when the character replies warmly', async () => {
    const { character } = seedWorldAndCharacter();
    dateOnce(character.id);
    // Warm baseline so the penalty is visible (not clamped at 0).
    applyRelationshipChange(character.id, { affection: 50, comfort: 50, tension: 5 }, { source: 'test' });
    const before = getRelationship(character.id);
    // The character still texts back warmly, but the IMPARTIAL judge scores the
    // player's hostile message negative — that is what moves the relationship.
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({ body: 'that really hurts to hear.', tone: 'warm' }),
        JSON.stringify({ engagement: -3, hostile: true, note: 'insulting and cruel' }),
      ]),
    );
    const res = await sendPlayerText(character.id, "you're worthless and I hate you");
    const after = getRelationship(character.id);
    expect(res.relationshipDelta.affection ?? 0).toBeLessThan(0);
    expect(after.affection).toBeLessThan(before.affection);
    expect(after.tension).toBeGreaterThan(before.tension);
  });
});
