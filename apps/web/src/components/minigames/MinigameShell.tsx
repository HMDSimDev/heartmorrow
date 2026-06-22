import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/* Shared chrome wrapper for all minigames.
   Provides a consistent header with pip-dot progress and an optional
   combo slot (used by Rhythm Serenade). Gameplay content goes in children. */

export function MinigameShell({
  title,
  progress,
  combo,
  children,
}: {
  title: string;
  progress?: { current: number; total: number };
  combo?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="mgs-shell">
      <div className="mgs-header">
        <div className="mgs-title-row">
          <span className="mgs-title">{title}</span>
          {progress && (
            <div className="mgs-progress" aria-label={t('minigame.progressAria', { current: progress.current, total: progress.total })}>
              {Array.from({ length: progress.total }, (_, i) => {
                const done = i < progress.current - 1;
                const cur = i === progress.current - 1;
                return (
                  <span
                    key={i}
                    className={`mga-pip${done ? ' on' : cur ? ' cur' : ''}`}
                  />
                );
              })}
              <span className="mgs-prog-text">
                {progress.current}/{progress.total}
              </span>
            </div>
          )}
        </div>
        {combo && <div className="mgs-combo">{combo}</div>}
      </div>
      <div className="mgs-body">{children}</div>
    </div>
  );
}

/* Segmented brass confidence control — used by SweetAndSourGame and
   TwoTruthsGame so the UI is identical across both. */

export type ConfidenceLevel = 'low' | 'medium' | 'high';

const CONF_ORDER: ConfidenceLevel[] = ['low', 'medium', 'high'];

export function ConfidenceControl({
  value,
  onChange,
}: {
  value: ConfidenceLevel;
  onChange: (v: ConfidenceLevel) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mgs-conf">
      <span className="mgs-conf-label">{t('minigame.howSure')}</span>
      <div className="mgs-conf-seg">
        {CONF_ORDER.map((c) => (
          <button
            key={c}
            type="button"
            className={`mgs-conf-btn${value === c ? ' on' : ''}`}
            onClick={() => onChange(c)}
          >
            {t(`minigame.conf.${c}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

/* Numeric confidence (0–1) → ConfidenceLevel bucket */
export function numericToLevel(n: number): ConfidenceLevel {
  if (n < 0.34) return 'low';
  if (n < 0.67) return 'medium';
  return 'high';
}

export function levelToNumeric(c: ConfidenceLevel): number {
  if (c === 'low') return 0.17;
  if (c === 'medium') return 0.5;
  return 0.83;
}
