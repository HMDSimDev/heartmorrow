import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LumberjackConfig, LumberjackSubmission } from '@dsim/shared';
import { MinigameShell } from './MinigameShell';

/** Mirror of the server's `CLEAN` threshold — for client-side combo FEEDBACK only.
 *  The server re-derives the authoritative combo + score from the raw accuracies. */
const CLEAN = 0.6;

export function LumberjackGame({
  config,
  onComplete,
}: {
  config: LumberjackConfig;
  onComplete: (submission: LumberjackSubmission) => void;
}) {
  const { t } = useTranslation();
  const totalLogs = config.logs.length;
  const [pos, setPos] = useState(0);
  const [log, setLog] = useState(0);
  const [results, setResults] = useState<Array<{ accuracy: number }>>([]);
  const [last, setLast] = useState<'clean' | 'graze' | 'miss' | null>(null);
  const [combo, setCombo] = useState(0);
  const [chip, setChip] = useState(0); // bump to retrigger the chip-fly animation
  const posRef = useRef(0);
  const dirRef = useRef(1);
  const logRef = useRef(0);
  const comboRef = useRef(0);
  const rafRef = useRef<number>();
  const runningRef = useRef(true);
  const doneRef = useRef(false);

  // The sweep speed comes from the CURRENT log — it ramps up as your arms tire.
  useEffect(() => {
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = (now - prev) / 1000;
      prev = now;
      if (!runningRef.current) return;
      const speed = config.logs[logRef.current]?.speed ?? 1.2;
      posRef.current += dirRef.current * speed * dt;
      if (posRef.current >= 1) {
        posRef.current = 1;
        dirRef.current = -1;
      } else if (posRef.current <= 0) {
        posRef.current = 0;
        dirRef.current = 1;
      }
      setPos(posRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [config.logs]);

  const cur = config.logs[Math.min(log, totalLogs - 1)]!;
  const center = (cur.targetStart + cur.targetEnd) / 2;
  const halfWidth = Math.max(0.001, (cur.targetEnd - cur.targetStart) / 2);

  const swing = () => {
    if (log >= totalLogs) return;
    // Judge against the needle the player can SEE — the last-RENDERED position —
    // never the live rAF ref. posRef has already advanced past the painted frame
    // (~1–2 frames ahead), which at the later logs' speeds is wider than the whole
    // grain zone: a visually-perfect swing was scoring as a miss.
    const distance = Math.abs(pos - center);
    const accuracy = distance <= halfWidth ? 1 - (distance / halfWidth) * 0.4 : 0;
    if (accuracy >= CLEAN) {
      comboRef.current += 1;
      setCombo(comboRef.current);
      setLast('clean');
      setChip((k) => k + 1);
    } else {
      comboRef.current = 0;
      setCombo(0);
      setLast(accuracy > 0 ? 'graze' : 'miss');
    }
    const nextResults = [...results, { accuracy }];
    setResults(nextResults);
    const nextLog = log + 1;
    setLog(nextLog);
    logRef.current = nextLog;
    if (nextLog >= totalLogs) {
      if (doneRef.current) return;
      doneRef.current = true;
      runningRef.current = false;
      onComplete({ swings: nextResults });
    }
  };

  return (
    <MinigameShell
      title={t('minigame.woodlot')}
      progress={{ current: Math.min(log + 1, totalLogs), total: totalLogs }}
      combo={combo >= 2 ? <span className="mga-lumber-combo">{t('minigame.cleanCombo', { n: combo })}</span> : undefined}
    >
      <div className="mg-board mga-board mga-lumber">
        <div className="mga-lumber-stack" aria-hidden>
          {Array.from({ length: totalLogs }, (_, i) => (
            <span key={i} className={`mga-log${i < log ? ' felled' : i === log ? ' active' : ''}`}>
              🪵
            </span>
          ))}
        </div>
        {last !== null && (
          <div className="row end">
            <span className={`mga-last lj-${last}`}>
              <span className="num">{last === 'clean' ? t('minigame.clean') : last === 'graze' ? t('minigame.graze') : t('minigame.miss')}</span>
              <span className="lbl">{t('minigame.lastSwing')}</span>
            </span>
          </div>
        )}
        <div className="meter-track mga-meter mga-lumber-meter">
          <div
            className="meter-zone"
            style={{ left: `${cur.targetStart * 100}%`, width: `${(cur.targetEnd - cur.targetStart) * 100}%` }}
          />
          <div className="meter-needle" style={{ left: `${pos * 100}%` }} />
          {chip > 0 && <span key={chip} className="mga-chip" style={{ left: `${pos * 100}%` }} aria-hidden />}
        </div>
        {/* Swing on PRESS (pointerdown), not on click — click waits for the release,
            and that extra beat is real distance at swing speed. The click handler
            survives only as the keyboard path: Space/Enter activations arrive as
            clicks with detail 0, while a pointer press has already swung. */}
        <button
          className="btn primary block"
          onPointerDown={(e) => {
            if (e.button === 0) swing();
          }}
          onClick={(e) => {
            if (e.detail === 0) swing();
          }}
          disabled={log >= totalLogs}
        >
          {log >= totalLogs ? t('minigame.timber') : t('minigame.swing')}
        </button>
      </div>
    </MinigameShell>
  );
}
