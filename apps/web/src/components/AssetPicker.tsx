import { useRef, useState } from 'react';
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

/** Pick an uploaded image asset (or none), with inline upload. */
export function AssetPicker({
  value,
  onChange,
  uploadType = 'portrait',
  filterType,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  uploadType?: Asset['type'];
  /** When set, only show assets of this type (plus the always-selectable
   *  "None" tile). Keeps the picker focused — e.g. only location photos. */
  filterType?: Asset['type'];
}) {
  const { t } = useTranslation();
  const { assets: allAssets, reloadAssets } = useAppData();
  // Always keep the currently-selected asset visible even if it predates the
  // filter (e.g. an older photo saved under a different type).
  const assets = filterType
    ? allAssets.filter((a) => a.type === filterType || a.id === value)
    : allAssets;
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setError(undefined);
    // `accept` is only a hint — a user can still pick any file via the picker's
    // "All files" override. Reject anything the vision model can't read before we
    // upload it, so the failure is immediate and clear rather than at request time.
    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(t('unsupportedImage', { label: ALLOWED_IMAGE_LABEL }));
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setUploading(true);
    try {
      const asset = await api.uploadAsset(file, uploadType, '', '');
      await reloadAssets();
      onChange(asset.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div>
      {assets.length === 0 && !uploading ? (
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

          {assets.map((a) => (
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
          {uploading ? t('asset.uploading') : t('asset.uploadImage')}
          <input
            ref={inputRef}
            type="file"
            accept={IMAGE_UPLOAD_ACCEPT}
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
        </label>
      </div>

      {error && <small className="ap-error">{error}</small>}
    </div>
  );
}
