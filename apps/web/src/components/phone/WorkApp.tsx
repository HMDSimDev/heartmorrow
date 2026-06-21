import { useEffect, useRef, useState } from 'react';
import {
  CAREER_SKILLS,
  CAREER_SKILL_LABELS,
  careerProgress,
  isCareerSkill,
  masteryMult,
  type ActivityDef,
  type MinigameInfo,
  type MinigameSubmission,
} from '@dsim/shared';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Banner } from '../ui';
import { GameView, type ActiveGame } from '../minigames/GameView';
import './phone-life.css';

export function WorkApp() {
  const { activeWorldId, reloadPlayer, refreshWorldState, worldState, dayTick, activeDate, player } = useAppData();
  const [activities, setActivities] = useState<ActivityDef[]>([]);
  const [jobGames, setJobGames] = useState<MinigameInfo[]>([]);
  const [active, setActive] = useState<ActiveGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  // A skill-work shift can only be finished once even if the game fires twice.
  const finishingRef = useRef(false);

  const stamina = worldState?.stamina ?? 0;
  const noEnergy = stamina <= 0;
  const onDate = !!activeDate;

  useEffect(() => {
    // A new day ends any half-finished shift left on screen.
    setActive(null);
    finishingRef.current = false;
    api.listActivities().then(setActivities).catch(() => undefined);
    // Job games (paid skill work) live HERE, not the dating arcade.
    api.listMinigames().then((g) => setJobGames(g.filter((x) => x.mode === 'job'))).catch(() => undefined);
  }, [dayTick]);

  // A world switch must not leave a previous world's run on screen — finishing it would
  // reconcile its reward into that world while the HUD now reflects the new one. Mirrors
  // the guard in the Arcade (Minigames.tsx).
  const lastWorldRef = useRef(activeWorldId);
  useEffect(() => {
    if (lastWorldRef.current === activeWorldId) return;
    lastWorldRef.current = activeWorldId;
    setActive(null);
    finishingRef.current = false;
  }, [activeWorldId]);

  /** This world's level in a career skill (0 if never worked it). */
  const lvl = (skill?: string): number =>
    skill && isCareerSkill(skill) ? player?.career?.[skill]?.level ?? 0 : 0;
  const skillName = (skill?: string): string => (skill && isCareerSkill(skill) ? CAREER_SKILL_LABELS[skill] : '');

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
      const lifted =
        res.skillLeveledUp && isCareerSkill(res.skill)
          ? `✦ ${CAREER_SKILL_LABELS[res.skill]} reached level ${res.skillLevel}! `
          : '';
      setNote(`${lifted}Earned ◈${res.money}. (Day ${res.state.day}, ${res.state.phase})`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const startJob = async (g: MinigameInfo) => {
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
      // Skill work is impersonal — never tied to a character.
      const res = await api.startMinigame({ minigameId: g.id, characterId: null, worldId: activeWorldId });
      setActive({ minigameId: g.id, runId: res.runId, config: res.config });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const finishJob = async (submission: MinigameSubmission) => {
    if (!active || finishingRef.current) return;
    finishingRef.current = true;
    setBusy(true);
    try {
      const title = jobGames.find((g) => g.id === active.minigameId)?.title ?? 'Shift';
      const res = await api.finishMinigame({ runId: active.runId, submission });
      setActive(null);
      await Promise.all([reloadPlayer(), refreshWorldState()]);
      const r = res.result;
      const earned = r.reward.money > 0 ? `Earned ◈${r.reward.money}.` : 'No pay this time — sharpen up.';
      setNote(`${title} — grade ${r.grade} (${r.score}). ${earned}`);
    } catch (e) {
      setError(errorMessage(e));
      setActive(null);
    } finally {
      setBusy(false);
      finishingRef.current = false;
    }
  };

  // On shift: the play surface takes over the whole app body.
  if (active) {
    return (
      <div className="phone-app">
        <PhoneAppBar title="Work" kicker="on shift" icon="work" />
        <div className="phone-embed pl-work-embed">
          <div className="pl-job-stage-head">
            <span className="pl-eyebrow">On shift · {jobGames.find((g) => g.id === active.minigameId)?.title}</span>
            <button className="btn sm ghost danger" onClick={() => setActive(null)} disabled={busy}>
              Quit
            </button>
          </div>
          <GameView active={active} partner={null} onComplete={finishJob} />
        </div>
      </div>
    );
  }

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
            Each shift spends part of your day for coin — and builds a skill. The better you get, the more the work
            pays. Some jobs take more than one action, some pay an uneven cut, and some stay locked until you've earned
            your stripes.
          </p>
          {noEnergy && <p className="pl-board-note">You're out of energy for today — end the day to rest.</p>}
          {onDate && (
            <p className="pl-board-note">
              You're on a date with {activeDate!.characterName} — finish it on the Date tab before clocking in.
            </p>
          )}
        </div>

        {/* --- Career skills ------------------------------------------------ */}
        <div className="pl-eyebrow">Skills · mastery pays</div>
        <div className="pl-skills">
          {CAREER_SKILLS.map((s) => {
            const p = careerProgress(player?.career?.[s]?.xp ?? 0);
            return (
              <div className="pl-skill" key={s}>
                <div className="pl-skill-head">
                  <span className="pl-skill-name">{CAREER_SKILL_LABELS[s]}</span>
                  <span className="pl-skill-lv">
                    Lv {p.level}
                    {p.atMax ? ' · max' : ''} · ×{masteryMult(p.level).toFixed(2)}
                  </span>
                </div>
                <div className="pl-skill-bar">
                  <span style={{ width: `${Math.round(p.pct * 100)}%` }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* --- Flat shifts -------------------------------------------------- */}
        <div className="pl-eyebrow">Shifts · earn ◈</div>
        {worldState && (
          <div className={`pl-energy-readout${noEnergy ? ' is-spent' : ''}`}>
            <span>◆</span>
            <span>
              {worldState.stamina} of {worldState.staminaMax} energy left today
            </span>
          </div>
        )}
        {work.map((a) => {
          const cost = a.staminaCost ?? 1;
          const reqLocked =
            isCareerSkill(a.requiresSkill) && lvl(a.requiresSkill) < (a.requiresLevel ?? 0);
          const cantAfford = stamina < cost;
          const v = a.moneyVariance ?? 0;
          const base = a.money ?? 0;
          const m = masteryMult(lvl(a.skill));
          const loMult = (a.weatherPriced ? 0.85 : 1) * m;
          const hiMult = (a.weatherPriced ? 1.4 : 1) * m;
          const payLabel =
            v > 0 || a.weatherPriced
              ? `◈ ${Math.round(base * loMult * (1 - v))}–${Math.round(base * hiMult * (1 + v))}`
              : `◈ ${Math.round(base * m)}`;
          return (
            <div className={`pl-tile pl-work${reqLocked ? ' is-locked' : ''}`} key={a.id}>
              <div className="pl-tile-icon"><Icon name="work" size={18} /></div>
              <div className="pl-tile-body">
                <div className="pl-tile-label">{a.label}</div>
                <div className="pl-tile-desc">{a.description}</div>
                <div className="pl-work-tags">
                  {isCareerSkill(a.skill) && <span className="pl-work-tag">{skillName(a.skill)}</span>}
                  {v > 0 && <span className="pl-work-tag">pay varies</span>}
                  {a.weatherPriced && <span className="pl-work-tag">☼ weather-priced</span>}
                  {reqLocked && (
                    <span className="pl-work-tag locked">
                      🔒 {skillName(a.requiresSkill)} Lv {a.requiresLevel}
                    </span>
                  )}
                </div>
              </div>
              <div className="pl-tile-action">
                <span className="pl-tile-cost" title={`Costs ${cost} action${cost > 1 ? 's' : ''}`}>
                  −{cost} ◆
                </span>
                <button
                  className="btn sm primary"
                  onClick={() => perform(a)}
                  disabled={busy || cantAfford || onDate || reqLocked}
                  title={
                    reqLocked
                      ? `Locked — reach ${skillName(a.requiresSkill)} level ${a.requiresLevel}.`
                      : cantAfford && !noEnergy
                        ? `Needs ${cost} energy — you have ${stamina} left.`
                        : undefined
                  }
                >
                  <span className="pl-coin">{payLabel}</span>
                </button>
              </div>
            </div>
          );
        })}

        {/* --- Skill work (job minigames) ---------------------------------- */}
        {jobGames.length > 0 && (
          <>
            <div className="pl-eyebrow">Skill work · play to earn</div>
            {jobGames.map((g) => {
              const reqLocked =
                isCareerSkill(g.requiresSkill) && lvl(g.requiresSkill) < (g.requiresLevel ?? 0);
              const potential = Math.min(250, Math.round(100 * masteryMult(lvl(g.skill))));
              return (
                <div className={`pl-tile pl-work pl-job${reqLocked ? ' is-locked' : ''}`} key={g.id}>
                  <div className="pl-tile-icon"><Icon name="games" size={18} /></div>
                  <div className="pl-tile-body">
                    <div className="pl-tile-label">{g.title}</div>
                    <div className="pl-tile-desc">{g.description}</div>
                    <div className="pl-work-tags">
                      {isCareerSkill(g.skill) && (
                        <span className="pl-work-tag">
                          {skillName(g.skill)}
                          {lvl(g.skill) > 0 ? ` Lv ${lvl(g.skill)}` : ''}
                        </span>
                      )}
                      <span className="pl-work-tag">skill-graded</span>
                      {reqLocked && (
                        <span className="pl-work-tag locked">
                          🔒 {skillName(g.requiresSkill)} Lv {g.requiresLevel}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="pl-tile-action">
                    <span className="pl-tile-cost" title="Costs one action">−1 ◆</span>
                    <button
                      className="btn sm primary"
                      onClick={() => startJob(g)}
                      disabled={busy || noEnergy || onDate || reqLocked}
                      title={
                        reqLocked
                          ? `Locked — reach ${skillName(g.requiresSkill)} level ${g.requiresLevel}.`
                          : undefined
                      }
                    >
                      <span className="pl-coin">up to ◈{potential}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
