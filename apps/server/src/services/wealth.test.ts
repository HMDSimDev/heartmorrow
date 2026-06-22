import { describe, it, expect, beforeEach } from 'vitest';
import { stockDailyStep, propertyDateBuff, PROPERTY_GEN, maxDividendForPrice } from '@dsim/shared';
import { resetDb } from '../test/helpers';
import { createWorld, updateWorld } from '../services/world-service';
import { ensureWorldState } from '../services/world-clock-service';
import { worldStatesRepo, propertyLeasesRepo, landlordNoticesRepo } from '../db/repositories';
import { playerIdForWorld } from '../lib/ids';
import { addMoney, getOrCreatePlayer, spendMoney } from '../services/player-service';
import {
  createProperty,
  updateProperty,
  buyProperty,
  sellProperty,
  leaseProperty,
  payRent,
  endLease,
  propertyVenueInfo,
  boundGeneratedProperty,
} from '../services/property-service';
import {
  createCompany,
  buyStock,
  sellStock,
  priceFor,
  getCompany,
  boundGeneratedCompany,
} from '../services/market-service';
import { runDailyWealth, netWorth } from '../services/wealth-service';
import { requireFeature } from '../services/world-feature-service';
import { hashFloat } from '../lib/seeded-random';
import { AppError } from '../lib/errors';

function richWorld(money = 200_000) {
  const world = createWorld({ name: 'Wealth World', featureFlags: { property: true, stockMarket: true } });
  ensureWorldState(world.id);
  if (money > 0) addMoney(money, playerIdForWorld(world.id));
  return world;
}

const moneyOf = (worldId: string) => getOrCreatePlayer(playerIdForWorld(worldId)).money;

describe('property ownership', () => {
  beforeEach(() => resetDb());

  it('buy debits money + creates ownership; sell refunds the flat buy price', () => {
    const world = richWorld(10_000);
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 6800 });
    const before = moneyOf(world.id);

    const buy = buyProperty(world.id, prop.id);
    expect(buy.money).toBe(before - 6800);
    expect(propertyVenueInfo(`prop:${prop.id}`, world.id)?.owned).toBe(true);

    const sell = sellProperty(world.id, prop.id);
    expect(sell.refund).toBe(6800);
    expect(moneyOf(world.id)).toBe(before); // round-trips to flat value (steady asset)
    expect(propertyVenueInfo(`prop:${prop.id}`, world.id)).toBeNull(); // no tenure → can't date
  });

  it('sell refunds the price PAID, not a later-edited buy price (no free-money exploit)', () => {
    // Regression: sellProperty refunded the live, author-editable property.buyPrice,
    // so a creator could buy cheap, raise buyPrice, then sell for a profit. The refund
    // must come from the persisted ownership.purchasePrice instead.
    const world = richWorld(20_000);
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 6800 });
    const before = moneyOf(world.id);

    buyProperty(world.id, prop.id); // pays 6800; purchasePrice persisted = 6800
    updateProperty(prop.id, { buyPrice: 50_000 }); // author bumps the price AFTER buying

    const sell = sellProperty(world.id, prop.id);
    expect(sell.refund).toBe(6800); // what was paid — NOT the inflated 50000
    expect(moneyOf(world.id)).toBe(before); // net zero: no money minted
  });

  it('rejects buying with insufficient funds and double-buying', () => {
    const world = createWorld({ name: 'Poor', featureFlags: { property: true, stockMarket: false } });
    ensureWorldState(world.id);
    const prop = createProperty({ worldId: world.id, name: 'Penthouse', buyPrice: 999_999 });
    expect(() => buyProperty(world.id, prop.id)).toThrow(/Insufficient funds/);

    const world2 = richWorld(50_000);
    const p2 = createProperty({ worldId: world2.id, name: 'Studio', buyPrice: 1000 });
    buyProperty(world2.id, p2.id);
    expect(() => buyProperty(world2.id, p2.id)).toThrow(/already own/);
  });

  it('leasing grants the half buff; owning grants the full buff; buying out ends the lease', () => {
    const world = richWorld();
    const prop = createProperty({
      worldId: world.id,
      name: 'Glasshouse',
      buyPrice: 9000,
      rentAmount: 70,
      rentCadence: 'weekly',
      buffStat: 'chemistry',
      buffAmount: 4,
    });
    // No tenure yet → can't date there.
    expect(propertyVenueInfo(`prop:${prop.id}`, world.id)).toBeNull();
    // Lease → half buff.
    leaseProperty(world.id, prop.id);
    expect(propertyVenueInfo(`prop:${prop.id}`, world.id)).toMatchObject({ owned: false });
    expect(propertyDateBuff('chemistry', 4, false)).toEqual({ chemistry: 2 });
    // Buy → ends the lease, full buff.
    buyProperty(world.id, prop.id);
    expect(propertyVenueInfo(`prop:${prop.id}`, world.id)).toMatchObject({ owned: true });
    expect(propertyLeasesRepo.getByPlayerAndProperty(world.id, playerIdForWorld(world.id), prop.id)).toBeUndefined();
    expect(propertyDateBuff('chemistry', 4, true)).toEqual({ chemistry: 4 });
  });

  it('anti-cheap-buy guard: a generated property is never trivially cheaper to buy than to lease', () => {
    // 700/week = 100/day; MIN_PAYBACK_DAYS=90 → buyPrice raised to >= 9000.
    const draft = boundGeneratedProperty(
      { name: 'Bargain', description: 'x', category: 'residence', buyPrice: 0, rentAmount: 700, rentCadence: 'weekly', indoor: true, tags: [], buffStat: null, buffAmount: 0 },
      'w1',
    );
    expect(draft.buyPrice).toBeGreaterThanOrEqual(9000);
    expect(draft.rentAmount).toBe(700);
    expect(draft.rentCadence).toBe('weekly');
  });
});

