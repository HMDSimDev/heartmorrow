import { useEffect, useState } from 'react';
import type { ActivityDef } from '@dsim/shared';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Banner } from '../ui';
import './phone-life.css';

export function WorkApp() {
  const { activeWorldId, reloadPlayer, refreshWorldState, worldState, dayTick, activeDate } = useAppData();
  const [activities, setActivities] = useState<ActivityDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  // No actions left today — gate the tiles up front instead of letting the POST 400.
  const noEnergy = (worldState?.stamina ?? 0) <= 0;
  // You can't clock in while you're out on a date — finish it first.
  const onDate = !!activeDate;

  useEffect(() => {
    api.listActivities().then(setActivities).catch(() => undefined);
  }, [dayTick]);

  const perform = async (a: ActivityDef) => {
    if (!activeWorldId) {
      setError('Pick an active world first.');
      return;
    }
    if (onDate) {
      setError(`You're on a date with ${activeDate!.characterName} — wrap it up on the Date tab first.`);
      return;
    }
    setBusy(true);
    setNote(undefined);
    setError(undefined);
    try {
      const res = await api.performActivity({ activityId: a.id, worldId: activeWorldId, characterId: null });
      await Promise.all([reloadPlayer(), refreshWorldState()]);
      setNote(`Earned ◈${res.money}. (Day ${res.state.day}, ${res.state.phase})`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const work = activities.filter((a) => a.kind === 'work');

  return (
    <div className="phone-app">
      <PhoneAppBar title="Work" kicker="the day's shifts" icon="work" />
      <div className="phone-embed pl-work-embed">
        {(note || error) && (
          <div className="pl-work-banner">
            {note && <Banner kind="ok">{note}</Banner>}
            {error && <Banner kind="error">{error}</Banner>}
          </div>
        )}

        <div className="pl-board">
          <p className="pl-board-note">
            Each shift spends one action — a piece of the day — for coin. Time spent with people lives in Together.
          </p>
          {noEnergy && (
            <p className="pl-board-note">You're out of energy for today — end the day to rest.</p>
          )}
          {onDate && (
            <p className="pl-board-note">
              You're on a date with {activeDate!.characterName} — finish it on the Date tab before clocking in.
            </p>
          )}
        </div>

        <div className="pl-eyebrow">Shifts · earn ◈</div>
        {worldState && (
          <div className={`pl-energy-readout${noEnergy ? ' is-spent' : ''}`}>
            <span>◆</span>
            <span>
              {worldState.stamina} of {worldState.staminaMax} energy left today
            </span>
          </div>
        )}
        {work.map((a) => (
          <div className="pl-tile pl-work" key={a.id}>
            <div className="pl-tile-icon"><Icon name="work" size={18} /></div>
            <div className="pl-tile-body">
              <div className="pl-tile-label">{a.label}</div>
              <div className="pl-tile-desc">{a.description}</div>
            </div>
            <div className="pl-tile-action">
              <span className="pl-tile-cost" title="Costs one action — a piece of the day">−1 ◆</span>
              <button className="btn sm primary" onClick={() => perform(a)} disabled={busy || noEnergy || onDate}>
                <span className="pl-coin">◈ {a.money}</span>
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
