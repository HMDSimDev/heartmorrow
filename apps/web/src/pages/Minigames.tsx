import { useEffect, useRef, useState } from 'react';
import {
  LoreQuizConfigSchema,
  MemoryMatchConfigSchema,
  TimingMeterConfigSchema,
  SweetAndSourConfigSchema,
  TwoTruthsConfigSchema,
  RhythmSerenadeConfigSchema,
  type Character,
  type LoreQuizSubmission,
  type MemoryMatchSubmission,
  type MinigameFinishResponse,
  type MinigameId,
  type MinigameInfo,
  type MinigameSubmission,
  type RhythmSerenadeSubmission,
  type SweetAndSourSubmission,
  type TimingMeterSubmission,
  type TwoTruthsSubmission,
  RELATIONSHIP_STAT_LABELS,
  DATING_STAT_LABELS,
} from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { Banner, Empty, Modal, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PortraitPicker } from '../components/PortraitPicker';
import { MemoryMatchGame } from '../components/minigames/MemoryMatchGame';
import { TimingMeterGame } from '../components/minigames/TimingMeterGame';
import { LoreQuizGame } from '../components/minigames/LoreQuizGame';
import { SweetAndSourGame } from '../components/minigames/SweetAndSourGame';
import { TwoTruthsGame } from '../components/minigames/TwoTruthsGame';
import { RhythmSerenade } from '../components/minigames/RhythmSerenade';
import './minigames.page.css';

interface ActiveGame {
  minigameId: MinigameId;
  runId: string;
  config: unknown;
}

