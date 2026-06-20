import { z } from 'zod';
import { type RelationshipStatKey } from './stats';
import { WEALTH } from './constants';

/**
 * Wealth-management domain primitives: property + the per-world stock market.
 *
 * These are the canonical vocabularies (mirroring {@link CharacterLinkKindSchema}
 * in social.ts) plus the pure, deterministic, server-owned math for stock prices,
 * rented-vs-owned date buffs, and net-worth aggregation. No persistence and no
 * LLM live here — those are in the server services. Keeping the math here means
 * both the server (authority) and the web (display/preview) compute it identically.
 */

// --- Property categories ----------------------------------------------------

/** What KIND of place a property is. Fixed enum (off-list LLM values coerce to
 *  'residence'); purely cosmetic + a grouping handle in the editor. */
export const PropertyCategorySchema = z.enum(['residence', 'retreat', 'social', 'estate', 'land']);
export type PropertyCategory = z.infer<typeof PropertyCategorySchema>;

export const PROPERTY_CATEGORY_LABELS: Record<PropertyCategory, string> = {
  residence: 'Residence',
  retreat: 'Retreat',
  social: 'Social spot',
  estate: 'Estate',
  land: 'Land',
};

// --- Stock sectors ----------------------------------------------------------

/** The market sector a fictional company trades in. Fixed enum; flavor + grouping. */
export const StockSectorSchema = z.enum([
  'tech',
  'finance',
  'industry',
  'consumer',
  'energy',
  'media',
  'health',
  'realty',
]);
export type StockSector = z.infer<typeof StockSectorSchema>;

export const STOCK_SECTOR_LABELS: Record<StockSector, string> = {
  tech: 'Technology',
  finance: 'Finance',
  industry: 'Industry',
  consumer: 'Consumer',
  energy: 'Energy',
  media: 'Media',
  health: 'Health',
  realty: 'Real estate',
};

// --- Rent cadence (how often a lease charges) -------------------------------

/** How often a leased property charges rent. */
export const RentCadenceSchema = z.enum(['daily', 'weekly', 'monthly']);
export type RentCadence = z.infer<typeof RentCadenceSchema>;

export const RENT_CADENCE_LABELS: Record<RentCadence, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

/** Short adverb form for "rent ◈X /week" style readouts. */
export const RENT_CADENCE_PER: Record<RentCadence, string> = {
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
};

/** In-world days between rent charges. A season is 28 days = 4 weeks, so a
 *  "month" is 28 days and a "week" is 7 (see deriveCalendar). */
export function rentCadenceDays(cadence: RentCadence): number {
  switch (cadence) {
    case 'daily':
      return 1;
    case 'weekly':
      return 7;
    case 'monthly':
      return 28;
    default:
      return 7;
  }
}

// --- Property date buff ------------------------------------------------------

type Delta = Partial<Record<RelationshipStatKey, number>>;

/**
 * The relationship nudge dating at a property grants, filtered through whether you
 * OWN it (full authored buff) or merely RENTED it for the night (a fraction). Owned
 * is the premium tier — that's the whole "own your place" payoff. Returns a fresh
 * object; the stat-service clamp is the final authority on magnitude.
 */
export function propertyDateBuff(
  buffStat: RelationshipStatKey | null,
  buffAmount: number,
  owned: boolean,
): Delta {
  if (!buffStat || buffAmount <= 0) return {};
  const amount = owned ? buffAmount : rentedBuffAmount(buffAmount);
  if (amount <= 0) return {};
  return { [buffStat]: amount };
}

/** How much of an owned property's date buff a one-night RENTAL grants. */
export function rentedBuffAmount(fullBuff: number): number {
  return Math.max(0, Math.round(fullBuff * WEALTH.RENTED_BUFF_FRACTION));
}

// --- Stock price math (deterministic random walk + event shock) -------------

/**
 * One day's move for a stock. PURE + deterministic: the caller passes a uniform
 * roll in [0,1) (from the seeded per-(world,day,company) hash) and an optional
 * event shock (a bounded nudge derived from the prior day's world events), so the
 * same inputs always produce the same price. Never returns below STOCK_MIN_PRICE.
 *
 * `volatility` is the company's daily swing magnitude (e.g. 0.04 = ±4% walk).
 */
export function stockDailyStep(
  prevPrice: number,
  roll01: number,
  volatility: number,
  eventShock = 0,
): { price: number; pct: number } {
  const vol = clamp(volatility, 0, WEALTH.STOCK_MAX_VOLATILITY);
  const shock = clamp(eventShock, -WEALTH.STOCK_EVENT_SHOCK_MAX, WEALTH.STOCK_EVENT_SHOCK_MAX);
  const walk = (roll01 * 2 - 1) * vol; // [-vol, +vol)
  const delta = walk + shock;
  const next = Math.max(WEALTH.STOCK_MIN_PRICE, Math.round(prevPrice * (1 + delta)));
  const pct = prevPrice > 0 ? (next - prevPrice) / prevPrice : 0;
  return { price: next, pct };
}

/** Max dividend per share an authored/generated company may pay, given its base
 *  price — a small yield cap so a holding can never out-earn its own cost. */
export function maxDividendForPrice(basePrice: number): number {
  return Math.floor(Math.max(0, basePrice) * WEALTH.MAX_DIVIDEND_YIELD);
}

// --- Net worth aggregation --------------------------------------------------

/** A holding's mark-to-market value at a given price. */
export function holdingValue(shares: number, price: number): number {
  return Math.max(0, Math.round(shares * price));
}

/** Unrealized profit/loss of a holding vs. its cost basis. */
export function holdingPnL(shares: number, price: number, costBasis: number): number {
  return holdingValue(shares, price) - Math.max(0, costBasis);
}

export interface NetWorthBreakdown {
  cash: number;
  property: number;
  stocks: number;
  total: number;
}

/** Combine the three wealth lanes into a net-worth figure (server-computed on read). */
export function netWorthBreakdown(cash: number, propertyValue: number, stockValue: number): NetWorthBreakdown {
  const c = Math.max(0, Math.round(cash));
  const p = Math.max(0, Math.round(propertyValue));
  const s = Math.max(0, Math.round(stockValue));
  return { cash: c, property: p, stocks: s, total: c + p + s };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
