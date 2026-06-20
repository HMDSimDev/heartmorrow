import { useEffect, useMemo, useRef, useState } from 'react';
import type { RhythmSerenadeConfig, RhythmSerenadeSubmission } from '@dsim/shared';
import { MinigameShell } from './MinigameShell';

const STRIKE_X = 14; // % from the left where lanterns should be struck

export function RhythmSerenade({
  config,
  onComplete,
}: {
  config: RhythmSerenadeConfig;
  onComplete: (submission: RhythmSerenadeSubmission) => void;
}) {
  const beatMs = 60000 / config.bpm;
  const approach = Math.min(1500, config.leadInMs || 1500);
  const ideals = useMemo(() => config.slots.map((s) => config.leadInMs + s.index * beatMs), [config, beatMs]);
  const endAt = (ideals[ideals.length - 1] ?? 0) + config.hitWindowMs + 400;

  const [tRel, setTRel] = useState(0);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [combo, setCombo] = useState(0);

  const startRef = useRef(performance.now());
  const tapsRef = useRef<RhythmSerenadeSubmission['taps']>([]);
  const tappedRef = useRef<Set<number>>(new Set());
  const comboRef = useRef(0);
  const rafRef = useRef<number>();
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onComplete({ taps: tapsRef.current, totalMs: Math.round(performance.now() - startRef.current) });
  };

  const tap = () => {
    if (doneRef.current) return;
    const t = performance.now() - startRef.current;
    let best = -1;
    let bestDiff = Infinity;
    for (const s of config.slots) {
      if (tappedRef.current.has(s.index)) continue;
      const diff = Math.abs(t - (ideals[s.index] ?? Infinity));
      if (diff < bestDiff) {
        bestDiff = diff;
        best = s.index;
      }
    }
    if (best === -1 || bestDiff > config.hitWindowMs) {
      // No lantern at the line — a stray tap. Breaks the streak, not recorded.
      comboRef.current = 0;
      setCombo(0);
      setFeedback('…');
      return;
    }
    tappedRef.current.add(best);
    const offset = t - (ideals[best] ?? t);
    tapsRef.current.push({ slotIndex: best, offsetMs: Math.round(offset) });
    const slot = config.slots.find((s) => s.index === best);
    if (slot?.kind === 'rest') {
      comboRef.current = 0;
      setCombo(0);
      setFeedback('Rest!');
    } else {
      const d = Math.abs(offset);
      setFeedback(d <= 45 ? 'Perfect' : d <= config.hitWindowMs * 0.6 ? 'Great' : 'Good');
      comboRef.current += 1;
      setCombo(comboRef.current);
    }
  };

  useEffect(() => {
    const tick = () => {
      const t = performance.now() - startRef.current;
      setTRel(t);
      if (t >= endAt) {
        finish();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        tap();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const started = tRel >= config.leadInMs - approach;
  const countIn = Math.max(0, Math.ceil((config.leadInMs - tRel) / beatMs));

  const comboSlot = (
    <span className="mga-last">
      <span className="num">{combo}</span>
      <span className="lbl">combo</span>
    </span>
  );

  return (
    <MinigameShell title={config.themeLabel} combo={comboSlot}>
      <div className="mg-board mga-board rhy-board">
        <div className="rhy-stage" onClick={tap}>
          <div className="rhy-strike" style={{ left: `${STRIKE_X}%` }} />
          {config.slots.map((s) => {
            const ideal = ideals[s.index] ?? 0;
            const progress = (tRel - (ideal - approach)) / approach;
            if (progress < 0 || progress > 1 + config.hitWindowMs / approach) return null;
            const x = 100 - progress * (100 - STRIKE_X);
            const top = 22 + s.laneHint * 16;
            return (
              <div
                key={s.index}
                className={`rhy-lantern ${s.kind} ${tappedRef.current.has(s.index) ? 'struck' : ''}`}
                style={{ left: `${x}%`, top: `${top}%` }}
              />
            );
          })}
          {!started && <div className="rhy-countin">{countIn > 0 ? countIn : 'Go!'}</div>}
          {feedback && started && <div className="rhy-feedback">{feedback}</div>}
        </div>

        <button className="btn primary block" onClick={tap}>
          Tap to the beat <span className="rhy-key">(or press Space)</span>
        </button>
      </div>
    </MinigameShell>
  );
}
