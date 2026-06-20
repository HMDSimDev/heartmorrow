import { useRef, useState } from 'react';
import type { TwoTruthsConfig, TwoTruthsSubmission } from '@dsim/shared';
import { MinigameShell, ConfidenceControl, type ConfidenceLevel } from './MinigameShell';

export function TwoTruthsGame({
  config,
  onComplete,
}: {
  config: TwoTruthsConfig;
  onComplete: (submission: TwoTruthsSubmission) => void;
}) {
  const [roundIndex, setRoundIndex] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<ConfidenceLevel>('medium');
  const answers = useRef<TwoTruthsSubmission['rounds']>([]);
  const doneRef = useRef(false);

  const round = config.rounds[roundIndex];
  if (!round) return null;

  const callIt = () => {
    if (doneRef.current || !selected) return;
    answers.current.push({ roundId: round.id, accusedStatementId: selected, confidence });
    const next = roundIndex + 1;
    if (next >= config.rounds.length) {
      doneRef.current = true;
      onComplete({ rounds: answers.current });
      return;
    }
    setRoundIndex(next);
    setSelected(null);
    setConfidence('medium');
  };

  return (
    <MinigameShell
      title="Read Between the Lines"
      progress={{ current: roundIndex + 1, total: config.rounds.length }}
    >
      <div className="mg-board mga-board ttl-board">
        <p className="ttl-lead">They lean in. "Two of these are true. One's a bluff…"</p>
        <div className="stack ttl-statements">
          {round.statements.map((s) => (
            <button
              key={s.id}
              className={`btn ttl-statement ${selected === s.id ? 'picked' : ''}`}
              onClick={() => setSelected(s.id)}
            >
              {s.text}
            </button>
          ))}
        </div>

        <ConfidenceControl value={confidence} onChange={setConfidence} />

        <button className="btn primary block" onClick={callIt} disabled={!selected}>
          {selected ? 'Call it' : 'Pick the bluff'}
        </button>
      </div>
    </MinigameShell>
  );
}