describe('leasing: recurring rent, overdue warnings, eviction', () => {
  beforeEach(() => resetDb());

  it('pays the first period up front and charges due rent at day-advance (idempotent)', () => {
    const world = richWorld(5_000);
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 9000, rentAmount: 70, rentCadence: 'weekly' });
    const start = moneyOf(world.id);

    const lease = leaseProperty(world.id, prop.id); // first period up front
    expect(lease.money).toBe(start - 70);
    expect(lease.lease.nextDueDay).toBe(1 + 7); // current day 1 + weekly

    const r = runDailyWealth(world.id, 8, []); // rent comes due on day 8
    expect(r.rentPaid).toBe(70);
    expect(moneyOf(world.id)).toBe(start - 140);
    // Re-running the same day is a no-op (the day's rent guard already stamped).
    expect(runDailyWealth(world.id, 8, []).rentPaid).toBe(0);
    expect(moneyOf(world.id)).toBe(start - 140);
  });

  it('an unaffordable payment goes overdue (landlord text + grace), then evicts if still unpaid', () => {
    const world = richWorld(250); // fund the wallet (no free starting money)
    const playerId = playerIdForWorld(world.id);
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 9000, rentAmount: 70, rentCadence: 'weekly' });
    leaseProperty(world.id, prop.id); // -70 → 180
    spendMoney(150, playerId); // 30 left — can't afford the next 70

    runDailyWealth(world.id, 8, []); // due, unaffordable → overdue
    const lease = propertyLeasesRepo.getByPlayerAndProperty(world.id, playerId, prop.id)!;
    expect(lease.status).toBe('overdue');
    expect(lease.graceUntilDay).toBe(8 + 3);
    const notices = landlordNoticesRepo.listByPlayer(world.id, playerId);
    expect(notices.some((n) => n.kind === 'overdue')).toBe(true);

    runDailyWealth(world.id, 11, []); // grace elapsed, still broke → EVICTION
    expect(propertyLeasesRepo.getByPlayerAndProperty(world.id, playerId, prop.id)).toBeUndefined();
    expect(propertyVenueInfo(`prop:${prop.id}`, world.id)).toBeNull(); // lost the ability to date there
    expect(landlordNoticesRepo.listByPlayer(world.id, playerId).some((n) => n.kind === 'eviction')).toBe(true);
  });

  it('paying rent before the deadline clears the overdue state', () => {
    const world = richWorld(250);
    const playerId = playerIdForWorld(world.id);
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 9000, rentAmount: 70, rentCadence: 'weekly' });
    leaseProperty(world.id, prop.id);
    spendMoney(150, playerId); // can't afford the next charge
    runDailyWealth(world.id, 8, []); // → overdue
    expect(propertyLeasesRepo.getByPlayerAndProperty(world.id, playerId, prop.id)!.status).toBe('overdue');

    addMoney(200, playerId);
    const paid = payRent(world.id, prop.id); // manual catch-up
    expect(paid.lease.status).toBe('active');
    expect(paid.lease.graceUntilDay).toBeNull();
  });

  it('ending a lease (move out) removes the ability to date there', () => {
    const world = richWorld(5_000);
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 9000, rentAmount: 70, rentCadence: 'weekly' });
    leaseProperty(world.id, prop.id);
    expect(propertyVenueInfo(`prop:${prop.id}`, world.id)).toMatchObject({ owned: false });
    endLease(world.id, prop.id);
    expect(propertyVenueInfo(`prop:${prop.id}`, world.id)).toBeNull();
  });

  it('does not charge rent when the property feature is off', () => {
    const world = createWorld({ name: 'No Prop', featureFlags: { property: false, stockMarket: false } });
    ensureWorldState(world.id);
    expect(runDailyWealth(world.id, 2, []).rentPaid).toBe(0);
  });

  it('rejects paying rent that is not due (no money drain on repeat clicks)', () => {
    const world = richWorld(5_000);
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 9000, rentAmount: 70, rentCadence: 'weekly' });
    leaseProperty(world.id, prop.id); // day 1, next due day 8, status active
    const afterLease = moneyOf(world.id);
    // Not overdue and not yet due → paying is refused, wallet untouched.
    expect(() => payRent(world.id, prop.id)).toThrow(/due yet/i);
    expect(moneyOf(world.id)).toBe(afterLease);
  });

  it('catches up every elapsed rent period (a multi-period gap is not forgiven)', () => {
    const world = richWorld(5_000);
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 9000, rentAmount: 70, rentCadence: 'weekly' });
    leaseProperty(world.id, prop.id); // day 1, due day 8 (and 15)
    const afterLease = moneyOf(world.id);
    // Jump straight to day 16 (e.g. the feature was toggled off then on) — BOTH the
    // day-8 and day-15 periods come due and must be charged, not collapsed into one.
    const r = runDailyWealth(world.id, 16, []);
    expect(r.rentPaid).toBe(140); // 2 periods
    expect(moneyOf(world.id)).toBe(afterLease - 140);
  });

  it('grace-period recovery still bills EVERY overdue period (a multi-period gap is not forgiven)', () => {
    // Regression: when an overdue lease was paid at its grace deadline, the code
    // charged ONE period and reset nextDueDay to newDay+days, silently forgiving every
    // other period that had come due while overdue.
    const world = richWorld(250);
    const playerId = playerIdForWorld(world.id);
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 9000, rentAmount: 70, rentCadence: 'weekly' });
    leaseProperty(world.id, prop.id); // day 1, due day 8; wallet 250 - 70 = 180
    spendMoney(150, playerId); // 30 left → can't afford the day-8 charge

    runDailyWealth(world.id, 8, []); // due, unaffordable → overdue (grace until day 11)
    expect(propertyLeasesRepo.getByPlayerAndProperty(world.id, playerId, prop.id)!.status).toBe('overdue');

    addMoney(2_000, playerId); // now flush
    // Jump to day 30 (e.g. the property feature was toggled off then on): the periods
    // due on days 8, 15, 22, and 29 must ALL be charged, not collapsed into one.
    const r = runDailyWealth(world.id, 30, []);
    expect(r.rentPaid).toBe(280); // 4 periods
    const lease = propertyLeasesRepo.getByPlayerAndProperty(world.id, playerId, prop.id)!;
    expect(lease.status).toBe('active');
    expect(lease.nextDueDay).toBe(36); // 8 + 4 * 7, anchored to the schedule
  });

  it('a disabled property feature stops an owned property from acting as a free/buffed venue', () => {
    const world = richWorld();
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 4000, buffStat: 'comfort', buffAmount: 3 });
    buyProperty(world.id, prop.id);
    expect(propertyVenueInfo(`prop:${prop.id}`, world.id)).toMatchObject({ owned: true });
    // Creator disables the feature; the stale ownership row no longer yields a venue.
    updateWorld(world.id, { featureFlags: { property: false, stockMarket: true } });
    expect(propertyVenueInfo(`prop:${prop.id}`, world.id)).toBeNull();
  });

  it('blocks zeroing the rent of a property that is actively leased', () => {
    const world = richWorld(5_000);
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 9000, rentAmount: 70, rentCadence: 'weekly' });
    leaseProperty(world.id, prop.id);
    expect(() => updateProperty(prop.id, { rentAmount: 0 })).toThrow(/active lease/i);
  });
});

