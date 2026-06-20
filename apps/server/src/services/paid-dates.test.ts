import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DAILY_INCOME, DEFAULT_STARTING_MONEY, venueCost } from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { createWorld } from './world-service';
import { createCharacter } from './character-service';
import { createSession, addPlayerMessage, endSession } from './conversation-service';
import { advanceDay } from './world-clock-service';
import { getOrCreatePlayer, addMoney, spendMoney } from './player-service';
import { playerIdForWorld } from '../lib/ids';
import { sessionsRepo } from '../db/repositories';

const evalReply = () =>
  new ScriptedAdapter([
    JSON.stringify({
      mood: 'warm',
      expression: 'smiling',
      relationshipDeltas: {},
      memoryCandidates: [],
      summaryLine: 'A pleasant evening out.',
    }),
  ]);

function worldWithVenues() {
  const world = createWorld({
    name: 'Lumen',
    locations: [
      { id: 'loc_free', name: 'Park', description: '', tags: [], indoor: false, priceTier: 0 },
      { id: 'loc_nice', name: 'Bistro', description: '', tags: [], indoor: true, priceTier: 2 }, // 100
      { id: 'loc_lavish', name: 'Aurora', description: '', tags: [], indoor: true, priceTier: 3 }, // 200
    ],
  });
  const character = createCharacter({
    worldId: world.id,
    name: 'Date',
    age: 25,
    datingStats: { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 },
  });
  return { world, character, wallet: playerIdForWorld(world.id) };
}

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('paid dates — affordability gate', () => {
  it('blocks a venue you cannot afford, but never deducts at setup', () => {
    const { character, wallet } = worldWithVenues();
    spendMoney(DEFAULT_STARTING_MONEY - 30, wallet); // leave 30 in the wallet

    expect(() => createSession({ characterId: character.id, mode: 'date', locationId: 'loc_lavish' })).toThrow();
    expect(getOrCreatePlayer(wallet).money).toBe(30); // gate didn't charge

    // A free venue is always reachable even while broke.
    const free = createSession({ characterId: character.id, mode: 'date', locationId: 'loc_free' });
    expect(free.id).toBeTruthy();
    expect(getOrCreatePlayer(wallet).money).toBe(30); // still only checked, not charged
  });

  it('allows an affordable venue and defers the charge to the date itself', () => {
    const { character, wallet } = worldWithVenues();
    addMoney(250, wallet); // 500 total, can afford lavish (200)
    const sess = createSession({ characterId: character.id, mode: 'date', locationId: 'loc_lavish' });
    expect(sess.id).toBeTruthy();
    expect(getOrCreatePlayer(wallet).money).toBe(500); // not charged until the date ends
  });
});

describe('paid dates — charging', () => {
  it('charges the venue cost when a real date ends', async () => {
    const { character, wallet } = worldWithVenues();
    const sess = createSession({ characterId: character.id, mode: 'date', locationId: 'loc_nice' });
    addPlayerMessage(sess.id, 'This place is lovely — thanks for bringing me.');
    setAdapterOverride(evalReply());

    const res = await endSession(sess.id);
    expect(res.evaluated).toBe(true);
    expect(getOrCreatePlayer(wallet).money).toBe(DEFAULT_STARTING_MONEY - venueCost(2)); // 250 - 100
  });

  it('refuses to end a paid date you can no longer afford (no silent discount, no stamina spent)', async () => {
    const { character, wallet } = worldWithVenues();
    const sess = createSession({ characterId: character.id, mode: 'date', locationId: 'loc_nice' }); // 100, affordable now
    addPlayerMessage(sess.id, 'Lovely place.');
    // Drain the wallet below the venue cost AFTER the date opened.
    spendMoney(DEFAULT_STARTING_MONEY - 10, wallet); // 10 left, venue costs 100
    setAdapterOverride(evalReply());

    await expect(endSession(sess.id)).rejects.toThrow(/can no longer afford/i);
    expect(getOrCreatePlayer(wallet).money).toBe(10); // not charged a partial amount
    expect(sessionsRepo.get(sess.id)?.ended).toBe(false); // still re-endable once funds return
  });

  it('never charges a free / anywhere date', async () => {
    const { character, wallet } = worldWithVenues();
    const sess = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(sess.id, 'Hey, good to see you.');
    setAdapterOverride(evalReply());

    await endSession(sess.id);
    expect(getOrCreatePlayer(wallet).money).toBe(DEFAULT_STARTING_MONEY);
  });

  it('does not charge a date you never actually spoke on (empty date)', async () => {
    const { character, wallet } = worldWithVenues();
    const sess = createSession({ characterId: character.id, mode: 'date', locationId: 'loc_lavish' });
    // No player turn → the empty-date guard deletes it and skips the charge.
    const res = await endSession(sess.id);
    expect(res.evaluated).toBe(false);
    expect(sessionsRepo.get(sess.id)).toBeUndefined();
    expect(getOrCreatePlayer(wallet).money).toBe(DEFAULT_STARTING_MONEY);
  });
});

describe('passive income', () => {
  it('credits the world wallet a daily trickle on Sleep', async () => {
    const { world, wallet } = worldWithVenues();
    const before = getOrCreatePlayer(wallet).money;
    const res = await advanceDay(world.id);
    expect(res.income).toBe(DAILY_INCOME);
    expect(getOrCreatePlayer(wallet).money).toBe(before + DAILY_INCOME);
  });
});
