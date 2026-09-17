import { useTranslation } from 'react-i18next';

type CrisisResource = { label: string; detail: string };

/**
 * Real-world crisis resources, shown to the PLAYER (not the fiction) — at the
 * tragic-outcomes opt-in and on a memorialized character's page. Calm and plain.
 */
export function CrisisResources({ className = '' }: { className?: string }) {
  const { t } = useTranslation('common');
  const blurb = t('crisis.blurb');
  const resources = t('crisis.resources', { returnObjects: true }) as CrisisResource[];
  return (
    <div className={`crisis-card ${className}`}>
      <p className="crisis-blurb">{blurb}</p>
      <ul className="crisis-list">
        {resources.map((r) => (
          <li key={r.label}>
            <strong>{r.label}</strong> — {r.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}
