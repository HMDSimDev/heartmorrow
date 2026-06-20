import type { ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';

/** The one app bar every phone app shares — a kicker + serif name, with
 *  optional left (back) and right (action) slots. Standardizes the OS chrome
 *  so no app floats bar-less or falls back to a plain heading. */
export function PhoneAppBar({
  title,
  kicker,
  icon,
  left,
  right,
}: {
  title: string;
  kicker?: string;
  icon?: IconName;
  left?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="phone-appbar pbar">
      <span className="pbar-side pbar-left">{left}</span>
      <span className="pbar-title">
        {kicker && <span className="pbar-kicker">{kicker}</span>}
        <strong className="pbar-name">
          {icon && <Icon name={icon} size={16} />}
          {title}
        </strong>
      </span>
      <span className="pbar-side pbar-right">{right}</span>
    </div>
  );
}