export function Minigames() {
  const { reloadPlayer, refreshWorldState, activeWorldId, worldState, dayTick, activeDate } = useAppData();
  const [games, setGames] = useState<MinigameInfo[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveGame | null>(null);
  const [result, setResult] = useState<MinigameFinishResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Synchronous re-entrancy guard: a single run can only be finished once, even
  // if a game component fires onComplete twice before `busy` state commits.
  const finishingRef = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        const [g, c] = await Promise.all([api.listMinigames(), api.listCharacters(activeWorldId ?? undefined)]);
        setGames(g);
        setCharacters(c);
        // Keep a still-valid partner across a day change; re-pick when the
        // current one isn't in the (possibly switched) world's roster.
        const inWorld = c.filter((x) => !activeWorldId || x.worldId === activeWorldId);
        setCharacterId((cur) => (cur && inWorld.some((x) => x.id === cur) ? cur : inWorld[0]?.id ?? null));
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [activeWorldId, dayTick]);

  // A world switch must not leave a previous world's run on screen — its reward
  // would reconcile into world A while the HUD reloads world B's wallet. Drop the
  // in-flight run back to the cabinet list when the active world changes.
  const lastWorldRef = useRef(activeWorldId);
  useEffect(() => {
    if (lastWorldRef.current === activeWorldId) return;
    lastWorldRef.current = activeWorldId;
    setActive(null);
    setResult(null);
    finishingRef.current = false;
  }, [activeWorldId]);

  const start = async (minigameId: MinigameId) => {
    if (activeDate) {
      setError(`You're on a date with ${activeDate.characterName} — finish it on the Date tab first.`);
      return;
    }
    setBusy(true);
    setError(undefined);
    setResult(null);
    try {
      const res = await api.startMinigame({ minigameId, characterId: characterId || null, worldId: activeWorldId ?? null });
      setActive({ minigameId, runId: res.runId, config: res.config });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async (submission: MinigameSubmission) => {
    if (!active || finishingRef.current) return;
    finishingRef.current = true;
    setBusy(true);
    try {
      const res = await api.finishMinigame({ runId: active.runId, submission });
      setResult(res);
      setActive(null);
      await reloadPlayer();
      await refreshWorldState();
    } catch (e) {
      setError(errorMessage(e));
      setActive(null);
    } finally {
      setBusy(false);
      finishingRef.current = false;
    }
  };

  if (loading) return <Spinner />;

  const visibleChars = characters.filter((c) => !activeWorldId || c.worldId === activeWorldId);
  const partner = visibleChars.find((c) => c.id === characterId) ?? null;
  // Minigames cost a daily action when tied to a world; gate Play at 0 energy
  // instead of letting the start 400 server-side.
  const outOfEnergy = !!activeWorldId && (worldState?.stamina ?? 0) <= 0;
  // Minigames are their own outing — not something you slip away to mid-date.
  const onDate = !!activeDate;

  return (
    <div className="stack">
      <div className="page-head">
        <span className="kicker">The Arcade Almanac</span>
        <h1>Minigames</h1>
        <p>Play together to grow closer — and earn a little money.</p>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {outOfEnergy && !active && (
        <Banner kind="info">You're out of energy for today — end the day to play again tomorrow.</Banner>
      )}
      {onDate && !active && (
        <Banner kind="info">
          You're on a date with {activeDate!.characterName} — finish it on the Date tab before playing.
        </Banner>
      )}

      {result && (
        <Modal onClose={() => setResult(null)}>
          <ResultCard result={result} onClose={() => setResult(null)} />
        </Modal>
      )}

      {characters.length > 0 && !active && (
        <div className="card mga-console">
          <span className="kicker">Playing with</span>
          <PortraitPicker
            options={visibleChars.map((c) => ({ id: c.id, character: c }))}
            value={characterId}
            onChange={(id) => setCharacterId(id)}
            none={{ label: 'No one', sub: 'money only' }}
            compact
          />
        </div>
      )}

      {busy && !active && (
        <div className="mga-starting">
          <Spinner />
        </div>
      )}

      {active ? (
        <div className="framed mga-active">
          <div className="mga-stage-head">
            <div className="mga-stage-title">
              <span className="kicker">Now playing</span>
              <h2>{games.find((g) => g.id === active.minigameId)?.title}</h2>
            </div>
            <button className="btn sm ghost danger" onClick={() => setActive(null)} disabled={busy}>
              Quit
            </button>
          </div>
          <GameView active={active} partner={partner} onComplete={finish} />
        </div>
      ) : games.length === 0 ? (
        <Empty icon={<Icon name="games" size={32} />} title="No minigames registered" />
      ) : (
        <div className="mga-grid">
          {games.map((g, i) => (
            <div className="mga-cabinet" key={g.id}>
              <div className="mga-marquee">
                <span className="mga-no">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="mga-title">{g.title}</h3>
                {g.rewardsCharacter && (
                  <span className="mga-heart" title="Builds your bond">
                    <Icon name="date" size={13} />
                  </span>
                )}
              </div>
              <p className="mga-desc">{g.description}</p>
              {g.targetStats.length > 0 && (
                <div className="mga-stats">
                  <span className="mga-stats-label">Builds</span>
                  {g.targetStats.map((s) => (
                    <span className="mga-stat" key={s}>
                      {s}
                    </span>
                  ))}
                </div>
              )}
              <button
                className="btn primary block"
                onClick={() => start(g.id)}
                disabled={busy || outOfEnergy || onDate}
                title={
                  onDate
                    ? `Finish your date with ${activeDate!.characterName} first.`
                    : outOfEnergy
                      ? 'Out of energy — end the day to begin a new one.'
                      : undefined
                }
              >
                <Icon name="play" size={14} /> Play
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GameView({
  active,
  partner,
  onComplete,
}: {
  active: ActiveGame;
  partner: Character | null;
  onComplete: (s: MinigameSubmission) => void;
}) {
  switch (active.minigameId) {
    case 'memory_match':
      return (
        <MemoryMatchGame
          config={MemoryMatchConfigSchema.parse(active.config)}
          onComplete={(submission: MemoryMatchSubmission) => onComplete({ minigameId: 'memory_match', submission })}
        />
      );
    case 'timing_meter':
      return (
        <TimingMeterGame
          config={TimingMeterConfigSchema.parse(active.config)}
          onComplete={(submission: TimingMeterSubmission) => onComplete({ minigameId: 'timing_meter', submission })}
        />
      );
    case 'lore_quiz':
      return (
        <LoreQuizGame
          config={LoreQuizConfigSchema.parse(active.config)}
          partner={partner ?? undefined}
          onComplete={(submission: LoreQuizSubmission) => onComplete({ minigameId: 'lore_quiz', submission })}
        />
      );
    case 'sweet_and_sour':
      return (
        <SweetAndSourGame
          config={SweetAndSourConfigSchema.parse(active.config)}
          onComplete={(submission: SweetAndSourSubmission) => onComplete({ minigameId: 'sweet_and_sour', submission })}
        />
      );
    case 'two_truths_a_lie':
      return (
        <TwoTruthsGame
          config={TwoTruthsConfigSchema.parse(active.config)}
          onComplete={(submission: TwoTruthsSubmission) => onComplete({ minigameId: 'two_truths_a_lie', submission })}
        />
      );
    case 'rhythm_serenade':
      return (
        <RhythmSerenade
          config={RhythmSerenadeConfigSchema.parse(active.config)}
          onComplete={(submission: RhythmSerenadeSubmission) => onComplete({ minigameId: 'rhythm_serenade', submission })}
        />
      );
    default:
      return null;
  }
}

function ResultCard({ result, onClose }: { result: MinigameFinishResponse; onClose: () => void }) {
  const { reward, score, grade } = result.result;
  const { reaction, milestone, isNewBest } = result;
  const datingEntries = Object.entries(reward.dating) as [string, number][];
  const relEntries = Object.entries(reward.relationship) as [string, number][];
  const noRewards = datingEntries.length === 0 && relEntries.length === 0 && reward.money === 0;

  const statLabel = (key: string, kind: 'dating' | 'rel') => {
    if (kind === 'rel') return RELATIONSHIP_STAT_LABELS[key as keyof typeof RELATIONSHIP_STAT_LABELS] ?? key;
    return DATING_STAT_LABELS[key as keyof typeof DATING_STAT_LABELS] ?? key;
  };

  return (
    <div className="mga-result-modal">
      <div className="mga-result-head">
        <div className="mga-grade">
          <span className={`mga-grade-badge grade-${grade}`}>{grade}</span>
          <div className="mga-score">
            <span className="kicker">Final score</span>
            <span className="num">{score}</span>
            <span className="lbl">points</span>
          </div>
        </div>
        <button className="btn sm ghost" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>

      {isNewBest && (
        <div className="mga-best-ribbon">
          <Icon name="trophy" size={14} /> New personal best!
        </div>
      )}

      {reaction && (
        <blockquote className={`mga-reaction tone-${reaction.tone}`}>{reaction.line}</blockquote>
      )}

      {milestone && (
        <div className="mga-milestone">
          <Icon name="date" size={15} /> <strong>You grew closer — you're {milestone.label}!</strong> {milestone.line}
        </div>
      )}

      <p className="mga-reward-label">
        Rewards {result.playedFavorite && <span className="mga-fav-note">· their favorite kind of game</span>}
      </p>
      <div className="tags">
        {datingEntries.map(([k, v]) => (
          <span className={`badge ${v >= 0 ? 'accent' : 'danger'}`} key={`d-${k}`}>
            {v >= 0 ? '+' : ''}
            {v} {statLabel(k, 'dating')}
          </span>
        ))}
        {relEntries.map(([k, v]) => (
          <span className={`badge ${v >= 0 ? 'good' : 'danger'}`} key={`r-${k}`}>
            {v >= 0 ? '+' : ''}
            {v} {statLabel(k, 'rel')}
          </span>
        ))}
        {reward.money > 0 && (
          <span className="money-pill">
            <Icon name="coin" size={13} /> +{reward.money}
          </span>
        )}
        {noRewards && (
          <span className="muted">Nothing earned this time — but you played beautifully.</span>
        )}
      </div>
    </div>
  );
}
