import {
  WorldStateSchema,
  StockPriceSchema,
  PropertyLeaseSchema,
  WEALTH,
  stockDailyStep,
  netWorthBreakdown,
  rentCadenceDays,
  type Company,
  type PropertyLease,
  type GameEvent,
  type WealthSummary,
} from '@dsim/shared';
import {
  worldsRepo,
  worldStatesRepo,
  propertiesRepo,
  propertyLeasesRepo,
  companiesRepo,
  stockHoldingsRepo,
  stockPricesRepo,
} from '../db/repositories';
import { getDb } from '../db/index';
import { hashFloat } from '../lib/seeded-random';
import { playerIdForWorld } from '../lib/ids';
import { addMoney, getOrCreatePlayer, spendMoney } from './player-service';
import { recordEvent } from './event-service';
import { ownedPropertyValue } from './property-service';
import { stockHoldingsValue } from './market-service';
import { sendLandlordNotice } from './landlord-notice-service';

/**
 * The wealth day-advance engine + net-worth aggregation. All price movement and
 * rent/dividend income is DETERMINISTIC (seeded per world+day) and IDEMPOTENT
 * (guarded by world_states.lastRent/lastStockCalculatedDay) — re-advancing a day
 * never double-credits, and the same (world, day) always yields the same prices.
 * Gated per-world by featureFlags: a world with the mechanic off does nothing.
 */

/** Discrete relationship beats that move a character-linked stock (yesterday's news). */
const GOOD_EVENTS = new Set(['milestone_reached', 'dtr_accepted', 'reconciled', 'ending_reached']);
const BAD_EVENTS = new Set(['breakup', 'walkout', 'jealousy_triggered', 'dtr_backfired', 'relationship_on_the_rocks', 'date_left']);

/** A bounded price shock from the prior day's events touching this company's linked
 *  character — the deterministic core of "the market reacts to the world". */
function eventShockFor(company: Company, events: GameEvent[]): number {
  if (!company.linkedCharacterId || events.length === 0) return 0;
  let shock = 0;
  for (const e of events) {
    if ((e.payload as Record<string, unknown>).characterId !== company.linkedCharacterId) continue;
    if (GOOD_EVENTS.has(e.type)) shock += 0.05;
    else if (BAD_EVENTS.has(e.type)) shock -= 0.07;
  }
  return Math.max(-WEALTH.STOCK_EVENT_SHOCK_MAX, Math.min(WEALTH.STOCK_EVENT_SHOCK_MAX, shock));
}

export interface DailyWealthResult {
  /** Lease rent the player PAID this day (an expense; not added to income). */
  rentPaid: number;
  /** Stock dividends CREDITED this day (income). */
  dividends: number;
}

/**
 * Charge due lease rent (evicting on default), roll stock prices forward, and pay
 * dividends for a world as it enters `newDay`. `endedDayEvents` are the just-ended
 * day's events (yesterday's news) for the deterministic stock event-shock. Idempotent
 * + feature-gated.
 */
export function runDailyWealth(
  worldId: string,
  newDay: number,
  endedDayEvents: GameEvent[],
): DailyWealthResult {
  const world = worldsRepo.get(worldId);
  const state = worldStatesRepo.get(worldId);
  if (!world || !state) return { rentPaid: 0, dividends: 0 };

  // All payouts + the idempotency stamp are ONE atomic unit, so a mid-run failure
  // rolls back cleanly (no money debited/credited without the day's marker advancing,
  // which would otherwise double-pay on the next Sleep).
  return getDb().transaction<DailyWealthResult>(() => {
  const playerId = playerIdForWorld(worldId);
  let rentPaid = 0;
  let dividends = 0;

  // --- Lease rent (an EXPENSE): charge due leases, warn + evict on default ---
  if (world.featureFlags.property && state.lastRentCalculatedDay < newDay) {
    rentPaid = chargeDueLeases(worldId, playerId, newDay);
  }

  // --- Stock prices (deterministic walk + event shock) + dividends ---
  if (world.featureFlags.stockMarket && state.lastStockCalculatedDay < newDay) {
    const companies = companiesRepo.listByWorld(worldId);
    const movers: Array<{ ticker: string; pct: number }> = [];
    const now = Date.now();
    for (const company of companies) {
      const prior = stockPricesRepo.latestUpTo(worldId, company.id, newDay - 1);
      const prevPrice = prior?.price ?? company.basePrice;
      const roll = hashFloat(`stock|${worldId}|${newDay}|${company.id}`);
      const shock = eventShockFor(company, endedDayEvents);
      const { price, pct } = stockDailyStep(prevPrice, roll, company.volatility, shock);
      stockPricesRepo.upsert(StockPriceSchema.parse({ worldId, companyId: company.id, day: newDay, price, createdAt: now }));
      movers.push({ ticker: company.ticker, pct });
    }
    if (movers.length > 0) {
      const top = [...movers].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 3);
      recordEvent('stock_market_moved', {
        worldId,
        day: newDay,
        movers: top.map((m) => ({ ticker: m.ticker, pct: Math.round(m.pct * 1000) / 1000 })),
      });
    }
    // Dividends on held shares (capped per-company at generation/save time). Only
    // shares HELD across a full day earn — a holding acquired on/after the day that
    // just ended (newDay-1) is too fresh, so you can't buy-before-Sleep to collect
    // a risk-free dividend on a low-volatility stock.
    for (const h of stockHoldingsRepo.listByPlayer(worldId, playerId)) {
      const company = companiesRepo.get(h.companyId);
      if (!company || company.dividendPerShare <= 0) continue;
      if (h.acquiredDay >= newDay - 1) continue; // bought too recently to earn this dividend
      const payout = company.dividendPerShare * h.shares;
      if (payout <= 0) continue;
      addMoney(payout, playerId);
      dividends += payout;
      recordEvent('dividend_paid', { worldId, day: newDay, companyId: company.id, ticker: company.ticker, amount: payout, shares: h.shares });
    }
  }

  // Stamp idempotency markers (re-read fresh, mirroring world-sim markSimmed).
  const fresh = worldStatesRepo.get(worldId);
  if (fresh) {
    let changed = false;
    const patch = { ...fresh };
    if (world.featureFlags.property && fresh.lastRentCalculatedDay < newDay) {
      patch.lastRentCalculatedDay = newDay;
      changed = true;
    }
    if (world.featureFlags.stockMarket && fresh.lastStockCalculatedDay < newDay) {
      patch.lastStockCalculatedDay = newDay;
      changed = true;
    }
    if (changed) worldStatesRepo.update(WorldStateSchema.parse({ ...patch, updatedAt: Date.now() }));
  }

  return { rentPaid, dividends };
  });
}

