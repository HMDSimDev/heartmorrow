import { useEffect, useState } from 'react';
import { PHASE_ICONS, PHASE_LABELS, SEASON_ICONS, deriveCalendar, type SleepResponse, type WealthSummary } from '@dsim/shared';
import { useAppData } from '../state/app-context';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { EnergyPips } from './EnergyPips';
import { Icon } from './Icon';
import { Modal } from './ui';

/** Compact day / time-of-day / stamina indicator + Sleep control for the active world. */
export function DayHud() {
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

  return (
    <div className="hud">
      {worlds.length > 1 ? (
        <select
          className="hud-world"
          value={activeWorldId}
          onChange={(e) => setActiveWorld(e.target.value)}
          title="Active world"
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

      <div className="hud-clock" title={`${PHASE_LABELS[worldState.phase]} · ${cal.dayOfWeek} · ${cal.season}`}>
        <span className="hud-phase">{PHASE_ICONS[worldState.phase]}</span>
        <div className="hud-when">
          <span className="hud-day">Day {worldState.day} · {PHASE_LABELS[worldState.phase]}</span>
          <span className="hud-cal">
            {SEASON_ICONS[cal.season]} {cal.dayOfWeek}
            {cal.isWeekend ? ' · weekend' : ''}
          </span>
        </div>
      </div>

      <div className="hud-energy" title={`${worldState.stamina} of ${worldState.staminaMax} actions left today`} aria-label={`Energy: ${worldState.stamina} of ${worldState.staminaMax}`}>
        <span className="hud-energy-label">Energy</span>
        <EnergyPips value={worldState.stamina} max={worldState.staminaMax} />
        <span className="hud-energy-count">
          {worldState.stamina}/{worldState.staminaMax}
        </span>
      </div>

      <div className="hud-foot">
        <span className="hud-money" title="Cash on hand">
          <Icon name="coin" size={15} /> {player?.money ?? 0}
        </span>
        {wealth && wealth.total > wealth.cash && (
          <span
            className="hud-money hud-networth"
            title={`Net worth — Cash ◈${wealth.cash} · Property ◈${wealth.property} · Stocks ◈${wealth.stocks}`}
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
              ? `You're on a date with ${activeDate.characterName} — finish it on the Date tab before ending the day.`
              : undefined
          }
        >
          {sleeping ? '…' : worldState.stamina <= 0 ? 'Sleep' : 'End day'}
        </button>
      </div>

      {activeDate && <small className="hud-note">On a date — finish it to end the day.</small>}
      {error && <small className="hud-err">{error}</small>}
      {recap && <RecapModal res={recap} onClose={() => setRecap(null)} />}
    </div>
  );
}

function RecapModal({ res, onClose }: { res: SleepResponse; onClose: () => void }) {
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
            <h2>A new day dawns</h2>
            <p className="muted">
              {res.recapError ? `(Couldn't generate a recap: ${res.recapError})` : 'You rest and wake refreshed.'}
            </p>
          </>
        )}
        {res.worldSim && res.worldSim.beats.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="kicker">Around town</div>
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
                {res.calendar.dayOfWeek} · {res.calendar.season}
                {res.calendar.isWeekend ? ' · weekend ⚡' : ''}
              </span>
            )}
            {res.weather && (
              <span className="badge">
                {res.weather.icon} {res.weather.label}
              </span>
            )}
            {res.income > 0 && <span className="badge">💰 +{res.income}</span>}
          </div>
        )}
        {res.holiday && (
          <div className="banner info" style={{ marginTop: 8, fontSize: '0.85rem' }}>
            <strong>{res.holiday.name}</strong> — {res.holiday.blurb}
          </div>
        )}
        {res.decayed.length > 0 && (
          <p className="dim" style={{ fontSize: '0.85rem' }}>
            You haven't seen {res.decayed.map((d) => `${d.name} (${d.daysSinceSeen}d)`).join(', ')} in a while — they're
            starting to feel neglected.
          </p>
        )}
        <div className="row end">
          <button className="btn primary" onClick={onClose}>
            Good morning, Day {res.state.day}
          </button>
        </div>
      </>
    </Modal>
  );
}
