import {
  DATING_STAT_KEYS,
  RELATIONSHIP_STAT_KEYS,
  type DatingStats,
  type Relationship,
  type RelationshipStatKey,
} from '@dsim/shared';
import { datingStatLabel, relationshipStatLabel } from '../i18n/labels';

export function StatBar({
  label,
  value,
  max = 100,
  tension = false,
  delta,
}: {
  label: string;
  value: number;
  max?: number;
  tension?: boolean;
  /** When set + non-zero, shows a floating +N/-N chip and animates the fill. */
  delta?: number;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const showDelta = typeof delta === 'number' && delta !== 0;
  // Rising tension is the one "bad" move — pulse the bar red to call it out.
  const tensionRose = tension && showDelta && (delta as number) > 0;
  return (
    <div className={`statbar ${tension ? 'tension' : ''} ${tensionRose ? 'flash' : ''}`}>
      <div className="label">
        <span>{label}</span>
        <span className="v">
          {value}
          {showDelta && (
            <span className={`delta-chip ${delta > 0 ? 'up' : 'down'}`}>
              {delta > 0 ? '+' : ''}
              {delta}
            </span>
          )}
        </span>
      </div>
      <div className="track">
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function RelationshipBars({
  relationship,
  deltas,
}: {
  relationship: Relationship;
  /** Per-stat changes to surface as floating chips (e.g. after a date). */
  deltas?: Partial<Record<RelationshipStatKey, number>>;
}) {
  return (
    <div>
      {RELATIONSHIP_STAT_KEYS.map((k) => (
        <StatBar
          key={k}
          label={relationshipStatLabel(k)}
          value={relationship[k]}
          tension={k === 'tension'}
          delta={deltas?.[k]}
        />
      ))}
    </div>
  );
}

export function DatingBars({ stats }: { stats: DatingStats }) {
  return (
    <div>
      {DATING_STAT_KEYS.map((k) => (
        <StatBar key={k} label={datingStatLabel(k)} value={stats[k]} />
      ))}
    </div>
  );
}
