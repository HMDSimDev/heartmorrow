import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PHASE_ICONS, SEASON_ICONS, deriveCalendar, type SleepResponse, type WealthSummary } from '@dsim/shared';
import { useAppData } from '../state/app-context';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { phaseLabel, seasonLabel, weekdayLabel } from '../i18n/labels';
import { EnergyPips } from './EnergyPips';
import { Icon } from './Icon';
import { Modal } from './ui';
import './recap-modal.css';

/** Compact day / time-of-day / stamina indicator + Sleep control for the active world. */
export function DayHud() {
  const { t } = useTranslation();
  const { worlds, activeWorldId, activeWorld, worldState, setActiveWorld, sleep, player, dayTick, activeDate } =
    useAppData();
  const [recap, setRecap] = useState<SleepResponse | null>(null);
  const [sleeping, setSleeping] = useState(false);
  const [error, setError] = useState<string>();
  const [wealth, setWealth] = useState<WealthSummary | null>(null);

  // Net worth (cash + property + stocks) when EITHER wealth feature is enabled.
  // Keyed on dayTick + money so it refreshes after End day and after a buy/sell.
  const wealthOn = !!(activeWorld?.featureFlags?.property || activeWorld?.featureFlags?.stockMarket);
  useEffect(() => {
    if (!activeWorldId || !wealthOn) {
      setWealth(null);
      return;
    }
    let live = true;
    api
      .getWealth(activeWorldId)
      .then((w) => live && setWealth(w))
      .catch(() => live && setWealth(null));
    return () => {
      live = false;
    };
  }, [activeWorldId, wealthOn, dayTick, player?.money]);

  if (!activeWorldId || !worldState) return null;

  const doSleep = async () => {
    setSleeping(true);
    setError(undefined);
    try {
      // Pass the day we currently believe we're on so a stale/duplicate Sleep (e.g. a
      // second tab) no-ops server-side instead of burning a second day; skip the recap
      // popup when it did (res.advanced === false).
      const res = await sleep(worldState.day);
      if (res && res.advanced !== false) setRecap(res);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSleeping(false);
    }
  };

  const cal = deriveCalendar(worldState.day);
  const activeName = worlds.find((w) => w.id === activeWorldId)?.name;
  const phaseTxt = phaseLabel(worldState.phase);
  const weekdayTxt = weekdayLabel(cal.dayOfWeek);
  const seasonTxt = seasonLabel(cal.season);

  return (
    <div className="hud">
      {worlds.length > 1 ? (
        <select
          className="hud-world"
          value={activeWorldId}
          onChange={(e) => setActiveWorld(e.target.value)}
          title={t('hud.activeWorld')}
          disabled={sleeping}
        >
          {worlds.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      ) : (
        activeName && (
          <div className="hud-masthead" title={activeName}>
            {activeName}
          </div>
        )
      )}

      {/* Grouped so the mobile topbar can lay the instruments out as one strip;
          the sidebar renders this wrapper as display:contents (no layout change). */}
      <div className="hud-instruments">
        <div className="hud-clock" title={t('hud.clockTitle', { phase: phaseTxt, weekday: weekdayTxt, season: seasonTxt })}>
          {/* The lamp bezel — its glow is tinted by <html data-phase>. */}
          <span className="hud-bezel" aria-hidden="true">{PHASE_ICONS[worldState.phase]}</span>
          <div className="hud-when">
            <span className="hud-day">{t('hud.dayNum', { day: worldState.day })}</span>
            <span className="hud-cal">
              {phaseTxt} · {weekdayTxt}
              {cal.isWeekend ? t('hud.weekendSuffix') : ''}
              <span className="hud-season" aria-hidden="true"> {SEASON_ICONS[cal.season]}</span>
            </span>
          </div>
        </div>

        <div className="hud-ledger">
          <div className="hud-seg hud-energy" title={t('hud.energyTitle', { stamina: worldState.stamina, max: worldState.staminaMax })} aria-label={t('hud.energyAria', { stamina: worldState.stamina, max: worldState.staminaMax })}>
            <span className="hud-seg-label">{t('hud.energy')}</span>
            <span className="hud-seg-value">
              <EnergyPips value={worldState.stamina} max={worldState.staminaMax} />
              <span className="hud-energy-count">
                {worldState.stamina}/{worldState.staminaMax}
              </span>
            </span>
          </div>
          <div className="hud-seg" title={t('hud.cashOnHand')}>
            <span className="hud-seg-label">{t('hud.purse')}</span>
            <span className="hud-seg-value hud-money">
              <Icon name="coin" size={14} /> {player?.money ?? 0}
            </span>
          </div>
          {wealth && wealth.total > wealth.cash && (
            <div
              className="hud-seg hud-networth"
              title={t('hud.netWorth', { cash: wealth.cash, property: wealth.property, stocks: wealth.stocks })}
            >
              <span className="hud-seg-label">{t('hud.worth')}</span>
              <span className="hud-seg-value hud-money">
                <Icon name="wealth" size={13} /> {wealth.total}
              </span>
            </div>
          )}
        </div>

        <button
          className="btn sm primary hud-end"
          onClick={doSleep}
          disabled={sleeping || !!activeDate}
          title={
            activeDate
              ? t(activeDate.mode === 'hangout' ? 'hud.endDayHangoutBlock' : 'hud.endDayDateBlock', {
                  name: activeDate.characterName,
                })
              : undefined
          }
        >
          {sleeping ? '…' : worldState.stamina <= 0 ? t('hud.sleep') : t('hud.endDay')}
        </button>
      </div>

      {activeDate && (
        <small className="hud-note">{t(activeDate.mode === 'hangout' ? 'hud.onHangoutNote' : 'hud.onDateNote')}</small>
      )}
      {error && <small className="hud-err">{error}</small>}
      {recap && <RecapModal res={recap} onClose={() => setRecap(null)} />}
    </div>
  );
}

/** One line of the morning ledger: label, dotted leader, signed amount. */
function LedgerRow({ label, amount }: { label: string; amount: number }) {
  const sign = amount > 0 ? '+' : amount < 0 ? '−' : '';
  const cls = amount > 0 ? ' is-credit' : amount < 0 ? ' is-debit' : '';
  return (
    <div className="rcp-row">
      <span className="rcp-row-label">{label}</span>
      <span className="rcp-leader" aria-hidden="true" />
      <span className={`rcp-row-value${cls}`}>
        {sign}◈{Math.abs(amount)}
      </span>
    </div>
  );
}

/**
 * The end-of-day summary, split into tabs so each concern reads at a glance:
 *  - The day  — the LLM-written recap of the day's STORY (plus morning context).
 *  - Around town — the world-sim's bounded "what the NPCs did" beats.
 *  - Ledger — the deterministic money story (work/casino/rent/dividends/market),
 *    computed server-side and NEVER narrated: a big portfolio is a few tidy rows
 *    here instead of a wall of LLM flavor text.
 */
function RecapModal({ res, onClose }: { res: SleepResponse; onClose: () => void }) {
  const { t } = useTranslation();
  const l = res.ledger;
  const hasTown = !!res.worldSim && res.worldSim.beats.length > 0;
  const hasLedger =
    !!l &&
    (l.workShifts > 0 ||
      l.gamblingPlays > 0 ||
      l.spent > 0 ||
      l.dividendHoldings > 0 ||
      l.rentPaid > 0 ||
      l.rentOverdue.length > 0 ||
      l.evictedFrom.length > 0 ||
      l.movers.length > 0);
  const [tab, setTab] = useState<'day' | 'town' | 'ledger'>('day');

  const tabs: Array<{ id: 'day' | 'town' | 'ledger'; label: string }> = [
    { id: 'day', label: t('recap.tabDay') },
    ...(hasTown ? [{ id: 'town' as const, label: t('recap.tabTown') }] : []),
    ...(hasLedger ? [{ id: 'ledger' as const, label: t('recap.tabLedger') }] : []),
  ];

  // The ledger's bottom line: everything the day earned minus everything it cost.
  const net = l ? l.workEarned + l.gamblingNet - l.spent + l.dividendsTotal - l.rentPaid : 0;

  return (
    <Modal onClose={onClose}>
      <div className="rcp">
        {/* Masthead: the almanac turns a page. Dateline prose, not badge chips. */}
        <header className="rcp-mast">
          <span className="rcp-seal" aria-hidden="true">
            ☼
          </span>
          <div className="rcp-eyebrow">{t('recap.mastEyebrow', { day: res.state.day })}</div>
          <h2 className="rcp-headline">{res.recap ? res.recap.headline : t('recap.newDay')}</h2>
          {(res.calendar || res.weather) && (
            <div className="rcp-dateline">
              {res.calendar && (
                <>
                  {weekdayLabel(res.calendar.dayOfWeek)} · {seasonLabel(res.calendar.season)}
                  {res.calendar.isWeekend ? t('recap.weekendBadgeSuffix') : ''}
                </>
              )}
              {res.calendar && res.weather && ' — '}
              {res.weather && (
                <>
                  {res.weather.icon} {res.weather.label}
                </>
              )}
            </div>
          )}
          {res.holiday && (
            <div className="rcp-holiday">
              ✦ <strong>{res.holiday.name}</strong> — {res.holiday.blurb}
            </div>
          )}
        </header>

        {tabs.length > 1 && (
          <div className="rcp-tabs" role="tablist">
            {tabs.map((x) => (
              <button
                key={x.id}
                role="tab"
                aria-selected={tab === x.id}
                className={`rcp-tab${tab === x.id ? ' is-active' : ''}`}
                onClick={() => setTab(x.id)}
              >
                {x.label}
              </button>
            ))}
          </div>
        )}

        {tab === 'day' && (
          <div className="rcp-pane">
            {res.recap ? (
              <>
                <p className="rcp-narrative">{res.recap.narrative}</p>
                {res.recap.highlights.length > 0 && (
                  <ul className="rcp-highlights">
                    {res.recap.highlights.map((h, i) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="rcp-narrative is-quiet">
                {res.recapError ? t('recap.recapError', { error: res.recapError }) : t('recap.rested')}
              </p>
            )}
            {res.decayed.length > 0 && (
              <p className="rcp-drift">
                {t('recap.decayed', {
                  names: res.decayed.map((d) => t('recap.decayedItem', { name: d.name, days: d.daysSinceSeen })).join(', '),
                })}
              </p>
            )}
          </div>
        )}

        {tab === 'town' && hasTown && (
          <div className="rcp-pane">
            <ul className="rcp-town">
              {res.worldSim!.beats.map((b, i) => (
                <li key={i}>{b.summary}</li>
              ))}
            </ul>
          </div>
        )}

        {tab === 'ledger' && hasLedger && l && (
          <div className="rcp-pane rcp-ledger">
            {l.workShifts > 0 && <LedgerRow label={t('recap.ledgerWork', { count: l.workShifts })} amount={l.workEarned} />}
            {l.gamblingPlays > 0 && <LedgerRow label={t('recap.ledgerCasino', { count: l.gamblingPlays })} amount={l.gamblingNet} />}
            {l.spent > 0 && <LedgerRow label={t('recap.ledgerSpent')} amount={-l.spent} />}
            {l.dividendHoldings > 0 && (
              <LedgerRow label={t('recap.ledgerDividends', { count: l.dividendHoldings })} amount={l.dividendsTotal} />
            )}
            {l.rentPaid > 0 && <LedgerRow label={t('recap.ledgerRent')} amount={-l.rentPaid} />}

            <div className="rcp-net">
              <span className="rcp-row-label">{t('recap.ledgerNet')}</span>
              <span className="rcp-leader" aria-hidden="true" />
              <span className={`rcp-row-value${net > 0 ? ' is-credit' : net < 0 ? ' is-debit' : ''}`}>
                {net > 0 ? '+' : net < 0 ? '−' : ''}◈{Math.abs(net)}
              </span>
            </div>

            {l.rentOverdue.length > 0 && <p className="rcp-alert">{t('recap.ledgerOverdue', { names: l.rentOverdue.join(', ') })}</p>}
            {l.evictedFrom.length > 0 && (
              <p className="rcp-alert is-grave">{t('recap.ledgerEvicted', { names: l.evictedFrom.join(', ') })}</p>
            )}

            {l.movers.length > 0 && (
              <div className="rcp-market">
                <div className="rcp-market-eyebrow">{t('recap.ledgerMarket')}</div>
                <div className="rcp-movers">
                  {l.movers.map((m) => (
                    <span key={m.ticker} className={`rcp-mover${m.pct >= 0 ? ' is-up' : ' is-down'}`}>
                      {m.ticker} {m.pct >= 0 ? '▲' : '▼'}
                      {Math.abs(Math.round(m.pct * 100))}%
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <footer className="rcp-foot">
          <button className="btn primary rcp-wake" onClick={onClose}>
            {t('recap.goodMorning', { day: res.state.day })}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
