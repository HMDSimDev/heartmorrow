import { useEffect, useState } from 'react';
import {
  STOCK_SECTOR_LABELS,
  type Company,
  type CompanyCreate,
  type MarketCompanyView,
  type MarketNews,
  type PortfolioPosition,
  type StockSector,
} from '@dsim/shared';
import { api } from '../../lib/api';
import { useAsync, errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import { Banner, Empty, Field, Loader, ConfirmDialog } from '../ui';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import './phone-market.css';

const SECTORS: StockSector[] = ['tech', 'finance', 'industry', 'consumer', 'energy', 'media', 'health', 'realty'];

type Tab = 'market' | 'portfolio';

interface CompanyDraft {
  keep: boolean;
  company: CompanyCreate;
}

function fmtPct(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${(pct * 100).toFixed(1)}%`;
}

function pctClass(pct: number): string {
  return pct >= 0 ? 'mkt-up' : 'mkt-down';
}

function pnlClass(pnl: number): string {
  return pnl >= 0 ? 'mkt-up' : 'mkt-down';
}

/* ── Per-company trade row ─────────────────────────────────────────────── */
function CompanyRow({
  view,
  activeWorldId,
  tradingId,
  onTrade,
}: {
  view: MarketCompanyView;
  activeWorldId: string;
  tradingId: string | null;
  onTrade: (companyId: string, action: 'buy' | 'sell', shares: number) => void;
}) {
  const { company, price, pct, shares } = view;
  const [buyQty, setBuyQty] = useState(1);
  const [sellQty, setSellQty] = useState(1);
  // Keep the sell quantity in sync with holdings after a trade/reload — never strand
  // a stale-high value that would jump back up on a later buy-back.
  useEffect(() => {
    setSellQty((q) => Math.min(q, Math.max(1, shares)));
  }, [shares]);
  const busy = tradingId !== null;

  return (
    <div className="mkt-row card">
      <div className="mkt-row-head">
        <div className="mkt-ticker-block">
          <span className="mkt-ticker">{company.ticker}</span>
          <span className="mkt-sector-tag">{STOCK_SECTOR_LABELS[company.sector as StockSector] ?? company.sector}</span>
        </div>
        <div className="mkt-price-block">
          <span className="mkt-price">◈ {price}</span>
          <span className={`mkt-pct ${pctClass(pct)}`}>{fmtPct(pct)}</span>
        </div>
      </div>
      <div className="mkt-company-name">{company.name}</div>
      {company.description && <p className="mkt-desc">{company.description}</p>}
      <div className="mkt-row-meta">
        {company.dividendPerShare > 0 && (
          <span className="mkt-dividend">pays ◈{company.dividendPerShare}/day per share</span>
        )}
        {shares > 0 && (
          <span className="mkt-held">You hold {shares} share{shares !== 1 ? 's' : ''}</span>
        )}
      </div>
      <div className="mkt-trade-row">
        <div className="mkt-trade-group">
          <input
            className="mkt-qty-input"
            type="number"
            min={1}
            value={buyQty}
            onChange={(e) => setBuyQty(Math.max(1, Number(e.target.value) || 1))}
          />
          <button
            className="btn sm primary"
            disabled={busy}
            onClick={() => onTrade(company.id, 'buy', buyQty)}
          >
            {tradingId === company.id + '-buy' ? 'Buying…' : 'Buy'}
          </button>
        </div>
        {shares > 0 && (
          <div className="mkt-trade-group">
            <input
              className="mkt-qty-input"
              type="number"
              min={1}
              max={shares}
              value={Math.min(sellQty, shares)}
              onChange={(e) => setSellQty(Math.max(1, Math.min(shares, Number(e.target.value) || 1)))}
            />
            <button
              className="btn sm ghost"
              disabled={busy}
              onClick={() => onTrade(company.id, 'sell', Math.min(sellQty, shares))}
            >
              {tradingId === company.id + '-sell' ? 'Selling…' : 'Sell'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── News card ────────────────────────────────────────────────────────── */
function NewsCard({ item }: { item: MarketNews }) {
  return (
    <div className={`mkt-news-card mkt-sentiment-${item.sentiment}`}>
      <div className="mkt-news-ticker">{item.ticker ?? '—'}</div>
      <div className="mkt-news-headline">{item.headline}</div>
      {item.body && <p className="mkt-news-body">{item.body}</p>}
    </div>
  );
}

/* ── Portfolio position row ───────────────────────────────────────────── */
function PositionRow({ pos }: { pos: PortfolioPosition }) {
  return (
    <div className="mkt-pos-row">
      <div className="mkt-pos-head">
        <span className="mkt-ticker">{pos.company.ticker}</span>
        <span className="mkt-pos-shares">{pos.shares} sh</span>
        <span className="mkt-pos-value">◈ {pos.value}</span>
      </div>
      <div className="mkt-pos-detail">
        <span className="mkt-pos-basis">basis ◈ {pos.costBasis}</span>
        <span className={`mkt-pos-pnl ${pnlClass(pos.pnl)}`}>{pos.pnl >= 0 ? '+' : ''}◈ {pos.pnl}</span>
      </div>
    </div>
  );
}

/* ── Creator: draft editor for a generated company ───────────────────── */
function DraftCard({
  draft,
  index,
  onToggle,
  onEdit,
}: {
  draft: CompanyDraft;
  index: number;
  onToggle: (i: number) => void;
  onEdit: (i: number, patch: Partial<CompanyCreate>) => void;
}) {
  const { company, keep } = draft;
  return (
    <div className={`mkt-draft${keep ? '' : ' dropped'}`}>
      <div className="mkt-draft-top">
        <label className="mkt-draft-keep">
          <input type="checkbox" checked={keep} onChange={() => onToggle(index)} />
          {keep ? 'Keep' : 'Skipped'}
        </label>
        <span className="mkt-money-pill">◈ {company.basePrice}</span>
      </div>
      <div className="inline-fields">
        <Field label="Name">
          <input value={company.name} onChange={(e) => onEdit(index, { name: e.target.value })} />
        </Field>
        <Field label="Ticker">
          <input
            value={company.ticker}
            maxLength={6}
            onChange={(e) => onEdit(index, { ticker: e.target.value.toUpperCase() })}
          />
        </Field>
      </div>
      <div className="inline-fields">
        <Field label="Sector">
          <select
            value={company.sector}
            onChange={(e) => onEdit(index, { sector: e.target.value as StockSector })}
          >
            {SECTORS.map((s) => (
              <option key={s} value={s}>{STOCK_SECTOR_LABELS[s]}</option>
            ))}
          </select>
        </Field>
        <Field label="Base price (◈)">
          <input
            type="number"
            min={1}
            value={company.basePrice}
            onChange={(e) => onEdit(index, { basePrice: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Field>
      </div>
      <div className="inline-fields">
        <Field label="Volatility (0–0.15)">
          <input
            type="number"
            min={0}
            max={0.15}
            step={0.01}
            value={company.volatility}
            onChange={(e) => onEdit(index, { volatility: Math.max(0, Math.min(0.15, Number(e.target.value) || 0)) })}
          />
        </Field>
        <Field label="Dividend/share">
          <input
            type="number"
            min={0}
            value={company.dividendPerShare ?? 0}
            onChange={(e) => onEdit(index, { dividendPerShare: Math.max(0, Number(e.target.value) || 0) })}
          />
        </Field>
      </div>
      <Field label="Description">
        <textarea
          value={company.description ?? ''}
          onChange={(e) => onEdit(index, { description: e.target.value })}
        />
      </Field>
    </div>
  );
}

/* ── Main component ───────────────────────────────────────────────────── */
export function MarketApp() {
  const { player, reloadPlayer, creatorMode, activeWorld, activeWorldId, dayTick } = useAppData();

  const [tab, setTab] = useState<Tab>('market');
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();

  // Trade state
  const [tradingId, setTradingId] = useState<string | null>(null);

  // Creator: delete
  const [pendingDelete, setPendingDelete] = useState<Company | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Creator: generator panel
  const [genOpen, setGenOpen] = useState(false);
  const [genForm, setGenForm] = useState<{
    count: number;
    theme: string;
    sectorHint: '' | StockSector;
  }>({ count: 4, theme: '', sectorHint: '' });
  const [generating, setGenerating] = useState(false);
  const [drafts, setDrafts] = useState<CompanyDraft[]>([]);
  const [saving, setSaving] = useState(false);

  // Creator: manual new-company form
  const [newForm, setNewForm] = useState<Omit<CompanyCreate, 'worldId'>>({
    name: '',
    ticker: '',
    sector: 'tech',
    basePrice: 100,
    volatility: 0.04,
    dividendPerShare: 0,
    description: '',
    linkedCharacterId: null,
    assetId: null,
  });
  const [creatingNew, setCreatingNew] = useState(false);

  // Data loaders — only fire when we have a world. Keyed on dayTick so prices,
  // dividends, and news refetch after End day (the HUD net worth already does).
  const marketState = useAsync(
    () => (activeWorldId ? api.getMarket(activeWorldId) : Promise.reject(new Error('No world'))),
    [activeWorldId, dayTick],
  );
  const portfolioState = useAsync(
    () => (activeWorldId ? api.getPortfolio(activeWorldId) : Promise.reject(new Error('No world'))),
    [activeWorldId, dayTick],
  );

  if (!activeWorldId) {
    return (
      <div className="phone-app">
        <PhoneAppBar title="Market" kicker="Stock exchange" icon="coin" />
        <div className="mkt-scroll">
          <Empty icon={<Icon name="coin" size={34} />} title="No world active">
            <p className="muted">Select a world to view the market.</p>
          </Empty>
        </div>
      </div>
    );
  }

  /* ── Trade handlers ─────────────────────────────────────────────────── */
  const trade = async (companyId: string, action: 'buy' | 'sell', shares: number) => {
    if (tradingId) return;
    setTradingId(`${companyId}-${action}`);
    setNote(undefined);
    setError(undefined);
    try {
      const res =
        action === 'buy'
          ? await api.buyStock(activeWorldId, companyId, shares)
          : await api.sellStock(activeWorldId, companyId, shares);
      await reloadPlayer();
      marketState.reload();
      portfolioState.reload();
      setNote(`${action === 'buy' ? 'Bought' : 'Sold'} ${shares} share${shares !== 1 ? 's' : ''} @ ◈ ${res.price}.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setTradingId(null);
    }
  };

  /* ── Delete handler ─────────────────────────────────────────────────── */
  const removeCompany = async (company: Company) => {
    if (deleting) return;
    setDeleting(true);
    setError(undefined);
    try {
      await api.deleteCompany(company.id);
      marketState.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  /* ── Generator ──────────────────────────────────────────────────────── */
  const generate = async () => {
    setGenerating(true);
    setError(undefined);
    setNote(undefined);
    setDrafts([]);
    try {
      const res = await api.generateCompanies(activeWorldId, {
        count: genForm.count,
        theme: genForm.theme,
        sectorHint: genForm.sectorHint || undefined,
        world: activeWorld
          ? { name: activeWorld.name, summary: activeWorld.summary, tone: activeWorld.tone, lore: activeWorld.lore, rules: activeWorld.rules }
          : undefined,
      });
      if (res.ok) {
        setDrafts(res.data.map((c) => ({ keep: true, company: c })));
      } else {
        setError(`Generation failed: ${res.error}`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  const editDraft = (i: number, patch: Partial<CompanyCreate>) =>
    setDrafts((ds) => ds.map((d, idx) => (idx === i ? { ...d, company: { ...d.company, ...patch } } : d)));
  const toggleDraft = (i: number) =>
    setDrafts((ds) => ds.map((d, idx) => (idx === i ? { ...d, keep: !d.keep } : d)));
  const keptCount = drafts.filter((d) => d.keep).length;

  const saveDrafts = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const kept = drafts.filter((d) => d.keep).map((d) => d.company);
      for (const c of kept) await api.createCompany({ ...c, worldId: activeWorldId });
      setNote(`Saved ${kept.length} compan${kept.length === 1 ? 'y' : 'ies'} to the market.`);
      setGenOpen(false);
      setDrafts([]);
      marketState.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  /* ── Manual create ──────────────────────────────────────────────────── */
  const createNew = async () => {
    if (creatingNew || !newForm.name.trim() || !newForm.ticker.trim()) return;
    setCreatingNew(true);
    setError(undefined);
    try {
      await api.createCompany({ ...newForm, worldId: activeWorldId });
      setNote(`Created ${newForm.ticker}.`);
      setNewForm({ name: '', ticker: '', sector: 'tech', basePrice: 100, volatility: 0.04, dividendPerShare: 0, description: '', linkedCharacterId: null, assetId: null });
      marketState.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCreatingNew(false);
    }
  };

  const money = player?.money ?? 0;

  return (
    <div className="phone-app">
      <PhoneAppBar title="Market" kicker="Stock exchange" icon="coin" />

      <div className="mkt-scroll">
        {/* ── Purse strip ─────────────────────────────────────────────── */}
        <div className="mkt-purse-bar">
          <span className="mkt-purse-label">Cash</span>
          <span className="mkt-purse-coin">◈ {money}</span>
        </div>

        {/* ── Notifications ───────────────────────────────────────────── */}
        {note && <Banner kind="ok">{note}</Banner>}
        {error && <Banner kind="error">{error}</Banner>}

        {/* ── Tab bar ─────────────────────────────────────────────────── */}
        <div className="mkt-tabs" role="tablist">
          <button
            className={`mkt-tab${tab === 'market' ? ' active' : ''}`}
            role="tab"
            aria-selected={tab === 'market'}
            onClick={() => setTab('market')}
          >
            <Icon name="coin" size={14} /> Market
          </button>
          <button
            className={`mkt-tab${tab === 'portfolio' ? ' active' : ''}`}
            role="tab"
            aria-selected={tab === 'portfolio'}
            onClick={() => setTab('portfolio')}
          >
            <Icon name="trophy" size={14} /> Portfolio
          </button>
        </div>

        {/* ══════════════════════════════════════════════════════════════
            MARKET TAB
        ══════════════════════════════════════════════════════════════ */}
        {tab === 'market' && (
          <>
            {/* Creator: generate + new-company forms */}
            {creatorMode && (
              <div className="mkt-creator framed stack">
                <div className="mkt-creator-head">
                  <div>
                    <div className="kicker">Creator Workshop</div>
                    <h3 style={{ margin: 0 }}>Companies</h3>
                  </div>
                  {!genOpen && (
                    <button className="btn sm primary" onClick={() => setGenOpen(true)}>
                      <Icon name="generate" size={14} /> Generate
                    </button>
                  )}
                </div>

                {genOpen && (
                  <div className="mkt-gen stack">
                    <div className="mkt-gen-header">
                      <div className="kicker">Generate from world lore</div>
                      <button className="btn ghost sm" onClick={() => { setGenOpen(false); setDrafts([]); }}>
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                    <div className="inline-fields">
                      <Field label="Count (1–8)">
                        <input
                          type="number"
                          min={1}
                          max={8}
                          value={genForm.count}
                          onChange={(e) => setGenForm({ ...genForm, count: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })}
                        />
                      </Field>
                      <Field label="Sector hint">
                        <select
                          value={genForm.sectorHint}
                          onChange={(e) => setGenForm({ ...genForm, sectorHint: e.target.value as '' | StockSector })}
                        >
                          <option value="">— any —</option>
                          {SECTORS.map((s) => (
                            <option key={s} value={s}>{STOCK_SECTOR_LABELS[s]}</option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <Field label="Theme / guidance" hint="Optional — e.g. ‘high-tech guild economy’ or ‘frontier trading posts’.">
                      <textarea
                        value={genForm.theme}
                        placeholder="Describe the companies you want…"
                        onChange={(e) => setGenForm({ ...genForm, theme: e.target.value })}
                      />
                    </Field>
                    <div className="row">
                      <button className="btn primary" onClick={generate} disabled={generating}>
                        {generating ? 'Generating…' : <><Icon name="generate" size={14} /> Generate</>}
                      </button>
                      {drafts.length > 0 && (
                        <button className="btn" onClick={saveDrafts} disabled={saving || keptCount === 0}>
                          {saving ? 'Saving…' : `Save ${keptCount} selected`}
                        </button>
                      )}
                    </div>

                    {drafts.length > 0 && (
                      <>
                        <div className="mkt-gen-divider">Review &amp; refine</div>
                        <div className="mkt-drafts">
                          {drafts.map((d, i) => (
                            <DraftCard
                              key={i}
                              draft={d}
                              index={i}
                              onToggle={toggleDraft}
                              onEdit={editDraft}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Manual new-company form */}
                <div className="mkt-new-form stack">
                  <div className="kicker">New company</div>
                  <div className="inline-fields">
                    <Field label="Name">
                      <input
                        value={newForm.name}
                        placeholder="Apex Corp"
                        onChange={(e) => setNewForm({ ...newForm, name: e.target.value })}
                      />
                    </Field>
                    <Field label="Ticker">
                      <input
                        value={newForm.ticker}
                        placeholder="APEX"
                        maxLength={6}
                        onChange={(e) => setNewForm({ ...newForm, ticker: e.target.value.toUpperCase() })}
                      />
                    </Field>
                  </div>
                  <div className="inline-fields">
                    <Field label="Sector">
                      <select
                        value={newForm.sector}
                        onChange={(e) => setNewForm({ ...newForm, sector: e.target.value as StockSector })}
                      >
                        {SECTORS.map((s) => (
                          <option key={s} value={s}>{STOCK_SECTOR_LABELS[s]}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Base price (◈)">
                      <input
                        type="number"
                        min={1}
                        value={newForm.basePrice}
                        onChange={(e) => setNewForm({ ...newForm, basePrice: Math.max(1, Number(e.target.value) || 1) })}
                      />
                    </Field>
                  </div>
                  <div className="inline-fields">
                    <Field label="Volatility (0–0.15)">
                      <input
                        type="number"
                        min={0}
                        max={0.15}
                        step={0.01}
                        value={newForm.volatility}
                        onChange={(e) => setNewForm({ ...newForm, volatility: Math.max(0, Math.min(0.15, Number(e.target.value) || 0)) })}
                      />
                    </Field>
                    <Field label="Dividend/share">
                      <input
                        type="number"
                        min={0}
                        value={newForm.dividendPerShare}
                        onChange={(e) => setNewForm({ ...newForm, dividendPerShare: Math.max(0, Number(e.target.value) || 0) })}
                      />
                    </Field>
                  </div>
                  <Field label="Description">
                    <textarea
                      value={newForm.description ?? ''}
                      placeholder="What does this company do?"
                      onChange={(e) => setNewForm({ ...newForm, description: e.target.value })}
                    />
                  </Field>
                  <button
                    className="btn primary"
                    onClick={createNew}
                    disabled={creatingNew || !newForm.name.trim() || !newForm.ticker.trim()}
                  >
                    <Icon name="plus" size={15} /> {creatingNew ? 'Creating…' : 'Create company'}
                  </button>
                </div>
              </div>
            )}

            {/* Market board */}
            <Loader state={marketState}>
              {(market) =>
                market.companies.length === 0 ? (
                  <Empty icon={<Icon name="coin" size={34} />} title="No companies listed">
                    <p className="muted">
                      {creatorMode
                        ? 'Use the creator workshop above to add companies.'
                        : 'No companies are trading in this world yet.'}
                    </p>
                  </Empty>
                ) : (
                  <>
                    <div className="mkt-eyebrow">
                      <Icon name="coin" size={12} /> Listings · {market.companies.length} compan{market.companies.length === 1 ? 'y' : 'ies'}
                    </div>
                    <div className="mkt-board">
                      {market.companies.map((view) => (
                        <div key={view.company.id} className="mkt-row-wrap">
                          <CompanyRow
                            view={view}
                            activeWorldId={activeWorldId}
                            tradingId={tradingId}
                            onTrade={trade}
                          />
                          {creatorMode && (
                            <button
                              className="btn danger ghost sm mkt-delete-btn"
                              title="Delete company"
                              aria-label={`Delete ${view.company.name}`}
                              onClick={() => setPendingDelete(view.company)}
                            >
                              <Icon name="trash" size={14} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* News */}
                    {market.news.length > 0 && (
                      <>
                        <div className="mkt-eyebrow">
                          <Icon name="chronicle" size={12} /> Recent headlines
                        </div>
                        <div className="mkt-news-list">
                          {market.news.map((item) => (
                            <NewsCard key={item.id} item={item} />
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )
              }
            </Loader>
          </>
        )}

        {/* ══════════════════════════════════════════════════════════════
            PORTFOLIO TAB
        ══════════════════════════════════════════════════════════════ */}
        {tab === 'portfolio' && (
          <Loader state={portfolioState}>
            {(portfolio) =>
              portfolio.positions.length === 0 ? (
                <Empty icon={<Icon name="trophy" size={34} />} title="No holdings">
                  <p className="muted">Buy shares from the Market tab to build your portfolio.</p>
                </Empty>
              ) : (
                <>
                  <div className="mkt-portfolio-summary framed">
                    <div className="mkt-port-stat">
                      <span className="mkt-port-label">Portfolio value</span>
                      <span className="mkt-port-value">◈ {portfolio.value}</span>
                    </div>
                    <div className="mkt-port-stat">
                      <span className="mkt-port-label">Cash</span>
                      <span className="mkt-port-value">◈ {portfolio.cash}</span>
                    </div>
                  </div>
                  <div className="mkt-eyebrow">
                    <Icon name="trophy" size={12} /> Positions · {portfolio.positions.length}
                  </div>
                  <div className="mkt-positions">
                    {portfolio.positions.map((pos) => (
                      <PositionRow key={pos.company.id} pos={pos} />
                    ))}
                  </div>
                </>
              )
            }
          </Loader>
        )}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${pendingDelete.name}?`}
          body="This removes the company from the market. Existing holdings are not refunded."
          confirmLabel="Delete"
          danger
          busy={deleting}
          onConfirm={() => removeCompany(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
