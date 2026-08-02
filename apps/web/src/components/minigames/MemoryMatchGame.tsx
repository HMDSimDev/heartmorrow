import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemoryMatchConfig, MemoryMatchSubmission } from '@dsim/shared';
import { MinigameShell } from './MinigameShell';

export function MemoryMatchGame({
  config,
  onComplete,
}: {
  config: MemoryMatchConfig;
  onComplete: (submission: MemoryMatchSubmission) => void;
}) {
  const { t } = useTranslation();
  const [flipped, setFlipped] = useState<string[]>([]);
  const [matched, setMatched] = useState<Set<string>>(new Set());
  const [moves, setMoves] = useState(0);
  const [lock, setLock] = useState(false);
  const [lastMatch, setLastMatch] = useState<string | null>(null);
  const startRef = useRef(Date.now());
  const doneRef = useRef(false);
  // The mismatch flip-back timer — cleared on unmount so leaving the game inside
  // the 750ms window can't fire a setState on an unmounted component.
  const flipTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (flipTimerRef.current != null) clearTimeout(flipTimerRef.current);
    },
    [],
  );

  const matchedPairs = matched.size;

  useEffect(() => {
    if (matchedPairs === config.totalPairs && !doneRef.current) {
      doneRef.current = true;
      onComplete({ pairsMatched: matchedPairs, moves, timeMs: Date.now() - startRef.current });
    }
  }, [matchedPairs, config.totalPairs, moves, onComplete]);

  const click = (cardId: string, pairKey: string) => {
    if (lock || flipped.includes(cardId) || matched.has(pairKey)) return;
    const next = [...flipped, cardId];
    setFlipped(next);
    if (next.length === 2) {
      setMoves((m) => m + 1);
      const a = config.cards.find((c) => c.id === next[0]);
      const b = config.cards.find((c) => c.id === next[1]);
      if (a && b && a.pairKey === b.pairKey) {
        setMatched((prev) => new Set(prev).add(a.pairKey));
        setFlipped([]);
        // Surface the learned fact: pair the cue with its reveal.
        const cue = [a, b].find((c) => c.face === 'cue') ?? a;
        const reveal = [a, b].find((c) => c.face === 'reveal');
        setLastMatch(reveal && reveal.label !== cue.label ? `${cue.label}: ${reveal.label}` : cue.label);
      } else {
        setLock(true);
        flipTimerRef.current = window.setTimeout(() => {
          flipTimerRef.current = null;
          setFlipped([]);
          setLock(false);
        }, 750);
      }
    }
  };

  return (
    <MinigameShell
      title={t('minigame.memoryMatch')}
      // The shell expects a 1-BASED current-item index (every other game passes
      // `index + 1`): the pair being hunted, so completed pairs read as done.
      // Passing the raw matched COUNT left the pips one behind and started the
      // readout at "0/6" where its siblings start at "1/8".
      progress={{ current: Math.min(matchedPairs + 1, config.totalPairs), total: config.totalPairs }}
    >
      <div className="mg-board mga-board">
        <div className="row end">
          <span className="readout">
            {t('minigame.moves')} <span className="num">{moves}</span>
          </span>
        </div>
        {lastMatch && <div className="mm-caption">{t('minigame.youRemembered', { match: lastMatch })}</div>}
        <div className="mg-cards">
          {config.cards.map((card) => {
            const isUp = flipped.includes(card.id) || matched.has(card.pairKey);
            const isMatched = matched.has(card.pairKey);
            return (
              <div
                key={card.id}
                className={`mg-card mga-card-flip ${isUp ? '' : 'face-down'} ${isMatched ? 'matched' : ''}`}
                onClick={() => click(card.id, card.pairKey)}
              >
                {isUp ? card.label : ''}
              </div>
            );
          })}
        </div>
      </div>
    </MinigameShell>
  );
}
