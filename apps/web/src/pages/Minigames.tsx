import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type Character,
  type MinigameFinishResponse,
  type MinigameId,
  type MinigameInfo,
  type MinigameSubmission,
} from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { datingStatLabel, relationshipStatLabel } from '../i18n/labels';
import { Banner, Empty, Modal, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PortraitPicker } from '../components/PortraitPicker';
import { GameView, type ActiveGame } from '../components/minigames/GameView';
import './minigames.page.css';

export function Minigames() {
  const { t } = useTranslation(['pages', 'common']);
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
        // Job games (paid skill work) live in the Work app, not the dating arcade.
        setGames(g.filter((x) => x.mode !== 'job'));
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
      setError(t('minigames.errOnDate', { name: activeDate.characterName }));
      return;
    }
    setBusy(true);
    setError(undefined);
    setResult(null);
    try {
      // A money-only job (no bond reward) is impersonal — never tie it to the
      // selected partner, even though the picker stays on screen for the bonding games.
      const info = games.find((g) => g.id === minigameId);
      const cid = info && !info.rewardsCharacter ? null : characterId || null;
      const res = await api.startMinigame({ minigameId, characterId: cid, worldId: activeWorldId ?? null });
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
        <span className="kicker">{t('minigames.kicker')}</span>
        <h1>{t('minigames.title')}</h1>
        <p>{t('minigames.blurb')}</p>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {outOfEnergy && !active && (
        <Banner kind="info">{t('minigames.outOfEnergy')}</Banner>
      )}
      {onDate && !active && (
        <Banner kind="info">
          {t('minigames.onDateBanner', { name: activeDate!.characterName })}
        </Banner>
      )}

      {result && (
        <Modal onClose={() => setResult(null)}>
          <ResultCard result={result} onClose={() => setResult(null)} />
        </Modal>
      )}

      {characters.length > 0 && !active && (
        <div className="card mga-console">
          <span className="kicker">{t('minigames.playingWith')}</span>
          <PortraitPicker
            options={visibleChars.map((c) => ({ id: c.id, character: c }))}
            value={characterId}
            onChange={(id) => setCharacterId(id)}
            none={{ label: t('minigames.noOne'), sub: t('minigames.moneyOnly') }}
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
              <span className="kicker">{t('minigames.nowPlaying')}</span>
              <h2>{games.find((g) => g.id === active.minigameId)?.title}</h2>
            </div>
            <button className="btn sm ghost danger" onClick={() => setActive(null)} disabled={busy}>
              {t('minigames.quit')}
            </button>
          </div>
          <GameView active={active} partner={partner} onComplete={finish} />
        </div>
      ) : games.length === 0 ? (
        <Empty icon={<Icon name="games" size={32} />} title={t('minigames.noGames')} />
      ) : (
        <div className="mga-grid">
          {games.map((g, i) => (
            <div className="mga-cabinet" key={g.id}>
              <div className="mga-marquee">
                <span className="mga-no">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="mga-title">{g.title}</h3>
                {g.rewardsCharacter && (
                  <span className="mga-heart" title={t('minigames.buildsBond')}>
                    <Icon name="date" size={13} />
                  </span>
                )}
              </div>
              <p className="mga-desc">{g.description}</p>
              {g.targetStats.length > 0 && (
                <div className="mga-stats">
                  <span className="mga-stats-label">{t('minigames.builds')}</span>
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
                    ? t('minigames.finishDateFirst', { name: activeDate!.characterName })
                    : outOfEnergy
                      ? t('minigames.outOfEnergyTitle')
                      : undefined
                }
              >
                <Icon name="play" size={14} /> {t('minigames.play')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ResultCard({ result, onClose }: { result: MinigameFinishResponse; onClose: () => void }) {
  const { t } = useTranslation(['pages', 'common']);
  const { reward, score, grade } = result.result;
  const { reaction, milestone, isNewBest } = result;
  const datingEntries = Object.entries(reward.dating) as [string, number][];
  const relEntries = Object.entries(reward.relationship) as [string, number][];
  const noRewards = datingEntries.length === 0 && relEntries.length === 0 && reward.money === 0;

  const statLabel = (key: string, kind: 'dating' | 'rel') =>
    kind === 'rel' ? relationshipStatLabel(key) : datingStatLabel(key);

  return (
    <div className="mga-result-modal">
      <div className="mga-result-head">
        <div className="mga-grade">
          <span className={`mga-grade-badge grade-${grade}`}>{grade}</span>
          <div className="mga-score">
            <span className="kicker">{t('minigames.finalScore')}</span>
            <span className="num">{score}</span>
            <span className="lbl">{t('minigames.points')}</span>
          </div>
        </div>
        <button className="btn sm ghost" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>

      {isNewBest && (
        <div className="mga-best-ribbon">
          <Icon name="trophy" size={14} /> {t('minigames.newBest')}
        </div>
      )}

      {reaction && (
        <blockquote className={`mga-reaction tone-${reaction.tone}`}>{reaction.line}</blockquote>
      )}

      {milestone && (
        <div className="mga-milestone">
          <Icon name="date" size={15} /> <strong>{t('minigames.grewCloser', { label: milestone.label })}</strong> {milestone.line}
        </div>
      )}

      <p className="mga-reward-label">
        {t('minigames.rewards')} {result.playedFavorite && <span className="mga-fav-note">{t('minigames.favoriteNote')}</span>}
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
          <span className="muted">{t('minigames.noRewards')}</span>
        )}
      </div>
    </div>
  );
}
