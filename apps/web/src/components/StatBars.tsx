import { DATING_STAT_KEYS, RELATIONSHIP_STAT_KEYS, type DatingStats, type Relationship, type RelationshipStatKey } from '@dsim/shared';
import { datingStatLabel, relationshipStatLabel } from '../i18n/labels';
import { Icon, type IconName } from './Icon';

const RELATIONSHIP_STAT_ICONS: Record<RelationshipStatKey, IconName> = { affection: 'affection', trust: 'trust', chemistry: 'chemistry', comfort: 'comfort', respect: 'respect', curiosity: 'curiosity', tension: 'tension' };

export function StatBar({
  label,
  value,
  max = 100,
  tension = false,
  delta,
  icon,
}: {
  label: string;
  value: number;
  max?: number;
  tension?: boolean;
  /** When set + non-zero, shows a floating +N/-N chip and animates the fill. */
  delta?: number;
  icon?: IconName;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const showDelta = typeof delta === 'number' && delta !== 0;
  // Rising tension is the one "bad" move — pulse the bar red to call it out.
  const tensionRose = tension && showDelta && (delta as number) > 0;
  let statbarClass = 'statbar';
  let deltaClass = 'delta-chip';
  let deltaPrefix = '';
  if (tension) statbarClass += ' tension';
  if (tensionRose) statbarClass += ' flash';
  if (icon) statbarClass += ' with-icon';
  if (showDelta && (delta as number) > 0) deltaClass += ' up';
  if (showDelta && (delta as number) <= 0) deltaClass += ' down';
  if (showDelta && (delta as number) > 0) deltaPrefix = '+';
  return (
    <div className={statbarClass}>
      {icon && <Icon className="stat-icon" name={icon} size={16} />}
      <div className="statbar-body">
        <div className="label">
          <span className="label-text">{label}</span>
          <span className="v">
            {value}
            {showDelta && <span className={deltaClass}>{deltaPrefix}{delta}</span>}
          </span>
        </div>
        <div className="track">
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

export function RelationshipBars({
  relationship,
  deltas,
  showIcons = false,
}: {
  relationship: Relationship;
  /** Per-stat changes to surface as floating chips (e.g. after a date). */
  deltas?: Partial<Record<RelationshipStatKey, number>>;
  showIcons?: boolean;
}) {
  return (
    <div>
      {RELATIONSHIP_STAT_KEYS.map((k) => {
        let icon: IconName | undefined;
        if (showIcons) icon = RELATIONSHIP_STAT_ICONS[k];
        return <StatBar key={k} label={relationshipStatLabel(k)} value={relationship[k]} tension={k === 'tension'} delta={deltas?.[k]} icon={icon} />;
      })}
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
