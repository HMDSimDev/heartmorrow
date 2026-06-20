import type { Character } from '@dsim/shared';
import { Portrait } from './Portrait';
import { Icon } from './Icon';

export type PortraitOption = {
  id: string;
  character: Pick<Character, 'name' | 'portraitAssetId' | 'expressionAssets'>;
  /** A mono subline — age · pronouns, a role, etc. */
  sub?: string;
  /** When set, the card is dimmed/greyed and unclickable; shown in ember. */
  unavailable?: string;
  memorial?: boolean;
};

/** The canonical "who?" chooser — framed portrait plates, never a <select>.
 *  Replaces native dropdowns wherever the choice is a person. */
export function PortraitPicker({
  options,
  value,
  onChange,
  none,
  compact = false,
}: {
  options: PortraitOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  /** Optional "no one" tile (e.g. money-only minigame, "everyone" filter). */
  none?: { label: string; sub?: string };
  compact?: boolean;
}) {
  return (
    <div className={`pp-grid${compact ? ' pp-compact' : ''}`}>
      {none && (
        <button
          type="button"
          className={`pp-card pp-none${value === null ? ' selected' : ''}`}
          onClick={() => onChange(null)}
        >
          {value === null && (
            <span className="pp-check">
              <Icon name="check" size={13} strokeWidth={2.5} />
            </span>
          )}
          <span className="pp-none-mark">
            <Icon name="moon" size={22} />
          </span>
          <span className="pp-name">{none.label}</span>
          {none.sub && <span className="pp-sub">{none.sub}</span>}
        </button>
      )}
      {options.map((o) => {
        const selected = value === o.id;
        return (
          <button
            type="button"
            key={o.id}
            className={`pp-card${selected ? ' selected' : ''}${o.unavailable ? ' unavailable' : ''}`}
            disabled={!!o.unavailable}
            onClick={() => onChange(o.id)}
          >
            {selected && (
              <span className="pp-check">
                <Icon name="check" size={13} strokeWidth={2.5} />
              </span>
            )}
            <span className="pp-portrait">
              <Portrait character={o.character} memorial={o.memorial} />
            </span>
            <span className="pp-name">{o.character.name}</span>
            {(o.unavailable || o.sub) && <span className="pp-sub">{o.unavailable ?? o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}