describe('stock market', () => {
  beforeEach(() => resetDb());

  it('rolls a deterministic, reproducible price at day-advance', () => {
    const world = richWorld();
    const co = createCompany({ worldId: world.id, name: 'Acme', ticker: 'ACM', basePrice: 100, volatility: 0.05 });

    runDailyWealth(world.id, 2, []);
    const expected = stockDailyStep(100, hashFloat(`stock|${world.id}|2|${co.id}`), 0.05, 0).price;
    expect(priceFor(world.id, getCompany(co.id), 2)).toBe(expected);

    runDailyWealth(world.id, 2, []);
    expect(priceFor(world.id, getCompany(co.id), 2)).toBe(expected);
  });

  it('buy/sell tracks cost basis and pays proceeds at the current price', () => {
    const world = richWorld(100_000);
    const co = createCompany({ worldId: world.id, name: 'Acme', ticker: 'ACM', basePrice: 100, volatility: 0 });
    const before = moneyOf(world.id);

    const buy = buyStock(world.id, co.id, 10);
    expect(buy.holding?.shares).toBe(10);
    expect(buy.holding?.costBasis).toBe(1000);
    expect(moneyOf(world.id)).toBe(before - 1000);

    const sell = sellStock(world.id, co.id, 4);
    expect(sell.holding?.shares).toBe(6);
    expect(sell.holding?.costBasis).toBe(600);
    expect(moneyOf(world.id)).toBe(before - 1000 + 400);

    expect(() => sellStock(world.id, co.id, 99)).toThrow(/do not own/);
  });

  it('pays a capped dividend only after shares are held across a full day (no same-day collect)', () => {
    const world = richWorld(100_000);
    const co = createCompany({ worldId: world.id, name: 'Div Co', ticker: 'DIV', basePrice: 1000, volatility: 0, dividendPerShare: 5 });
    buyStock(world.id, co.id, 10); // acquired on day 1
    const after = moneyOf(world.id);

    // First morning: too fresh (you can't buy-before-Sleep to collect free).
    expect(runDailyWealth(world.id, 2, []).dividends).toBe(0);
    expect(moneyOf(world.id)).toBe(after);
    // Held across a full day → the dividend pays.
    expect(runDailyWealth(world.id, 3, []).dividends).toBe(50);
    expect(moneyOf(world.id)).toBe(after + 50);
  });

  it('generation caps the dividend to a small yield of base price', () => {
    const draft = boundGeneratedCompany(
      { name: 'Greedy', ticker: 'grd!!', description: 'x', sector: 'tech', basePrice: 100, volatility: 9, dividendPerShare: 999 },
      'w1',
    );
    expect(draft.dividendPerShare).toBe(maxDividendForPrice(100));
    expect(draft.ticker).toBe('GRD');
    expect(draft.volatility).toBeLessThanOrEqual(0.15);
  });
});

describe('feature gating + net worth', () => {
  beforeEach(() => resetDb());

  it('requireFeature throws 403 when the mechanic is off', () => {
    const world = createWorld({ name: 'Plain', featureFlags: { property: false, stockMarket: false } });
    try {
      requireFeature(world.id, 'stockMarket');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(403);
    }
    const on = createWorld({ name: 'On', featureFlags: { property: true, stockMarket: true } });
    expect(() => requireFeature(on.id, 'property')).not.toThrow();
  });

  it('net worth = cash + property equity + stock value', () => {
    const world = richWorld(50_000);
    const prop = createProperty({ worldId: world.id, name: 'Loft', buyPrice: 6000 });
    const co = createCompany({ worldId: world.id, name: 'Acme', ticker: 'ACM', basePrice: 100, volatility: 0 });
    buyProperty(world.id, prop.id);
    buyStock(world.id, co.id, 10);

    const nw = netWorth(world.id);
    expect(nw.property).toBe(6000);
    expect(nw.stocks).toBe(1000);
    expect(nw.cash).toBe(moneyOf(world.id));
    expect(nw.total).toBe(nw.cash + nw.property + nw.stocks);
  });
});
