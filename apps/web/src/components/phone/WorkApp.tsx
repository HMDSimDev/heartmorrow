import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CAREER,
  CAREER_SKILLS,
  HARSH_WEATHER,
  PLEASANT_WEATHER,
  careerProgress,
  isCareerSkill,
  masteryMult,
  type ActivityDef,
  type DayWeather,
  type MinigameInfo,
  type MinigameSubmission,
} from '@dsim/shared';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import { careerSkillBlurb, careerSkillLabel, phaseLabel, weatherLabel } from '../../i18n/labels';
import { Icon, type IconName } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { ResultCard, ResultPill, type ResultTone } from '../ResultCard';
import { Banner } from '../ui';
import { GameView, type ActiveGame } from '../minigames/GameView';
import './phone-life.css';

/** A resolved work outcome, rendered as a keepsake ResultCard. Activities set a
 *  title/summary; a finished shift sets a grade pill + a score/earnings ledger. */
type WorkNote = {
  tone: ResultTone;
  seal: string;
  kicker: string;
  title?: string;
  summary?: string;
  pill?: string;
  ledger?: Array<{ icon?: IconName; text: string; tone?: 'up' | 'down' }>;
};

type WorkTab = 'board' | 'trades';

/** Mirror of the server's weather-priced pay multipliers (activity-service) —
 *  display-only, used to sharpen a weather-priced tile's range to TODAY's sky. */
const HARSH_PAY = 1.4;
const PLEASANT_PAY = 0.85;

