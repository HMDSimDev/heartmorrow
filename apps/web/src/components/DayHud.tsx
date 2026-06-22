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
      const res = await sleep();
      if (res) setRecap(res);
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
        activeName && <div className="hud-worldname">{activeName}</div>
      )}

      <div className="hud-clock" title={t('hud.clockTitle', { phase: phaseTxt, weekday: weekdayTxt, season: seasonTxt })}>
        <span className="hud-phase">{PHASE_ICONS[worldState.phase]}</span>
        <div className="hud-when">
          <span className="hud-day">{t('hud.dayPhase', { day: worldState.day, phase: phaseTxt })}</span>
          <span className="hud-cal">
            {SEASON_ICONS[cal.season]} {weekdayTxt}
            {cal.isWeekend ? t('hud.weekendSuffix') : ''}
          </span>
        </div>
      </div>

      <div className="hud-energy" title={t('hud.energyTitle', { stamina: worldState.stamina, max: worldState.staminaMax })} aria-label={t('hud.energyAria', { stamina: worldState.stamina, max: worldState.staminaMax })}>
        <span className="hud-energy-label">{t('hud.energy')}</span>
        <EnergyPips value={worldState.stamina} max={worldState.staminaMax} />
        <span className="hud-energy-count">
          {worldState.stamina}/{worldState.staminaMax}
        </span>
      </div>

      <div className="hud-foot">
        <span className="hud-money" title={t('hud.cashOnHand')}>
          <Icon name="coin" size={15} /> {player?.money ?? 0}
        </span>
        {wealth && wealth.total > wealth.cash && (
          <span
            className="hud-money hud-networth"
            title={t('hud.netWorth', { cash: wealth.cash, property: wealth.property, stocks: wealth.stocks })}
          >
            <Icon name="wealth" size={14} /> {wealth.total}
          </span>
        )}
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
