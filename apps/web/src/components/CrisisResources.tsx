import { CRISIS_RESOURCES, CRISIS_BLURB } from '@dsim/shared';

/**
 * Real-world crisis resources, shown to the PLAYER (not the fiction) — at the
 * tragic-outcomes opt-in and on a memorialized character's page. Calm and plain.
 */
export function CrisisResources({ className = '' }: { className?: string }) {
  return (
    <div className={`crisis-card ${className}`}>
      <p className="crisis-blurb">{CRISIS_BLURB}</p>
      <ul className="crisis-list">
        {CRISIS_RESOURCES.map((r) => (
          <li key={r.label}>
            <strong>{r.label}</strong> — {r.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}
