import {
  CompanySchema,
  StockHoldingSchema,
  StockSectorSchema,
  MarketNewsSchema,
  MarketNewsGenSchema,
  CompanyGenerationSchema,
  GenerateCompaniesInputSchema,
  STOCK_GEN,
  maxDividendForPrice,
  holdingValue,
  holdingPnL,
  type Company,
  type CompanyCreate,
  type CompanyUpdate,
  type StockHolding,
  type GeneratedCompany,
  type GenerateCompaniesParsed,
  type MarketView,
  type MarketCompanyView,
  type PortfolioView,
  type TradeStockResponse,
  type StructuredResult,
} from '@dsim/shared';
import { getDb } from '../db/index';
import { worldsRepo, companiesRepo, stockHoldingsRepo, stockPricesRepo, marketNewsRepo, worldStatesRepo } from '../db/repositories';
import { newId, playerIdForWorld } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';
import { addMoney, getOrCreatePlayer, spendMoney } from './player-service';
import { recordEvent } from './event-service';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import { buildCompanyGenMessages, buildMarketNewsMessages } from '../prompt/prompt-builder';

// --- authoring CRUD ---------------------------------------------------------

export function listCompanies(worldId: string): Company[] {
  return companiesRepo.listByWorld(worldId);
}

export function getCompany(id: string): Company {
  const c = companiesRepo.get(id);
  if (!c) throw notFound(`Company ${id} not found.`);
  return c;
}

/** Normalize a ticker to A–Z, 1–5 chars; fall back to the name's initials. */
export function normalizeTicker(raw: string, name = ''): string {
  let t = (raw ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, STOCK_GEN.MAX_TICKER_LEN);
  if (!t) {
    t = name
      .toUpperCase()
      .replace(/[^A-Z ]/g, '')
      .split(/\s+/)
      .map((w) => w[0] ?? '')
      .join('')
      .slice(0, STOCK_GEN.MAX_TICKER_LEN);
  }
  return t || 'CO';
}

export function createCompany(input: CompanyCreate): Company {
  const now = Date.now();
  const company = CompanySchema.parse({
    ...input,
    ticker: normalizeTicker(input.ticker ?? '', input.name),
    id: newId('co'),
    createdAt: now,
    updatedAt: now,
  });
  return companiesRepo.insert(company);
}

export function updateCompany(id: string, patch: CompanyUpdate): Company {
  const current = getCompany(id);
  const merged = { ...current, ...patch, id: current.id, worldId: current.worldId, updatedAt: Date.now() };
  if (patch.ticker !== undefined) merged.ticker = normalizeTicker(patch.ticker, merged.name);
  return companiesRepo.update(CompanySchema.parse(merged));
}

export function deleteCompany(id: string): void {
  getCompany(id);
  companiesRepo.delete(id); // ON DELETE CASCADE clears holdings + prices
}

// --- prices -----------------------------------------------------------------

/**
 * The share price of a company on a given in-world day. Reads the derived
 * `stock_prices` row for that day; if absent (a company added before the day was
 * rolled, or day 1), falls back to the latest prior price, else the base price.
 * READ-ONLY — price movement happens only at day-advance (wealth-service).
 */
export function priceFor(worldId: string, company: Company, day: number): number {
  const exact = stockPricesRepo.getForDay(worldId, company.id, day);
  if (exact) return exact.price;
  const prior = stockPricesRepo.latestUpTo(worldId, company.id, day);
  return prior?.price ?? company.basePrice;
}

function currentDay(worldId: string): number {
  return worldStatesRepo.get(worldId)?.day ?? 1;
}

// --- player trading ---------------------------------------------------------

export function buyStock(worldId: string, companyId: string, shares: number): TradeStockResponse {
  if (!Number.isInteger(shares) || shares <= 0) throw badRequest('Shares must be a positive integer.');
  const company = getCompany(companyId);
  if (company.worldId !== worldId) throw notFound(`Company ${companyId} not found in this world.`);
  const playerId = playerIdForWorld(worldId);
  const price = priceFor(worldId, company, currentDay(worldId));
  const cost = price * shares;
  return getDb().transaction<TradeStockResponse>(() => {
    const player = spendMoney(cost, playerId); // throws on insufficient funds
    const existing = stockHoldingsRepo.getPosition(worldId, playerId, companyId);
    const holding = stockHoldingsRepo.upsert(
      StockHoldingSchema.parse({
        id: existing?.id ?? newId('hold'),
        worldId,
        playerId,
        companyId,
        shares: (existing?.shares ?? 0) + shares,
        costBasis: (existing?.costBasis ?? 0) + cost,
        // Adding shares resets the dividend clock (you must hold a full day to earn).
        acquiredDay: currentDay(worldId),
        updatedAt: Date.now(),
      }),
    );
    recordEvent('stock_purchase', { worldId, playerId, companyId, ticker: company.ticker, shares, price, cost });
    return { holding, money: player.money, price };
  });
}