/** Charge the player's affordable amount, returning whether the charge went through. */
function tryPay(amount: number, playerId: string): boolean {
  if (amount <= 0) return true;
  if (getOrCreatePlayer(playerId).money < amount) return false;
  try {
    spendMoney(amount, playerId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk the player's active leases as the world enters `newDay`: charge any due rent;
 * a missed payment flips the lease to `overdue` (a grace clock + an urgent landlord
 * text); rent still unpaid past the grace deadline ends the lease (EVICTION). Returns
 * the total rent successfully paid. Synchronous + deterministic.
 */
function chargeDueLeases(worldId: string, playerId: string, newDay: number): number {
  let paid = 0;
  for (const lease of propertyLeasesRepo.listByPlayer(worldId, playerId)) {
    const property = propertiesRepo.get(lease.propertyId);
    if (!property) {
      propertyLeasesRepo.delete(worldId, playerId, lease.propertyId); // authored property removed
      continue;
    }
    const days = rentCadenceDays(property.rentCadence);
    let cur: PropertyLease = lease;
    let guard = 0;

    // 1. A lease left overdue on a PRIOR tick whose grace deadline has now passed is
    //    at its last chance: pay the oldest overdue period (recover) or be EVICTED.
    //    Recovery advances the schedule by exactly ONE period (NOT to newDay), so any
    //    further periods that fell due while overdue are still billed by the catch-up
    //    loop below — previously this reset nextDueDay to newDay+days and silently
    //    forgave every overdue period but one.
    if (cur.status === 'overdue' && cur.graceUntilDay != null && newDay >= cur.graceUntilDay) {
      if (!tryPay(property.rentAmount, playerId)) {
        propertyLeasesRepo.delete(worldId, playerId, property.id);
        sendLandlordNotice({ worldId, playerId, propertyId: property.id, propertyName: property.name, kind: 'eviction', amount: property.rentAmount, graceDay: cur.graceUntilDay, day: newDay });
        recordEvent('property_evicted', { worldId, playerId, propertyId: property.id, name: property.name });
        continue;
      }
      cur = propertyLeasesRepo.upsert(
        PropertyLeaseSchema.parse({ ...cur, nextDueDay: cur.nextDueDay + days, status: 'active', graceUntilDay: null }),
      );
      paid += property.rentAmount;
      recordEvent('rent_paid', { worldId, playerId, propertyId: property.id, name: property.name, amount: property.rentAmount });
    }

    // 2. Catch up EVERY period that has come due, anchored to the schedule (so an
    //    N-period gap — a multi-day jump, or a lease that just recovered above — costs
    //    N payments, never collapsing into a single forgiven charge). Stops at the
    //    first unaffordable period, flipping the lease to overdue + a grace clock + one
    //    landlord text. Bounded against a pathological gap.
    while (cur.status === 'active' && newDay >= cur.nextDueDay && guard++ < 512) {
      if (tryPay(property.rentAmount, playerId)) {
        cur = propertyLeasesRepo.upsert(
          PropertyLeaseSchema.parse({ ...cur, nextDueDay: cur.nextDueDay + days, status: 'active', graceUntilDay: null }),
        );
        paid += property.rentAmount;
        recordEvent('rent_paid', { worldId, playerId, propertyId: property.id, name: property.name, amount: property.rentAmount });
      } else {
        const graceDay = newDay + WEALTH.RENT_GRACE_DAYS;
        cur = propertyLeasesRepo.upsert(PropertyLeaseSchema.parse({ ...cur, status: 'overdue', graceUntilDay: graceDay }));
        sendLandlordNotice({ worldId, playerId, propertyId: property.id, propertyName: property.name, kind: 'overdue', amount: property.rentAmount, graceDay, day: newDay });
        recordEvent('rent_overdue', { worldId, playerId, propertyId: property.id, name: property.name, amount: property.rentAmount, graceDay });
      }
    }
  }
  return paid;
}

/** The HUD net-worth readout: cash + property equity + stock value. */
export function netWorth(worldId: string): WealthSummary {
  const playerId = playerIdForWorld(worldId);
  const cash = getOrCreatePlayer(playerId).money;
  return netWorthBreakdown(cash, ownedPropertyValue(worldId), stockHoldingsValue(worldId));
}
