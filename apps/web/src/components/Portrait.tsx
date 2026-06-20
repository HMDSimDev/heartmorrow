import type { Character } from '@dsim/shared';
import { assetUrl } from '../lib/api';
import { useAppData } from '../state/app-context';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** Character portrait — shows the assigned image, or a tasteful initials placeholder. */
export function Portrait({
  character,
  className = '',
  expression,
  memorial = false,
  crossfade = false,
}: {
  character: Pick<Character, 'name' | 'portraitAssetId' | 'expressionAssets'>;
  className?: string;
  expression?: string | null;
  /** When true, the portrait is greyed with a red ✕ — the character is gone. */
  memorial?: boolean;
  /**
   * When true, the image cross-fades in whenever the resolved asset changes
   * (keyed on its path so React remounts it and replays the fade). Used by the
   * live date portrait so per-turn expression swaps dissolve instead of snapping.
   */
  crossfade?: boolean;
}) {
  const { assetById } = useAppData();
  const expressionAssetId = expression ? character.expressionAssets[expression] : undefined;
  const asset = assetById(expressionAssetId) ?? assetById(character.portraitAssetId);

  return (
    <div className={`portrait ${memorial ? 'portrait-memorial' : ''} ${className}`}>
      {asset ? (
        <img
          key={crossfade ? asset.path : undefined}
          className={crossfade ? 'portrait-xfade' : undefined}
          src={assetUrl(asset.path)}
          alt={asset.altText || character.name}
        />
      ) : (
        <span className="initials">{initials(character.name) || '☺'}</span>
      )}
      {memorial && (
        <span className="portrait-x" aria-label="In memoriam" title="In memoriam">
          ✕
        </span>
      )}
    </div>
  );
}
