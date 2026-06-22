import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WriterConfig, WriterSubmission } from '@dsim/shared';
import { MinigameShell } from './MinigameShell';

/**
 * The Copy Desk (Writer job): transcribe the day's dispatch verbatim. Precision is
 * graded server-side against the held passage; we only submit the raw typed text +
 * elapsed time. The copy above lights up character-by-character as you type so
 * mistakes are obvious immediately.
 */
export function WriterGame({
  config,
  onComplete,
}: {
  config: WriterConfig;
  onComplete: (submission: WriterSubmission) => void;
}) {
  const { t } = useTranslation();
  const target = config.passage;
  const [typed, setTyped] = useState('');
  const doneRef = useRef(false);

  const chars = useMemo(() => target.split(''), [target]);

  const correct = useMemo(() => {
    let c = 0;
    const upto = Math.min(typed.length, target.length);
    for (let i = 0; i < upto; i += 1) if (typed[i] === target[i]) c += 1;
    return c;
  }, [typed, target]);

  const accuracyPct = target.length ? Math.round((correct / target.length) * 100) : 0;
  const progressPct = target.length ? Math.round((typed.length / target.length) * 100) : 0;
  const complete = typed.length >= target.length;

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (doneRef.current) return;
    // Cap at the passage length: over-typing earns nothing and this ends the line cleanly.
    setTyped(e.target.value.slice(0, target.length));
  };

  const submit = () => {
    if (doneRef.current || typed.length === 0) return;
    doneRef.current = true;
    // The server times the run from its own clock and scores against its held copy —
    // we only send what was typed.
    onComplete({ typed });
  };

  return (
    <MinigameShell title={t('minigame.copyDesk')}>
      <div className="mg-board wr-board">
        {config.headline && <div className="wr-headline">{config.headline}</div>}

        <div className="wr-copy" aria-hidden>
          {chars.map((ch, i) => {
            const t = typed[i];
            const state = t === undefined ? 'pending' : t === ch ? 'ok' : 'bad';
            const isCursor = i === typed.length;
            return (
              <span key={i} className={`wr-ch wr-${state}${isCursor ? ' wr-cursor' : ''}`}>
                {ch}
              </span>
            );
          })}
        </div>

        <textarea
          className="wr-input"
          value={typed}
          onChange={onChange}
          onPaste={(e) => e.preventDefault()}
          onDrop={(e) => e.preventDefault()}
          placeholder={t('minigame.copyPlaceholder')}
          rows={3}
          autoFocus
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          aria-label={t('minigame.transcribeAria')}
        />

        <div className="wr-hud">
          <span className="wr-stat">
            <span className="num">{accuracyPct}%</span>
            <span className="lbl">{t('minigame.accuracy')}</span>
          </span>
          <span className="wr-stat">
            <span className="num">{progressPct}%</span>
            <span className="lbl">{t('minigame.set')}</span>
          </span>
        </div>

        <button className="btn primary block" onClick={submit} disabled={typed.length === 0}>
          {complete ? t('minigame.sendToPress') : t('minigame.fileEarly')}
        </button>
      </div>
    </MinigameShell>
  );
}
