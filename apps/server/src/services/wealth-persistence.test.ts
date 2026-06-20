import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { getDb } from '../db/index';
import { createWorld, deleteWorld } from './world-service';
import { createCharacter } from './character-service';
import { ensureWorldState } from './world-clock-service';
import { createSession, addPlayerMessage, endSession } from './conversation-service';
import { getRelationship } from './relationship-service';
import { createProperty, buyProperty, leaseProperty } from './property-service';
import { createCompany, buyStock } from './market-service';
import { runDailyWealth } from './wealth-service';
import { sendLandlordNotice } from './landlord-notice-service';
import { exportAll, importAll, resetProgress } from './data-service';
import { getOrCreatePlayer, addMoney } from './player-service';
import { playerIdForWorld } from '../lib/ids';
import {
  propertiesRepo,
  propertyOwnershipRepo,
  propertyLeasesRepo,
  landlordNoticesRepo,
  companiesRepo,
  stockHoldingsRepo,
  stockPricesRepo,
} from '../db/repositories';

const evalNoDelta = () =>
  new ScriptedAdapter([
    JSON.stringify({ mood: 'warm', expression: 'smiling', relationshipDeltas: {}, memoryCandidates: [], summaryLine: 'A nice evening.' }),
  ]);

function wealthWorld(money = 100_000) {
  const world = createWorld({ name: 'Wealth', featureFlags: { property: true, stockMarket: true } });
  ensureWorldState(world.id);
  const character = createCharacter({
    worldId: world.id,
    name: 'Date',
    age: 25,
    datingStats: { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 },
  });
  if (money > 0) addMoney(money, playerIdForWorld(world.id));
  return { world, character, wallet: playerIdForWorld(world.id) };
}

const moneyOf = (worldId: string) => getOrCreatePlayer(playerIdForWorld(worldId)).money;

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('property as a date venue', () => {
  it('dating at an OWNED property is free and grants the full buff', async () => {
    const { world, character, wallet } = wealthWorld();
    const prop = createProperty({ worldId: world.id, name: 'My Loft', buyPrice: 5000, buffStat: 'respect', buffAmount: 4 });
    buyProperty(world.id, prop.id);
    const moneyAfterBuy = getOrCreatePlayer(wallet).money;
    const relBefore = getRelationship(character.id).respect;

    const sess = createSession({ characterId: character.id, mode: 'date', locationId: `prop:${prop.id}` });
    addPlayerMessage(sess.id, 'I love having you over.');
    setAdapterOverride(evalNoDelta());
    await endSession(sess.id);

    expect(getOrCreatePlayer(wallet).money).toBe(moneyAfterBuy); // free (dating is free; you own it)
    expect(getRelationship(character.id).respect).toBe(relBefore + 4); // full buff
  });

  it('dating at a LEASED property is free (rent is separate) and grants a half buff', async () => {
    const { world, character, wallet } = wealthWorld();
    const prop = createProperty({
      worldId: world.id,
      name: 'A Nice Place',
      buyPrice: 9000,
      rentAmount: 60,
      rentCadence: 'weekly',
      buffStat: 'respect',
      buffAmount: 4,
    });
    leaseProperty(world.id, prop.id); // pays the first period up front
    const moneyAfterLease = getOrCreatePlayer(wallet).money;
    const relBefore = getRelationship(character.id).respect;

    const sess = createSession({ characterId: character.id, mode: 'date', locationId: `prop:${prop.id}` });
    addPlayerMessage(sess.id, 'Thanks for coming over.');
    setAdapterOverride(evalNoDelta());
    await endSession(sess.id);

    expect(getOrCreatePlayer(wallet).money).toBe(moneyAfterLease); // the DATE itself is free
    expect(getRelationship(character.id).respect).toBe(relBefore + 2); // half of 4
  });
});

