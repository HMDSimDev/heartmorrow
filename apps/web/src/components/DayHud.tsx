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
              ? t('hud.endDayDateBlock', { name: activeDate.characterName })
              : undefined
          }
        >
          {sleeping ? '…' : worldState.stamina <= 0 ? t('hud.sleep') : t('hud.endDay')}
        </button>
      </div>

      {activeDate && <small className="hud-note">{t('hud.onDateNote')}</small>}
      {error && <small className="hud-err">{error}</small>}
      {recap && <RecapModal res={recap} onClose={() => setRecap(null)} />}
    </div>
  );
}

function RecapModal({ res, onClose }: { res: SleepResponse; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal onClose={onClose}>
      <>
        {res.recap ? (
          <>
            <h2>{res.recap.headline}</h2>
            <p style={{ whiteSpace: 'pre-wrap' }}>{res.recap.narrative}</p>
            {res.recap.highlights.length > 0 && (
              <ul style={{ paddingLeft: 18 }}>
                {res.recap.highlights.map((h, i) => (
                  <li key={i} className="dim">
                    {h}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            <h2>{t('recap.newDay')}</h2>
            <p className="muted">
              {res.recapError ? t('recap.recapError', { error: res.recapError }) : t('recap.rested')}
            </p>
          </>
        )}
        {res.worldSim && res.worldSim.beats.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="kicker">{t('recap.aroundTown')}</div>
            <ul style={{ paddingLeft: 18, marginTop: 4 }}>
              {res.worldSim.beats.map((b, i) => (
                <li key={i} className="dim">
                  {b.summary}
                </li>
              ))}
            </ul>
          </div>
        )}
        {(res.calendar || res.weather || res.income > 0) && (
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            {res.calendar && (
              <span className="badge">
                {weekdayLabel(res.calendar.dayOfWeek)} · {seasonLabel(res.calendar.season)}
                {res.calendar.isWeekend ? t('recap.weekendBadgeSuffix') : ''}
              </span>
            )}
            {res.weather && (
              <span className="badge">
                {res.weather.icon} {res.weather.label}
              </span>
            )}
            {res.income > 0 && <span className="badge">{t('recap.income', { income: res.income })}</span>}
          </div>
        )}
        {res.holiday && (
          <div className="banner info" style={{ marginTop: 8, fontSize: '0.85rem' }}>
            <strong>{res.holiday.name}</strong> — {res.holiday.blurb}
          </div>
        )}
        {res.decayed.length > 0 && (
          <p className="dim" style={{ fontSize: '0.85rem' }}>
            {t('recap.decayed', {
              names: res.decayed.map((d) => t('recap.decayedItem', { name: d.name, days: d.daysSinceSeen })).join(', '),
            })}
          </p>
        )}
        <div className="row end">
          <button className="btn primary" onClick={onClose}>
            {t('recap.goodMorning', { day: res.state.day })}
          </button>
        </div>
      </>
    </Modal>
  );
}