export function sellStock(worldId: string, companyId: string, shares: number): TradeStockResponse {
  if (!Number.isInteger(shares) || shares <= 0) throw badRequest('Shares must be a positive integer.');
  const company = getCompany(companyId);
  const playerId = playerIdForWorld(worldId);
  const existing = stockHoldingsRepo.getPosition(worldId, playerId, companyId);
  if (!existing || existing.shares < shares) throw badRequest('You do not own that many shares.');
  const price = priceFor(worldId, company, currentDay(worldId));
  const proceeds = price * shares;
  return getDb().transaction<TradeStockResponse>(() => {
    const player = addMoney(proceeds, playerId);
    const remaining = existing.shares - shares;
    // Reduce cost basis proportionally so the remaining P/L stays honest.
    const remainingBasis = remaining > 0 ? Math.round(existing.costBasis * (remaining / existing.shares)) : 0;
    let holding: StockHolding | null = null;
    if (remaining > 0) {
      holding = stockHoldingsRepo.upsert(
        StockHoldingSchema.parse({ ...existing, shares: remaining, costBasis: remainingBasis, updatedAt: Date.now() }),
      );
    } else {
      stockHoldingsRepo.delete(worldId, playerId, companyId);
    }
    recordEvent('stock_sale', { worldId, playerId, companyId, ticker: company.ticker, shares, price, proceeds });
    return { holding, money: player.money, price };
  });
}

// --- player read surfaces ---------------------------------------------------

export function marketView(worldId: string): MarketView {
  const playerId = playerIdForWorld(worldId);
  const day = currentDay(worldId);
  const companies = companiesRepo.listByWorld(worldId);
  const views: MarketCompanyView[] = companies.map((company) => {
    const price = priceFor(worldId, company, day);
    const prevPrice = day > 1 ? priceFor(worldId, company, day - 1) : company.basePrice;
    const holding = stockHoldingsRepo.getPosition(worldId, playerId, company.id);
    return {
      company,
      price,
      prevPrice,
      pct: prevPrice > 0 ? (price - prevPrice) / prevPrice : 0,
      shares: holding?.shares ?? 0,
      costBasis: holding?.costBasis ?? 0,
    };
  });
  return { companies: views, news: marketNewsRepo.listRecent(worldId, 12) };
}

export function portfolioView(worldId: string): PortfolioView {
  const playerId = playerIdForWorld(worldId);
  const day = currentDay(worldId);
  const positions = stockHoldingsRepo
    .listByPlayer(worldId, playerId)
    .map((h) => {
      const company = companiesRepo.get(h.companyId);
      if (!company) return null;
      const price = priceFor(worldId, company, day);
      return {
        company,
        shares: h.shares,
        price,
        value: holdingValue(h.shares, price),
        costBasis: h.costBasis,
        pnl: holdingPnL(h.shares, price, h.costBasis),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p != null);
  const value = positions.reduce((sum, p) => sum + p.value, 0);
  return { positions, value, cash: getOrCreatePlayer(playerId).money };
}

/** Total mark-to-market value of all holdings (for net worth). */
export function stockHoldingsValue(worldId: string): number {
  const playerId = playerIdForWorld(worldId);
  const day = currentDay(worldId);
  return stockHoldingsRepo.listByPlayer(worldId, playerId).reduce((sum, h) => {
    const company = companiesRepo.get(h.companyId);
    return company ? sum + holdingValue(h.shares, priceFor(worldId, company, day)) : sum;
  }, 0);
}

// --- LLM company generation (creator tool) ----------------------------------

const clampInt = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : lo)));

/** SERVER-OWNS-RULES: bound an LLM-proposed company. Caps the dividend to a small
 *  yield of the base price so a holding can never out-earn its own cost. */