export function WorkApp() {
  const { t } = useTranslation(['phone', 'common']);
  const { activeWorldId, reloadPlayer, refreshWorldState, worldState, dayTick, activeDate, player } = useAppData();
  const [activities, setActivities] = useState<ActivityDef[]>([]);
  const [jobGames, setJobGames] = useState<MinigameInfo[]>([]);
  const [weather, setWeather] = useState<DayWeather | null>(null);
  const [tab, setTab] = useState<WorkTab>('board');
  const [active, setActive] = useState<ActiveGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<WorkNote | null>(null);
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
    // Today's sky, so the plate can price the day (weather-priced day labor).
    if (activeWorldId) {
      api.worldWeather(activeWorldId).then((w) => setWeather(w.today)).catch(() => setWeather(null));
    } else {
      setWeather(null);
    }
  }, [dayTick, activeWorldId]);

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
  const skillName = (skill?: string): string => (skill && isCareerSkill(skill) ? careerSkillLabel(skill) : '');

  const perform = async (a: ActivityDef) => {
    if (!activeWorldId) {
      setError(t('work.errWorld'));
      return;
    }
    if (onDate) {
      setError(
        t(activeDate!.mode === 'hangout' ? 'work.errOnHangout' : 'work.errOnDate', { name: activeDate!.characterName }),
      );
      return;
    }
    setBusy(true);
    setNote(null);
    setError(undefined);
    try {
      const res = await api.performActivity({ activityId: a.id, worldId: activeWorldId, characterId: null });
      await Promise.all([reloadPlayer(), refreshWorldState()]);
      // Narrow the skill here (not via a boolean) so careerSkillLabel keeps its type.
      const leveledSkill = res.skillLeveledUp && isCareerSkill(res.skill) ? res.skill : null;
      setNote({
        tone: leveledSkill ? 'sage' : 'brass',
        seal: leveledSkill ? '✦' : '◈',
        kicker: leveledSkill ? t('work.levelKicker') : t('work.doneKicker'),
        title: leveledSkill ? t('work.leveledTitle', { skill: careerSkillLabel(leveledSkill), level: res.skillLevel }) : undefined,
        summary: t('work.earned', { lifted: '', money: res.money, day: res.state.day, phase: phaseLabel(res.state.phase) }),
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const startJob = async (g: MinigameInfo) => {
    if (!activeWorldId) {
      setError(t('work.errWorld'));
      return;
    }
    if (onDate) {
      setError(
        t(activeDate!.mode === 'hangout' ? 'work.errOnHangout' : 'work.errOnDate', { name: activeDate!.characterName }),
      );
      return;
    }
    setBusy(true);
    setNote(null);
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
      const title = jobGames.find((g) => g.id === active.minigameId)?.title ?? t('work.shiftFallback');
      const res = await api.finishMinigame({ runId: active.runId, submission });
      setActive(null);
      await Promise.all([reloadPlayer(), refreshWorldState()]);
      const r = res.result;
      // Tone the keepsake by grade: S–B glows sage, C is neutral brass, D–F reads ember.
      const tone: ResultTone =
        r.grade === 'S' || r.grade === 'A' || r.grade === 'B' ? 'sage' : r.grade === 'C' ? 'brass' : 'ember';
      setNote({
        tone,
        seal: tone === 'ember' ? '⚠' : '✦',
        kicker: t('work.shiftKicker'),
        title,
        pill: t('work.gradePill', { grade: r.grade }),
        ledger: [
          { text: t('work.scoreChip', { score: r.score }) },
          r.reward.money > 0
            ? { icon: 'coin', text: `◈${r.reward.money}`, tone: 'up' }
            : { text: t('work.noPay') },
        ],
      });
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
        <PhoneAppBar title={t('work.title')} kicker={t('work.onShift')} icon="work" />
        <div className="phone-embed pl-work-embed">
          <div className="pl-job-stage-head">
            <span className="pl-eyebrow">{t('work.onShiftHead', { title: jobGames.find((g) => g.id === active.minigameId)?.title ?? '' })}</span>
            <button className="btn sm ghost danger" onClick={() => setActive(null)} disabled={busy}>
              {t('work.quit')}
            </button>
          </div>
          <GameView active={active} partner={null} onComplete={finishJob} />
        </div>
      </div>
    );
  }

  const work = activities.filter((a) => a.kind === 'work');

  // The plate's sky line prices the day for weather-priced work.
  const skyLine = weather
    ? HARSH_WEATHER.includes(weather.kind)
      ? t('work.weatherPremium', { icon: weather.icon, label: weatherLabel(weather.kind) })
      : PLEASANT_WEATHER.includes(weather.kind)
        ? t('work.weatherThin', { icon: weather.icon, label: weatherLabel(weather.kind) })
        : t('work.weatherPlain', { icon: weather.icon, label: weatherLabel(weather.kind) })
    : null;

  /** Jobs that feed a trade, for the trade card's "earned at" line. */
  const jobsFor = (s: string): string[] => [
    ...work.filter((a) => a.skill === s).map((a) => a.label),
    ...jobGames.filter((g) => g.skill === s).map((g) => g.title),
  ];

  return (
    <div className="phone-app">
      <PhoneAppBar title={t('work.title')} kicker={t('work.daysShifts')} icon="work" />
      <div className="phone-embed pl-work-embed">
        {(note || error) && (
          <div className="pl-work-banner">
            {note && (
              <ResultCard
                tone={note.tone}
                seal={note.seal}
                kicker={note.kicker}
                title={note.title}
                summary={note.summary}
                aside={note.pill ? <ResultPill>{note.pill}</ResultPill> : undefined}
                ledger={
                  note.ledger?.length
                    ? note.ledger.map((c, i) => (
                        <span key={i} className={`result-stat${c.tone ? ` ${c.tone}` : ''}`}>
                          {c.icon && <Icon name={c.icon} size={12} />} {c.text}
                        </span>
                      ))
                    : undefined
                }
              />
            )}
            {error && <Banner kind="error">{error}</Banner>}
          </div>
        )}

        {/* The day plate: the app's masthead — today's postings, the energy left to
            spend on them, and the sky pricing the outdoor work. */}
        <div className="pl-board">
          <div className="pl-plate-top">
            <div className="pl-board-title">{t('work.plateTitle')}</div>
            {worldState && (
              <span
                className={`pl-plate-energy${noEnergy ? ' is-spent' : ''}`}
                title={t('work.energyLeft', { stamina, max: worldState.staminaMax })}
              >
                <span className="pl-pips" aria-hidden>
                  {Array.from({ length: worldState.staminaMax }, (_, i) => (
                    <span key={i} className={`pl-pip${i < stamina ? ' on' : ''}`}>◆</span>
                  ))}
                </span>
                {stamina}/{worldState.staminaMax}
              </span>
            )}
          </div>
          {skyLine && <div className="pl-board-sub">{skyLine}</div>}
        </div>

        <div className="pl-tabs" role="tablist">
          <button
            className={`pl-tab${tab === 'board' ? ' active' : ''}`}
            role="tab"
            aria-selected={tab === 'board'}
            onClick={() => setTab('board')}
          >
            <Icon name="work" size={14} /> {t('work.tabBoard')}
          </button>
          <button
            className={`pl-tab${tab === 'trades' ? ' active' : ''}`}
            role="tab"
            aria-selected={tab === 'trades'}
            onClick={() => setTab('trades')}
          >
            <Icon name="trophy" size={14} /> {t('work.tabTrades')}
          </button>
        </div>

        {tab === 'board' && (
          <>
            {/* Locks live outside the postings so a temporary block never reads as
                more house rules. Date first — it outranks energy as the reason. */}
            {onDate && (
              <div className="pl-lock">
                <span className="pl-lock-glyph"><Icon name="date" size={15} /></span>
                <span>
                  {t(activeDate!.mode === 'hangout' ? 'work.onHangoutNote' : 'work.onDateNote', {
                    name: activeDate!.characterName,
                  })}
                </span>
              </div>
            )}
            {noEnergy && !onDate && (
              <div className="pl-lock is-rest">
                <span className="pl-lock-glyph"><Icon name="moon" size={15} /></span>
                <span>{t('work.noEnergy')}</span>
              </div>
            )}

            {/* --- Flat shifts ---------------------------------------------- */}
            <div className="pl-eyebrow">{t('work.shiftsHead')}</div>
            {work.map((a) => {
              const cost = a.staminaCost ?? 1;
              const reqLocked =
                isCareerSkill(a.requiresSkill) && lvl(a.requiresSkill) < (a.requiresLevel ?? 0);
              const cantAfford = stamina < cost;
              const v = a.moneyVariance ?? 0;
              const base = a.money ?? 0;
              const m = masteryMult(lvl(a.skill));
              // With today's sky known, a weather-priced range collapses to today's
              // actual band (mirror of the server's harsh/pleasant multipliers).
              const todayW =
                a.weatherPriced && weather
                  ? HARSH_WEATHER.includes(weather.kind)
                    ? HARSH_PAY
                    : PLEASANT_WEATHER.includes(weather.kind)
                      ? PLEASANT_PAY
                      : 1
                  : null;
              const loMult = (todayW ?? (a.weatherPriced ? PLEASANT_PAY : 1)) * m;
              const hiMult = (todayW ?? (a.weatherPriced ? HARSH_PAY : 1)) * m;
              const cap = (n: number) => Math.min(CAREER.ABSOLUTE_MAX_PAY, Math.round(n));
              const payLabel =
                v > 0 || a.weatherPriced
                  ? `◈ ${cap(base * loMult * (1 - v))}–${cap(base * hiMult * (1 + v))}`
                  : `◈ ${cap(base * m)}`;
              return (
                <div className={`pl-tile pl-work${reqLocked ? ' is-locked' : ''}`} key={a.id}>
                  <div className="pl-tile-icon">
                    {a.icon ? <span className="pl-tile-glyph">{a.icon}</span> : <Icon name="work" size={18} />}
                  </div>
                  <div className="pl-tile-body">
                    <div className="pl-tile-label">{a.label}</div>
                    <div className="pl-tile-desc">{a.description}</div>
                    <div className="pl-work-tags">
                      {isCareerSkill(a.skill) && <span className="pl-work-tag">{skillName(a.skill)}</span>}
                      {v > 0 && <span className="pl-work-tag">{t('work.payVaries')}</span>}
                      {a.weatherPriced && <span className="pl-work-tag">{t('work.weatherPriced')}</span>}
                      {reqLocked && (
                        <span className="pl-work-tag locked">
                          {t('work.lockedTag', { skill: skillName(a.requiresSkill), level: a.requiresLevel })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="pl-tile-action">
                    <span className="pl-tile-cost" title={t('work.costTitle', { count: cost })}>
                      −{cost} ◆
                    </span>
                    <button
                      className="btn sm primary"
                      onClick={() => perform(a)}
                      disabled={busy || cantAfford || onDate || reqLocked}
                      title={
                        reqLocked
                          ? t('work.lockedTitle', { skill: skillName(a.requiresSkill), level: a.requiresLevel })
                          : cantAfford && !noEnergy
                            ? t('work.needEnergyTitle', { cost, stamina })
                            : undefined
                      }
                    >
                      <span className="pl-coin">{payLabel}</span>
                    </button>
                  </div>
                </div>
              );
            })}

            {/* --- Skill work (job minigames) ------------------------------- */}
            {jobGames.length > 0 && (
              <>
                <div className="pl-eyebrow">{t('work.skillWorkHead')}</div>
                {jobGames.map((g) => {
                  const reqLocked =
                    isCareerSkill(g.requiresSkill) && lvl(g.requiresSkill) < (g.requiresLevel ?? 0);
                  const potential = Math.min(CAREER.ABSOLUTE_MAX_PAY, Math.round(100 * masteryMult(lvl(g.skill))));
                  return (
                    <div className={`pl-tile pl-work pl-job${reqLocked ? ' is-locked' : ''}`} key={g.id}>
                      <div className="pl-tile-icon">
                        {g.glyph ? <span className="pl-tile-glyph">{g.glyph}</span> : <Icon name="games" size={18} />}
                      </div>
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
                          <span className="pl-work-tag">{t('work.skillGraded')}</span>
                          {reqLocked && (
                            <span className="pl-work-tag locked">
                              {t('work.lockedTag', { skill: skillName(g.requiresSkill), level: g.requiresLevel })}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="pl-tile-action">
                        <span className="pl-tile-cost" title={t('work.costOneTitle')}>−1 ◆</span>
                        <button
                          className="btn sm primary"
                          onClick={() => startJob(g)}
                          disabled={busy || noEnergy || onDate || reqLocked}
                          title={
                            reqLocked
                              ? t('work.lockedTitle', { skill: skillName(g.requiresSkill), level: g.requiresLevel })
                              : undefined
                          }
                        >
                          <span className="pl-coin">{t('work.upTo', { potential })}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}

        {tab === 'trades' && (
          <>
            <div className="pl-eyebrow">{t('work.skillsHead')}</div>
            <div className="pl-trades">
              {CAREER_SKILLS.map((s) => {
                const p = careerProgress(player?.career?.[s]?.xp ?? 0);
                const jobs = jobsFor(s);
                return (
                  <div className={`pl-skill pl-trade${p.xp === 0 ? ' is-untouched' : ''}`} key={s}>
                    <div className="pl-skill-head">
                      <span className="pl-skill-name">{careerSkillLabel(s)}</span>
                      <span className="pl-skill-lv">
                        {t('work.level', { level: p.level })}
                        {p.atMax ? t('work.maxSuffix') : ''} · ×{masteryMult(p.level).toFixed(2)}
                      </span>
                    </div>
                    <div className="pl-trade-blurb">{careerSkillBlurb(s)}</div>
                    {/* One segment per level, not one continuous bar — the ceiling is
                        part of the information, and a single bar hid how far Lv 5 is. */}
                    <div
                      className="pl-skill-bar"
                      title={
                        p.atMax
                          ? t('work.xpMax')
                          : t('work.xpInto', { into: p.intoLevel, span: p.span, next: p.level + 1 })
                      }
                    >
                      {Array.from({ length: CAREER.MAX_LEVEL }, (_, i) => (
                        <span key={i} className={`pl-skill-seg${i < p.level ? ' is-done' : ''}`}>
                          {i === p.level && !p.atMax && <i style={{ width: `${Math.round(p.pct * 100)}%` }} />}
                        </span>
                      ))}
                    </div>
                    {jobs.length > 0 && (
                      <div className="pl-trade-jobs">{t('work.earnedAt', { jobs: jobs.join(' · ') })}</div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="pl-trades-note">{t('work.boardNote')}</p>
          </>
        )}
      </div>
    </div>
  );
}
