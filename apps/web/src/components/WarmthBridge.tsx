import { Icon, type IconName } from './Icon';
import './warmth-bridge.css';

export type WarmthBridgePath = 'romance' | 'friendship';

export function WarmthBridge({ value, maxValue = 100, path = 'romance', ariaLabel, compact = false }: { value: number; maxValue?: number; path?: WarmthBridgePath; ariaLabel: string; compact?: boolean }) {
  const maximum = Math.max(1, maxValue);
  const warmth = Math.max(0, Math.min(maximum, value));
  const fill = warmth / maximum * 100;
  const displayValue = Number(warmth.toFixed(1));
  let className = 'warmth-bridge';
  let goalIcon: IconName = 'affection';
  if (compact) className += ' warmth-bridge-compact';
  if (path === 'friendship') {
    className += ' warmth-bridge-friendship';
    goalIcon = 'friendship';
  }
  return (
    <div className={className} role="meter" aria-label={ariaLabel} aria-valuemin={0} aria-valuemax={maximum} aria-valuenow={displayValue} data-empty={warmth === 0}>
      <span className="warmth-seal warmth-person"><Icon name="person" size={20} /></span>
      <span className="warmth-track"><span className="warmth-fill" style={{ width: `${fill}%` }} /></span>
      <span className="warmth-seal warmth-goal"><Icon name={goalIcon} size={20} /></span>
    </div>
  );
}
