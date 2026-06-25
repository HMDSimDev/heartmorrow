import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { QuestSceneView, QuestSummaryView, OutcomeGrade, QuestFaction } from '@dsim/shared';
import { useAppData } from '../state/app-context';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { Icon } from '../components/Icon';
import { QuestAuthor } from '../components/wayfarer/QuestEditor';
import './wayfarer.page.css';

/**
 * Wayfarer — the quest tab. A lobby of authored adventures, a live freeform scene
 * loop (type anything; a deterministic referee resolves it), and a resolution
 * card. The server owns every outcome; this screen only renders + sends intent.
 * World-gated by `featureFlags.quests` (the nav tab is hidden when off, but a
 * deep-link still renders the gentle "not enabled" state below).
 */
export function Wayfarer() {
  // The Wayfarer copy uses dynamic keys (quests:grade.${grade}, quests:faction.${f}),
  // which blow up react-i18next's typed `t`. Use the same loose view labels.ts uses.
  const { t: tTyped } = useTranslation(['quests', 'common']);
  const t = tTyped as unknown as TFn;
  const { activeWorldId, activeWorld, creatorMode, dayTick, refreshActiveQuest, reloadPlayer } = useAppData();
  const enabled = !!activeWorld?.featureFlags?.quests;
  const [view, setView] = useState<'play' | 'author'>('play');

  const [lobby, setLobby] = useState<QuestSummaryView[]>([]);
  const [scene, setScene] = useState<QuestSceneView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeWorldId || !enabled) {
      setLoaded(true);
      return;
    }
    try {
      const res = await api.questLobby(activeWorldId);
      setLobby(res.quests);
      setScene(res.active);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoaded(true);
    }
  }, [activeWorldId, enabled]);

  // (Re)load on world change + when the day advances (a new day reopens warmth gates).
  useEffect(() => {
    setLoaded(false);
    void load();
  }, [load, dayTick]);

  const begin = useCallback(
    async (questId: string) => {
      if (!activeWorldId || busy) return;
      setBusy(true);
      setError(null);
      try {
        setScene(await api.startQuest(activeWorldId, questId));
        void refreshActiveQuest();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [activeWorldId, busy, refreshActiveQuest],
  );

  const attempt = useCallback(async () => {
    const text = input.trim();
    if (!activeWorldId || !text || busy) return;
    setBusy(true);
    setError(null);
    setInput('');
    try {
      const next = await api.questTurn(activeWorldId, text);
      setScene(next);
      void refreshActiveQuest();
      // A quest can pay out money / nudge warmth — refresh the wallet.
      void reloadPlayer();
    } catch (e) {
      setError(errorMessage(e));
      setInput(text); // give the player their words back to retry
    } finally {
      setBusy(false);
    }
  }, [activeWorldId, busy, input, refreshActiveQuest, reloadPlayer]);

  const leave = useCallback(async () => {
    if (!activeWorldId) return;
    setBusy(true);
    try {
      await api.abandonQuest(activeWorldId);
    } catch {
      /* ignore — fall through to a reload */
    } finally {
      setScene(null);
      setBusy(false);
      void refreshActiveQuest();
      void load();
    }
  }, [activeWorldId, refreshActiveQuest, load]);

  if (!enabled) {
    return (
      <div className="wf">
        <WayfarerHeader t={t} />
        <div className="card wf-empty">{t('quests:lobby.empty')}</div>
      </div>
    );
  }

  // Creators get a Play / Author toggle; players only ever see Play.
  const modeToggle = creatorMode ? (
    <div className="wf-modes" role="tablist">
      <button role="tab" className={view === 'play' ? 'active' : ''} onClick={() => setView('play')}>
        <Icon name="play" size={13} /> Play
      </button>
      <button role="tab" className={view === 'author' ? 'active' : ''} onClick={() => setView('author')}>
        <Icon name="edit" size={13} /> Author
      </button>
    </div>
  ) : null;

  if (creatorMode && view === 'author') {
    return (
      <div className="wf">
        <WayfarerHeader t={t} />
        {modeToggle}
        {activeWorldId && <QuestAuthor worldId={activeWorldId} />}
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="wf">
        <WayfarerHeader t={t} />
        {modeToggle}
        <div className="wf-loading">{t('quests:loading')}</div>
      </div>
    );
  }
  if (scene && scene.status !== 'active') {
    return <Resolution scene={scene} onDone={leave} busy={busy} t={t} />;
  }
  if (scene) {
    return (
      <Scene
        scene={scene}
        input={input}
        setInput={setInput}
        onAttempt={attempt}
        onLeave={leave}
        busy={busy}
        error={error}
        t={t}
      />
    );
  }
  return <Lobby quests={lobby} onBegin={begin} busy={busy} error={error} t={t} modeToggle={modeToggle} />;
}

/** A loose translator view: dynamic keys + a plain string return (no detailed-result
 *  union), so JSX children and `string` props accept it without deep instantiation. */
type TFn = (key: string, opts?: Record<string, unknown>) => string;

function WayfarerHeader({ t }: { t: TFn }) {
  return (
    <header className="wf-head">
      <h1>
        <Icon name="quest" size={22} /> {t('quests:title')}
      </h1>
      <p className="wf-tagline">{t('quests:tagline')}</p>
    </header>
  );
}

// --- Lobby ------------------------------------------------------------------

function Lobby({
  quests,
  onBegin,
  busy,
  error,
  t,
  modeToggle,
}: {
  quests: QuestSummaryView[];
  onBegin: (id: string) => void;
  busy: boolean;
  error: string | null;
  t: TFn;
  modeToggle?: ReactNode;
}) {
  return (
    <div className="wf">
      <WayfarerHeader t={t} />
      {modeToggle}
      {error && <div className="wf-error" role="alert">{error}</div>}
      {quests.length === 0 ? (
        <div className="card wf-empty">{t('quests:lobby.empty')}</div>
      ) : (
        <div className="wf-grid">
          {quests.map((q) => (
            <article key={q.id} className={`card wf-card${q.eligible ? '' : ' wf-card-locked'}`}>
              <div className="wf-card-body">
                <h2>{q.name}</h2>
                {q.partnerName && (
                  <span className="badge accent wf-partner">
                    <Icon name="affection" size={12} /> {t('quests:lobby.partnerWith', { name: q.partnerName })}
                  </span>
                )}
                <p className="wf-blurb">{q.blurb || t('quests:lobby.blurbFallback')}</p>
              </div>
              <div className="wf-card-foot">
                {q.eligible ? (
                  <button className="btn primary sm" disabled={busy} onClick={() => onBegin(q.id)}>
                    <Icon name="play" size={14} /> {t('quests:lobby.start')}
                  </button>
                ) : (
                  <span className="wf-lock" title={q.lockReason ?? ''}>
                    <Icon name="warn" size={13} /> {q.lockReason ?? t('quests:lobby.locked')}
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Scene (the live loop) --------------------------------------------------

const FACTION_TONE: Record<QuestFaction, string> = {
  party: 'good',
  ally: 'good',
  neutral: '',
  hostile: 'danger',
};

function Scene({
  scene,
  input,
  setInput,
  onAttempt,
  onLeave,
  busy,
  error,
  t,
}: {
  scene: QuestSceneView;
  input: string;
  setInput: (v: string) => void;
  onAttempt: () => void;
  onLeave: () => void;
  busy: boolean;
  error: string | null;
  t: TFn;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [scene.log.length, busy]);

  const objective = useMemo(() => scene.objectives[0] ?? '', [scene.objectives]);

  return (
    <div className="wf wf-scene">
      <header className="wf-scene-head">
        <div className="wf-scene-title">
          <Icon name="quest" size={16} /> <strong>{scene.name}</strong>
        </div>
        <div className="wf-scene-meta">
          {objective && <span className="wf-objective">{t('quests:scene.objective', { label: objective })}</span>}
          <span className="badge wf-turn">{t('quests:scene.turn', { turn: scene.turn, max: scene.maxTurns })}</span>
          <button className="btn ghost sm" onClick={onLeave} disabled={busy}>
            <Icon name="leave" size={14} /> {t('quests:scene.leave')}
          </button>
        </div>
      </header>

      {scene.entities.length > 0 && (
        <div className="wf-entities">
          {scene.entities.map((e) => (
            <span key={e.id} className={`badge ${FACTION_TONE[e.faction]} wf-entity`} title={t(`quests:faction.${e.faction}`)}>
              {e.name || e.id}
              {e.hp != null && <em className="wf-hp">{e.hp}</em>}
            </span>
          ))}
        </div>
      )}

      <div className="wf-reel">
        <div className="wf-setup">{scene.setup}</div>
        {scene.log.map((entry) => (
          <div key={entry.turn} className="wf-beat">
            <div className="wf-msg you">{entry.playerText}</div>
            <div className="wf-msg narrator">
              {entry.narration}
              <span className={`wf-grade wf-grade-${entry.grade}`}>{gradeLabel(entry.grade, t)}</span>
            </div>
          </div>
        ))}
        {busy && (
          <div className="wf-msg narrator wf-thinking">
            <span className="wf-typing"><span /><span /><span /></span> {t('quests:scene.thinking')}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="wf-foot">
        {error && <div className="wf-error" role="alert">{error}</div>}
        {scene.hints.length > 0 && (
          <div className="wf-hints">
            <span className="wf-hints-label">{t('quests:scene.tryHint')}</span>
            {scene.hints.map((h, i) => (
              <button key={i} type="button" className="wf-hint" onClick={() => setInput(h)} disabled={busy}>
                {h}
              </button>
            ))}
          </div>
        )}
        <div className="wf-composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onAttempt();
              }
            }}
            placeholder={t('quests:scene.placeholder')}
            rows={2}
            disabled={busy}
          />
          <button className="btn primary" onClick={onAttempt} disabled={busy || !input.trim()}>
            <Icon name="send" size={16} /> {t('quests:scene.send')}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Resolution -------------------------------------------------------------

function Resolution({ scene, onDone, busy, t }: { scene: QuestSceneView; onDone: () => void; busy: boolean; t: TFn }) {
  const res = scene.resolution;
  const win = res?.outcome === 'win';
  return (
    <div className="wf wf-resolve">
      <div className={`card wf-resolve-card ${win ? 'win' : 'lose'}`}>
        <div className="wf-resolve-glyph">
          <Icon name={win ? 'trophy' : 'moon'} size={34} />
        </div>
        <h1>{win ? t('quests:resolution.win') : t('quests:resolution.lose')}</h1>
        <p className="wf-resolve-label">{res?.label}</p>
        <div className="wf-resolve-stats">
          {!!res?.moneyEarned && <span className="badge warn">{t('quests:resolution.money', { amount: res.moneyEarned })}</span>}
          {!!res?.warmthChange && <span className="badge accent">{t('quests:resolution.warmth', { amount: res.warmthChange })}</span>}
        </div>
        <button className="btn primary lg" onClick={onDone} disabled={busy}>
          {win ? t('quests:resolution.ackWin') : t('quests:resolution.ackLose')}
        </button>
      </div>
    </div>
  );
}

function gradeLabel(grade: OutcomeGrade, t: TFn): string {
  return t(`quests:grade.${grade}`);
}
