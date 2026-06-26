import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { QuestSceneView, QuestSummaryView, OutcomeGrade, QuestFaction } from '@dsim/shared';
import { useAppData } from '../state/app-context';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { Icon } from '../components/Icon';
import { ConfirmDialog } from '../components/ui';
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
  // The player's just-submitted line, echoed optimistically while the turn resolves
  // (so you see what you said immediately, not only after the server round-trip).
  const [pending, setPending] = useState<string | null>(null);
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
    setPending(text); // echo it in the reel right away
    try {
      const next = await api.questTurn(activeWorldId, text);
      setScene(next); // the server log now holds the real beat
      setPending(null);
      void refreshActiveQuest();
      // A quest can pay out money / nudge warmth — refresh the wallet.
      void reloadPlayer();
    } catch (e) {
      setError(errorMessage(e));
      setPending(null);
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
      setPending(null);
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
  if (scene) {
    return (
      <Scene
        scene={scene}
        input={input}
        setInput={setInput}
        onAttempt={attempt}
        onLeave={leave}
        busy={busy}
        pending={pending}
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
      <span className="wf-head-mark" aria-hidden>
        <Icon name="quest" size={24} />
      </span>
      <div className="wf-head-titles">
        <h1>{t('quests:title')}</h1>
        <p className="wf-tagline">{t('quests:tagline')}</p>
      </div>
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
        <div className="card wf-empty">
          <span className="wf-empty-mark" aria-hidden><Icon name="quest" size={30} /></span>
          <p>{t('quests:lobby.empty')}</p>
        </div>
      ) : (
        <>
          <div className="wf-lobby-head">
            <span className="kicker">{t('quests:lobby.available')}</span>
            <span className="wf-lobby-count">{quests.length}</span>
            <span className="wf-lobby-rule" aria-hidden />
          </div>
          <div className="wf-grid">
            {quests.map((q) => {
              const romance = !!q.partnerId;
              return (
                <article
                  key={q.id}
                  className={`card wf-card${q.eligible ? '' : ' wf-card-locked'}${romance ? ' wf-card-romance' : ''}`}
                >
                  <span className="wf-card-seal" aria-hidden>
                    <Icon name={romance ? 'affection' : 'quest'} size={96} />
                  </span>
                  <div className="wf-card-body">
                    <span className="wf-card-kicker">
                      <Icon name={romance ? 'affection' : 'quest'} size={11} />
                      {romance ? t('quests:lobby.romance') : t('quests:lobby.adventure')}
                    </span>
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
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// --- Scene (the live loop) --------------------------------------------------

const FACTION_CLASS: Record<QuestFaction, string> = {
  party: 'wf-fac-party',
  ally: 'wf-fac-ally',
  neutral: 'wf-fac-neutral',
  hostile: 'wf-fac-hostile',
};

function Scene({
  scene,
  input,
  setInput,
  onAttempt,
  onLeave,
  busy,
  pending,
  error,
  t,
}: {
  scene: QuestSceneView;
  input: string;
  setInput: (v: string) => void;
  onAttempt: () => void;
  onLeave: () => void;
  busy: boolean;
  pending: string | null;
  error: string | null;
  t: TFn;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const resolved = scene.status !== 'active';
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [scene.log.length, pending, resolved]);
  // Refocus the composer after a turn resolves (disabling it on busy blurs it).
  useEffect(() => {
    if (!busy && !resolved) inputRef.current?.focus();
  }, [busy, resolved]);

  const objective = useMemo(() => scene.objectives[0] ?? '', [scene.objectives]);
  const turnPct = Math.min(100, Math.round((scene.turn / Math.max(1, scene.maxTurns)) * 100));
  const turnsLeft = scene.maxTurns - scene.turn;

  return (
    <div className="wf wf-scene">
      <header className="wf-scene-head">
        <div className="wf-scene-title">
          <span className="wf-scene-mark" aria-hidden><Icon name="quest" size={16} /></span>
          <strong>{scene.name}</strong>
        </div>
        {!resolved && (
          <button className="btn ghost sm wf-scene-leave" onClick={() => setConfirmLeave(true)} disabled={busy}>
            <Icon name="leave" size={14} /> {t('quests:scene.leave')}
          </button>
        )}
      </header>

      <div className="wf-scene-bar">
        {objective && (
          <div className="wf-objective" title={objective}>
            <Icon name="end" size={13} />
            <span>{t('quests:scene.objective', { label: objective })}</span>
          </div>
        )}
        <div className={`wf-turnmeter${!resolved && turnsLeft <= 2 ? ' low' : ''}`}>
          <span className="wf-turnmeter-label">{t('quests:scene.turn', { turn: scene.turn, max: scene.maxTurns })}</span>
          <span className="wf-turnmeter-track" aria-hidden>
            <span className="wf-turnmeter-fill" style={{ width: `${turnPct}%` }} />
          </span>
        </div>
      </div>

      {confirmLeave && (
        <ConfirmDialog
          title={t('quests:scene.leaveConfirm.title')}
          body={t('quests:scene.leaveConfirm.body', { name: scene.name })}
          danger
          busy={busy}
          confirmLabel={t('quests:scene.leaveConfirm.confirm')}
          cancelLabel={t('quests:scene.leaveConfirm.cancel')}
          onConfirm={() => {
            setConfirmLeave(false);
            onLeave();
          }}
          onCancel={() => setConfirmLeave(false)}
        />
      )}

      {scene.entities.length > 0 && (
        <div className="wf-entities">
          {scene.entities.map((e) => (
            <span key={e.id} className={`wf-entity ${FACTION_CLASS[e.faction]}`} title={t(`quests:faction.${e.faction}`)}>
              <span className="wf-entity-dot" aria-hidden />
              <span className="wf-entity-name">{e.name || e.id}</span>
              {e.hp != null && (
                <span className="wf-entity-hp" title={`${e.hp} HP`}>
                  <span className="wf-entity-hpbar" aria-hidden>
                    <span style={{ width: `${Math.max(0, Math.min(100, e.hp))}%` }} />
                  </span>
                  <em>{e.hp}</em>
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="wf-reel">
        {scene.setup && <div className="wf-setup">{scene.setup}</div>}
        {scene.log.map((entry, i) => (
          <div key={i} className="wf-beat">
            <div className="wf-msg you">{entry.playerText}</div>
            <div className={`wf-msg narrator${entry.neutral && !entry.voiced ? ' wf-neutral' : ''}`}>
              {entry.narration}
              {!entry.neutral && (
                <span className={`wf-grade wf-grade-${entry.grade}`}>{gradeLabel(entry.grade, t)}</span>
              )}
            </div>
          </div>
        ))}
        {pending !== null && (
          <div className="wf-beat">
            <div className="wf-msg you">{pending}</div>
            <div className="wf-msg narrator wf-thinking">
              <span className="wf-typing"><span /><span /><span /></span> {t('quests:scene.thinking')}
            </div>
          </div>
        )}
        {resolved && scene.resolution && (
          <ResolutionCard res={scene.resolution} onDone={onLeave} busy={busy} t={t} />
        )}
        <div ref={endRef} />
      </div>

      {!resolved && (
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
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
      )}
    </div>
  );
}

// --- Resolution (an inline card at the foot of the chat, after the final beat) ------

function ResolutionCard({
  res,
  onDone,
  busy,
  t,
}: {
  res: NonNullable<QuestSceneView['resolution']>;
  onDone: () => void;
  busy: boolean;
  t: TFn;
}) {
  const win = res.outcome === 'win';
  const warmth = res.warmthChange ?? 0;
  const warmthBadge = warmth !== 0 ? warmthLabel(warmth, res.partnerName ?? null, t) : null;
  return (
    <div className={`wf-resolve-inline ${win ? 'win' : 'lose'}`}>
      <div className="wf-resolve-medal" aria-hidden>
        <Icon name={win ? 'trophy' : 'moon'} size={28} />
      </div>
      <h2>{win ? t('quests:resolution.win') : t('quests:resolution.lose')}</h2>
      <p className="wf-resolve-label">{res.label}</p>
      {(!!res.moneyEarned || warmthBadge) && (
        <div className="wf-resolve-stats">
          {!!res.moneyEarned && <span className="badge warn">{t('quests:resolution.money', { amount: res.moneyEarned })}</span>}
          {warmthBadge && <span className={`badge ${warmth > 0 ? 'accent' : 'danger'}`}>{warmthBadge}</span>}
        </div>
      )}
      <button className="btn primary" onClick={onDone} disabled={busy}>
        {win ? t('quests:resolution.ackWin') : t('quests:resolution.ackLose')}
      </button>
    </div>
  );
}

/** Warmth badge copy: signed + attributed to the partner when the quest is anchored. */
function warmthLabel(change: number, partnerName: string | null, t: TFn): string {
  const amount = Math.abs(change);
  const closer = change > 0;
  const key = closer
    ? partnerName
      ? 'quests:resolution.warmthNamed'
      : 'quests:resolution.warmth'
    : partnerName
      ? 'quests:resolution.strainedNamed'
      : 'quests:resolution.strained';
  return t(key, { amount, name: partnerName ?? '' });
}

function gradeLabel(grade: OutcomeGrade, t: TFn): string {
  return t(`quests:grade.${grade}`);
}
