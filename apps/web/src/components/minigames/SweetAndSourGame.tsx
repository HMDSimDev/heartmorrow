import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SweetAndSourConfig, SweetAndSourSubmission } from '@dsim/shared';
import { MinigameShell, ConfidenceControl, type ConfidenceLevel, levelToNumeric } from './MinigameShell';

type Tray = 'adore' | 'avoid' | 'meh';
const TRAY_CLASS: Record<Tray, string> = { adore: 'tray-adore', avoid: 'tray-avoid', meh: 'tray-meh' };

export function SweetAndSourGame({
  config,
  onComplete,
}: {
  config: SweetAndSourConfig;
  onComplete: (submission: SweetAndSourSubmission) => void;
}) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  const [confidence, setConfidence] = useState<ConfidenceLevel>('medium');
  const placements = useRef<SweetAndSourSubmission['placements']>([]);
  const shownAt = useRef(Date.now());
  const doneRef = useRef(false);

  const card = config.cards[index];
  if (!card) return null;

  const place = (tray: Tray) => {
    if (doneRef.current) return;
    placements.current.push({
      cardId: card.id,
      tray,
      confidence: levelToNumeric(confidence),
      swipeMs: Math.max(0, Date.now() - shownAt.current),
    });
    const next = index + 1;
    if (next >= config.cards.length) {
      doneRef.current = true;
      onComplete({ placements: placements.current });
      return;
    }
    setIndex(next);
    setConfidence('medium');
    shownAt.current = Date.now();
  };

  return (
    <MinigameShell
      title={t('minigame.sweetAndSour')}
      progress={{ current: index + 1, total: config.cards.length }}
    >
      <div className="mg-board mga-board sns-board">
        <div className="sns-card">{card.label}</div>

        <ConfidenceControl value={confidence} onChange={setConfidence} />

        <div className="sns-trays">
          {config.trays.map((t) => (
            <button key={t.key} className={`btn sns-tray ${TRAY_CLASS[t.key]}`} onClick={() => place(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </MinigameShell>
  );
}