export function boundGeneratedCompany(g: GeneratedCompany, worldId: string): CompanyCreate {
  const sector = StockSectorSchema.catch('tech').parse(g.sector);
  const basePrice = clampInt(g.basePrice, STOCK_GEN.MIN_PRICE, STOCK_GEN.MAX_PRICE);
  const volatility = Math.max(0, Math.min(STOCK_GEN.MAX_VOLATILITY, Number.isFinite(g.volatility) ? g.volatility : 0.04));
  const dividendPerShare = clampInt(g.dividendPerShare, 0, maxDividendForPrice(basePrice));
  return {
    worldId,
    name: g.name.slice(0, STOCK_GEN.MAX_NAME),
    ticker: normalizeTicker(g.ticker, g.name),
    description: g.description.slice(0, STOCK_GEN.MAX_DESCRIPTION),
    sector,
    basePrice,
    volatility,
    dividendPerShare,
    linkedCharacterId: null,
    assetId: null,
  };
}

export async function generateCompanies(
  input: GenerateCompaniesParsed,
  worldId: string,
): Promise<StructuredResult<CompanyCreate[]>> {
  const data = GenerateCompaniesInputSchema.parse(input);
  const settings = getLlmSettings();
  const result = await callStructuredLlm(CompanyGenerationSchema, buildCompanyGenMessages(data), {
    settings,
    task: 'Generate a batch of in-world fictional companies for a stock market (name, ticker, sector, base price, volatility, dividend).',
    schemaName: 'CompanyGeneration',
  });
  if (!result.ok) {
    return { ok: false, error: result.error, attempts: result.attempts, lastRaw: result.lastRaw };
  }
  const drafts = result.data.companies.map((g) => boundGeneratedCompany(g, worldId));
  return { ok: true, data: drafts, attempts: result.attempts };
}

/**
 * Best-effort LLM "market news" for the day's biggest movers — pure FLAVOR that
 * explains the deterministic price moves (it never changes a price). Idempotent
 * per (world, day) and feature-gated. Called fire-and-forget at day start.
 */
export async function generateMarketNews(worldId: string, day: number): Promise<void> {
  const world = worldsRepo.get(worldId);
  if (!world?.featureFlags.stockMarket) return;
  if (marketNewsRepo.existsForDay(worldId, day)) return; // already written for this day
  const companies = companiesRepo.listByWorld(worldId);
  if (companies.length === 0) return;

  const movers = companies
    .map((company) => {
      const price = priceFor(worldId, company, day);
      const prev = day > 1 ? priceFor(worldId, company, day - 1) : company.basePrice;
      const pct = prev > 0 ? (price - prev) / prev : 0;
      return { company, price, pct };
    })
    .filter((m) => Math.abs(m.pct) >= 0.02)
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, 4);
  if (movers.length === 0) return; // a calm day needs no news

  const items = movers.map((m) => ({
    ref: m.company.ticker,
    fact: `${m.company.name} (${m.company.ticker}, ${m.company.sector}) ${m.pct >= 0 ? 'rose' : 'fell'} ${Math.abs(Math.round(m.pct * 100))}% to ${m.price}`,
  }));
  const settings = getLlmSettings();
  const result = await callStructuredLlm(MarketNewsGenSchema, buildMarketNewsMessages({ worldName: world.name, items }), {
    settings,
    task: 'Write brief market-news headlines for the day’s biggest stock movers.',
    schemaName: 'MarketNewsGen',
  });
  if (!result.ok) return; // best-effort: no headlines on failure, prices stand

  const byTicker = new Map(movers.map((m) => [m.company.ticker.toUpperCase(), m]));
  const now = Date.now();
  for (const line of result.data.items) {
    const m = byTicker.get(line.ref.toUpperCase());
    if (!m) continue; // the model can only narrate movers we actually sent
    marketNewsRepo.insert(
      MarketNewsSchema.parse({
        id: newId('news'),
        worldId,
        day,
        companyId: m.company.id,
        ticker: m.company.ticker,
        headline: line.headline,
        body: line.body,
        sentiment: m.pct >= 0.005 ? 'up' : m.pct <= -0.005 ? 'down' : 'flat',
        createdAt: now,
      }),
    );
  }
}

/** Copy a world's authored company DEFINITIONS into another world (world clone).
 *  Character links are dropped (their ids don't carry across a clone). */
export function cloneCompaniesToWorld(sourceWorldId: string, destWorldId: string): void {
  for (const c of companiesRepo.listByWorld(sourceWorldId)) {
    createCompany({
      worldId: destWorldId,
      name: c.name,
      ticker: c.ticker,
      description: c.description,
      sector: c.sector,
      basePrice: c.basePrice,
      volatility: c.volatility,
      dividendPerShare: c.dividendPerShare,
      linkedCharacterId: null,
      assetId: c.assetId,
    });
  }
}