describe('persistence: export / import round-trip', () => {
  it('preserves authored definitions AND playthrough wealth (incl. leases) on a savegame round-trip', () => {
    const { world } = wealthWorld();
    const owned = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 4000 });
    const leased = createProperty({ worldId: world.id, name: 'Flat', buyPrice: 9000, rentAmount: 50, rentCadence: 'weekly' });
    const co = createCompany({ worldId: world.id, name: 'Acme', ticker: 'ACM', basePrice: 100, volatility: 0 });
    buyProperty(world.id, owned.id);
    leaseProperty(world.id, leased.id);
    buyStock(world.id, co.id, 5);
    runDailyWealth(world.id, 2, []);

    const bundle = exportAll({ kind: 'savegame' });
    expect(bundle.properties.length).toBe(2);
    expect(bundle.propertyOwnership.length).toBe(1);
    expect(bundle.propertyLeases.length).toBe(1);
    expect(bundle.stockHoldings.length).toBe(1);

    importAll(bundle);
    expect(propertiesRepo.listByWorld(world.id).length).toBe(2);
    expect(propertyOwnershipRepo.listByPlayer(world.id, playerIdForWorld(world.id)).length).toBe(1);
    expect(propertyLeasesRepo.listByPlayer(world.id, playerIdForWorld(world.id)).length).toBe(1);
    expect(stockHoldingsRepo.listByPlayer(world.id, playerIdForWorld(world.id)).length).toBe(1);
  });

  it('an AUTHORING export ships definitions but zeroes playthrough wealth', () => {
    const { world } = wealthWorld();
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 9000, rentAmount: 50, rentCadence: 'weekly' });
    const co = createCompany({ worldId: world.id, name: 'Acme', ticker: 'ACM', basePrice: 100, volatility: 0 });
    leaseProperty(world.id, prop.id);
    buyStock(world.id, co.id, 5);
    runDailyWealth(world.id, 2, []);

    const bundle = exportAll({ kind: 'authoring' });
    expect(bundle.properties.length).toBe(1);
    expect(bundle.companies.length).toBe(1);
    expect(bundle.propertyOwnership).toEqual([]);
    expect(bundle.propertyLeases).toEqual([]);
    expect(bundle.landlordNotices).toEqual([]);
    expect(bundle.stockHoldings).toEqual([]);
    expect(bundle.stockPrices).toEqual([]);
    expect(bundle.marketNews).toEqual([]);
  });
});

describe('persistence: reset + world delete', () => {
  it('resetProgress wipes ownership/leases/notices/holdings/prices but keeps the authored definitions', () => {
    const { world } = wealthWorld();
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 9000, rentAmount: 50, rentCadence: 'weekly' });
    const co = createCompany({ worldId: world.id, name: 'Acme', ticker: 'ACM', basePrice: 100, volatility: 0 });
    leaseProperty(world.id, prop.id);
    buyStock(world.id, co.id, 5);
    runDailyWealth(world.id, 2, []);
    sendLandlordNotice({ worldId: world.id, playerId: playerIdForWorld(world.id), propertyId: prop.id, propertyName: 'Loft', kind: 'overdue', amount: 50, graceDay: 5, day: 2 });

    resetProgress();

    expect(propertiesRepo.listByWorld(world.id).length).toBe(1); // definitions kept
    expect(companiesRepo.listByWorld(world.id).length).toBe(1);
    expect(propertyLeasesRepo.list().length).toBe(0); // playthrough wiped
    expect(landlordNoticesRepo.list().length).toBe(0);
    expect(stockHoldingsRepo.list().length).toBe(0);
    expect(stockPricesRepo.list().length).toBe(0);
  });

  it('deleting a world cascades all its wealth rows', () => {
    const { world } = wealthWorld();
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 9000, rentAmount: 50, rentCadence: 'weekly' });
    const co = createCompany({ worldId: world.id, name: 'Acme', ticker: 'ACM', basePrice: 100, volatility: 0 });
    leaseProperty(world.id, prop.id);
    buyStock(world.id, co.id, 5);
    runDailyWealth(world.id, 2, []);
    sendLandlordNotice({ worldId: world.id, playerId: playerIdForWorld(world.id), propertyId: prop.id, propertyName: 'Loft', kind: 'eviction', amount: 50, graceDay: 5, day: 2 });

    deleteWorld(world.id);

    const count = (table: string) => {
      const r = getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE world_id = ?`, world.id);
      return r ? Number(r.n) : 0;
    };
    expect(count('properties')).toBe(0);
    expect(count('property_ownership')).toBe(0);
    expect(count('property_leases')).toBe(0);
    expect(count('landlord_notices')).toBe(0);
    expect(count('companies')).toBe(0);
    expect(count('stock_holdings')).toBe(0);
    expect(count('stock_prices')).toBe(0);
    expect(count('market_news')).toBe(0);
  });
});

void moneyOf;
