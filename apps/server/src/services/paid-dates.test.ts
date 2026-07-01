import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { venueCost, LocationSchema } from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { createWorld } from './world-service';
import { createCharacter } from './character-service';
import { createSession, addPlayerMessage, endSession, pickAnywhereVenue } from './conversation-service';
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

// Money is no longer handed out (starting balance is 0), so each test funds its
// world wallet to a known balance to exercise the affordability/charge paths.
const START = 250;

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
  const wallet = playerIdForWorld(world.id);
  addMoney(START, wallet);
  return { world, character, wallet };
}

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('paid dates — affordability gate', () => {
  it('blocks a venue you cannot afford, but never deducts at setup', () => {
    const { character, wallet } = worldWithVenues();
    spendMoney(START - 30, wallet); // leave 30 in the wallet

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
    expect(getOrCreatePlayer(wallet).money).toBe(START - venueCost(2)); // 250 - 100
  });

  it('refuses to end a paid date you can no longer afford (no silent discount, no stamina spent)', async () => {
    const { character, wallet } = worldWithVenues();
    const sess = createSession({ characterId: character.id, mode: 'date', locationId: 'loc_nice' }); // 100, affordable now
    addPlayerMessage(sess.id, 'Lovely place.');
    // Drain the wallet below the venue cost AFTER the date opened.
    spendMoney(START - 10, wallet); // 10 left, venue costs 100
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
    expect(getOrCreatePlayer(wallet).money).toBe(START);
  });

  it('does not charge a date you never actually spoke on (empty date)', async () => {
    const { character, wallet } = worldWithVenues();
    const sess = createSession({ characterId: character.id, mode: 'date', locationId: 'loc_lavish' });
    // No player turn → the empty-date guard deletes it and skips the charge.
    const res = await endSession(sess.id);
    expect(res.evaluated).toBe(false);
    expect(sessionsRepo.get(sess.id)).toBeUndefined();
    expect(getOrCreatePlayer(wallet).money).toBe(START);
  });
});

describe('"Anywhere" auto-picks a venue', () => {
  const loc = (id: string, priceTier: number) => LocationSchema.parse({ id, name: id, priceTier });

  it('resolves to a FREE public venue when one exists', () => {
    const { character } = worldWithVenues();
    const sess = createSession({ characterId: character.id, mode: 'date', locationId: 'anywhere' });
    expect(sess.locationId).toBe('loc_free'); // not the literal string "anywhere"
  });

  it('picks a RANDOM free venue so "Anywhere" varies (not always the first)', () => {
    const locations = [loc('free_a', 0), loc('free_b', 0), loc('free_c', 0), loc('paid', 2)];
    // rng indexes into the free-only sublist [free_a, free_b, free_c].
    expect(pickAnywhereVenue(locations, 0, () => 0)).toBe('free_a');
    expect(pickAnywhereVenue(locations, 0, () => 0.5)).toBe('free_b');
    expect(pickAnywhereVenue(locations, 0, () => 0.99)).toBe('free_c');
    // An rng that returns 1 (some injected generators can) must not index past the end.
    expect(pickAnywhereVenue([loc('f1', 0), loc('f2', 0)], 0, () => 1)).toBe('f2');
  });

  it('never picks a paid venue when a free one exists, even with money to spare', () => {
    const locations = [loc('paid_a', 3), loc('free', 0), loc('paid_b', 2)];
    expect(pickAnywhereVenue(locations, 1000, () => 0)).toBe('free');
    expect(pickAnywhereVenue(locations, 1000, () => 0.999999)).toBe('free');
  });

  it('falls back to the cheapest affordable venue when nothing is free', () => {
    const world = createWorld({
      name: 'Paywall',
      locations: [
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
    addMoney(150, playerIdForWorld(world.id)); // affords the bistro (100), not the lavish (200)
    const sess = createSession({ characterId: character.id, mode: 'date', locationId: 'anywhere' });
    expect(sess.locationId).toBe('loc_nice'); // the cheapest one within budget
  });

  it('refuses the date when no venue is free and none is affordable', () => {
    const world = createWorld({
      name: 'Too Rich',
      locations: [{ id: 'loc_lavish', name: 'Aurora', description: '', tags: [], indoor: true, priceTier: 3 }], // 200
    });
    const character = createCharacter({
      worldId: world.id,
      name: 'Date',
      age: 25,
      datingStats: { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 },
    });
    addMoney(20, playerIdForWorld(world.id)); // can't afford the only (paid) venue
    expect(() => createSession({ characterId: character.id, mode: 'date', locationId: 'anywhere' })).toThrow(/costs more than you have/i);
  });
});

describe('passive income', () => {
  it('hands out no free money on Sleep — you have to earn it', async () => {
    const { world, wallet } = worldWithVenues();
    const before = getOrCreatePlayer(wallet).money;
    const res = await advanceDay(world.id);
    // No flat daily stipend; a world with no wealth holdings earns nothing passively.
    expect(res.income).toBe(0);
    expect(getOrCreatePlayer(wallet).money).toBe(before);
  });
});
