import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_IMAGE_LABEL,
  IMAGE_UPLOAD_ACCEPT,
  type Asset,
} from '@dsim/shared';
import { api, assetUrl } from '../lib/api';
import { useAppData } from '../state/app-context';
import { errorMessage } from '../lib/hooks';
import { Icon } from './Icon';
import { Empty } from './ui';
import './assetpicker.css';

/** Tag-based helpers for character-filtered asset queries. */
function charTag(name: string): string {
  return `character:${name}`;
}
function exprTag(name: string): string {
  return `expression:${name}`;
}

/**
 * Check whether an asset's tags include a given value (case-insensitive).
 * Tags are simple strings like `"character:Nicky"`, `"expression:happy"`,
 * `"type:portrait"`. Comparisons are lowered so filename casing mismatches
 * (e.g. `adachi rei happy.png` vs character `Adachi Rei`) don't block
 * matching.
 */
function hasTag(asset: Asset, tag: string): boolean {
  return asset.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
}

/** Pick an uploaded image asset (or none), with batch upload and optional
 *  character-aware filtering.
 *
 *  Uploaded images are auto-sorted by the server — filenames containing
 *  expression keywords (happy, sad, angry…) or "portrait" get auto-tagged
 *  with the correct character and expression, so they appear in the right
 *  picker automatically.
 *
 *  When `characterName` is set, only assets tagged with `character:<name>`
 *  are shown. When `expressionName` is also set (e.g. "happy" in an expression
 *  row), assets are further filtered to those tagged `expression:<name>`.
 *  The currently-selected asset is always visible regardless of filters. */
export function AssetPicker({
  value,
  onChange,
  filterType,
  characterName,
  expressionName,
  onBatchUpload,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  /** When set, only show assets of this type (plus the always-selectable
   *  "None" tile). Keeps the picker focused — e.g. only location photos. */
  filterType?: Asset['type'];
  /** When set, filter to assets tagged with this character name. */
  characterName?: string;
  /** When set (together with characterName), filter to assets tagged with
   *  this expression name. Ignored when characterName is not set. */
  expressionName?: string;
  /** Fires after a successful batch upload with the newly created assets.
   *  Parent components can use this to auto-assign portrait/expression slots
   *  based on the uploaded assets' tags. */
  onBatchUpload?: (assets: Asset[]) => void;
}) {
  const { t } = useTranslation();
  const { assets: allAssets, reloadAssets } = useAppData();

  const [filterByCharName, setFilterByCharName] = useState(true);
  const [filterByCategory, setFilterByCategory] = useState(true);

  // Two coordinated filter toggles:
  //   - "Filter by character name" — narrows by the current character's tag
  //   - "Filter by category" — narrows by type (portrait) or expression
  // Each is independent, so you can show all images of a character regardless
  // of category, or all images of a category from any character, or both, or
  // neither. The currently-selected asset always stays visible.
  const filtered = useMemo(() => {
    let list = allAssets;

    if (characterName && filterByCharName) {
      const cTag = charTag(characterName);
      list = list.filter((a) => hasTag(a, cTag) || a.id === value);
    }

    if (filterByCategory) {
      if (expressionName) {
        const eTag = exprTag(expressionName);
        list = list.filter((a) => hasTag(a, eTag) || a.id === value);
      }
      if (filterType) {
        list = list.filter((a) => a.type === filterType || a.id === value);
      }
    }

    return list;
  }, [allAssets, characterName, expressionName, filterType, value, filterByCharName, filterByCategory]);

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleBatchFiles = async (files: FileList) => {
    setError(undefined);
    const valid = Array.from(files).filter((f) =>
      (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(f.type),
    );
    if (valid.length === 0) {
      setError(t('unsupportedImage', { label: ALLOWED_IMAGE_LABEL }));
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setUploading(true);
    try {
      const uploaded = await api.uploadAssetsBatch(valid);
      await reloadAssets();
      onBatchUpload?.(uploaded);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div>
      {filtered.length === 0 && !uploading ? (
        <div className="ap-empty">
          <Empty title={t('asset.noImages')} />
        </div>
      ) : (
        <div className="ap-grid">
          {/* "None" tile */}
          <div
            className={`ap-thumb ${value === null ? 'ap-selected' : ''}`}
            onClick={() => onChange(null)}
            title={t('asset.noPortrait')}
            role="button"
            aria-pressed={value === null}
          >
            <span className="ap-none-tile">{t('asset.none')}</span>
            <span className="ap-check" aria-hidden>✓</span>
          </div>

          {filtered.map((a) => (
            <div
              key={a.id}
              className={`ap-thumb ${value === a.id ? 'ap-selected' : ''}`}
              onClick={() => onChange(a.id)}
              title={a.filename}
              role="button"
              aria-pressed={value === a.id}
            >
              <img src={assetUrl(a.path)} alt={a.altText || a.filename} />
              <span className="ap-check" aria-hidden>✓</span>
            </div>
          ))}
        </div>
      )}

      <div className="ap-upload-row">
        <label className="btn sm ap-upload-label">
          <Icon name="upload" size={14} />
          {uploading ? t('asset.uploading') : t('asset.uploadImages')}
          <input
            ref={inputRef}
            type="file"
            accept={IMAGE_UPLOAD_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              const fl = e.target.files;
              if (fl && fl.length > 0) void handleBatchFiles(fl);
            }}
          />
        </label>
        {characterName && (
          <label className="ap-filter-toggle">
            <input
              type="checkbox"
              checked={filterByCharName}
              onChange={(e) => setFilterByCharName(e.target.checked)}
            />
            {t('asset.filterByCharName')}
          </label>
        )}
        {(expressionName || filterType) && (
          <label className="ap-filter-toggle">
            <input
              type="checkbox"
              checked={filterByCategory}
              onChange={(e) => setFilterByCategory(e.target.checked)}
            />
            {t('asset.filterByCategory')}
          </label>
        )}
      </div>
      <p className="creator-note">{t('asset.batchUploadHint')}</p>

      {error && <small className="ap-error">{error}</small>}
    </div>
  );
}
