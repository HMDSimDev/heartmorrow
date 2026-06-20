import { useEffect, useRef, useState } from 'react';
import type { TimingMeterConfig, TimingMeterSubmission } from '@dsim/shared';
import { MinigameShell } from './MinigameShell';

export function TimingMeterGame({
  config,
  onComplete,
}: {
  config: TimingMeterConfig;
  onComplete: (submission: TimingMeterSubmission) => void;
}) {
  const totalRounds = config.rounds.length;
  const [pos, setPos] = useState(0);
  const [round, setRound] = useState(0);
  const [results, setResults] = useState<Array<{ accuracy: number }>>([]);
  const [last, setLast] = useState<number | null>(null);
  const posRef = useRef(0);
  const dirRef = useRef(1);
  const roundRef = useRef(0);
  const rafRef = useRef<number>();
  const runningRef = useRef(true);
  const doneRef = useRef(false);

  // The sweep speed comes from the CURRENT round — it ramps up each round.
  useEffect(() => {
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = (now - prev) / 1000;
      prev = now;
      if (!runningRef.current) return;
      const speed = config.rounds[roundRef.current]?.speed ?? 1.2;
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
  }, [config.rounds]);

  const cur = config.rounds[Math.min(round, totalRounds - 1)]!;
  const center = (cur.targetStart + cur.targetEnd) / 2;
  const halfWidth = Math.max(0.001, (cur.targetEnd - cur.targetStart) / 2);

  const stop = () => {
    if (round >= totalRounds) return;
    const distance = Math.abs(posRef.current - center);
    const accuracy = distance <= halfWidth ? 1 - (distance / halfWidth) * 0.4 : 0;
    setLast(accuracy);
    const nextResults = [...results, { accuracy }];
    setResults(nextResults);
    const nextRound = round + 1;
    setRound(nextRound);
    roundRef.current = nextRound;
    if (nextRound >= totalRounds) {
      if (doneRef.current) return;
      doneRef.current = true;
      runningRef.current = false;
      onComplete({ rounds: nextResults });
    }
  };

  return (
    <MinigameShell
      title="Timing Meter"
      progress={{ current: Math.min(round + 1, totalRounds), total: totalRounds }}
    >
      <div className="mg-board mga-board">
        {last !== null && (
          <div className="row end">
            <span className="mga-last">
              <span className="num">{Math.round(last * 100)}%</span>
              <span className="lbl">last hit</span>
            </span>
          </div>
        )}
        <div className="meter-track mga-meter">
          <div
            className="meter-zone"
            style={{ left: `${cur.targetStart * 100}%`, width: `${(cur.targetEnd - cur.targetStart) * 100}%` }}
          />
          <div className="meter-needle" style={{ left: `${pos * 100}%` }} />
        </div>
        <button className="btn primary block" onClick={stop} disabled={round >= totalRounds}>
          {round >= totalRounds ? 'Done!' : 'Stop in the zone!'}
        </button>
      </div>
    </MinigameShell>
  );
}
