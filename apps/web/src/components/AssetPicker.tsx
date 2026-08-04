import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_IMAGE_LABEL,
  IMAGE_UPLOAD_ACCEPT,
  AssetTypeSchema,
  type Asset,
  type AssetType,
} from '@dsim/shared';
import { api, assetUrl } from '../lib/api';
import { useAppData } from '../state/app-context';
import { errorMessage } from '../lib/hooks';
import { assetTypeLabel } from '../i18n/labels';
import { Icon } from './Icon';
import { Empty } from './ui';
import './assetpicker.css';

/**
 * Pick an uploaded image asset (or none). Renders as a compact trigger — the
 * current selection plus Choose/Clear — and opens the full library in a modal
 * dialog with search, type filters, and upload (button, drag-drop, or paste).
 * The library is only mounted while the dialog is open, so editor forms stay
 * light no matter how many images exist.
 */
export function AssetPicker({
  value,
  onChange,
  uploadType = 'portrait',
  defaultFilter,
  autoTags,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  uploadType?: Asset['type'];
  /** Type chip the dialog opens on (e.g. only location photos). Soft — the
   *  user can always switch to "All"; ignored when no asset has that type. */
  defaultFilter?: AssetType;
  /** Context tags stamped onto uploads (e.g. the character's name), so the
   *  library search can group "this character's images" with zero hand-tagging. */
  autoTags?: string[];
}) {
  const { t } = useTranslation();
  const { assets } = useAppData();
  const [open, setOpen] = useState(false);
  const selected = value ? assets.find((a) => a.id === value) : undefined;

  return (
    <div>
      <div className="ap-trigger">
        <button
          type="button"
          className="ap-thumb ap-current"
          onClick={() => setOpen(true)}
          aria-label={selected ? t('asset.change') : t('asset.choose')}
        >
          {selected ? (
            <img src={assetUrl(selected.path)} alt={selected.altText || selected.filename} />
          ) : (
            <span className="ap-none-tile">{t('asset.none')}</span>
          )}
        </button>
        <div className="ap-trigger-info">
          <div className="ap-trigger-actions">
            <button type="button" className="btn sm" onClick={() => setOpen(true)}>
              <Icon name="image" size={14} />
              {selected ? t('asset.change') : t('asset.choose')}
            </button>
            {value !== null && (
              <button type="button" className="btn sm ghost" onClick={() => onChange(null)}>
                {t('asset.clear')}
              </button>
            )}
          </div>
          {selected && (
            <small className="ap-filename" title={selected.filename}>
              {selected.filename}
            </small>
          )}
        </div>
      </div>

      {open && (
        <AssetPickerDialog
          value={value}
          uploadType={uploadType}
          defaultFilter={defaultFilter}
          autoTags={autoTags}
          onPick={(id) => {
            onChange(id);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function AssetPickerDialog({
  value,
  uploadType,
  defaultFilter,
  autoTags,
  onPick,
  onClose,
}: {
  value: string | null;
  uploadType: Asset['type'];
  defaultFilter?: AssetType;
  autoTags?: string[];
  onPick: (id: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { assets, reloadAssets } = useAppData();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AssetType | 'all'>(() =>
    defaultFilter && assets.some((a) => a.type === defaultFilter) ? defaultFilter : 'all',
  );
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Only offer chips for types that actually have images, in enum order.
  const presentTypes = useMemo(
    () => AssetTypeSchema.options.filter((ty) => assets.some((a) => a.type === ty)),
    [assets],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets
      // Type filter never hides the current selection, even if it predates the
      // filter (e.g. an older photo saved under a different type).
      .filter((a) => filter === 'all' || a.type === filter || a.id === value)
      .filter(
        (a) =>
          !q ||
          a.filename.toLowerCase().includes(q) ||
          a.altText.toLowerCase().includes(q) ||
          a.tags.some((tag) => tag.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [assets, filter, query, value]);

  const handleFile = async (file: File) => {
    if (uploading) return;
    setError(undefined);
    // `accept` is only a hint — a user can still pick any file via the picker's
    // "All files" override (or drop/paste one). Reject anything the vision model
    // can't read before we upload it, so the failure is immediate and clear.
    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(t('unsupportedImage', { label: ALLOWED_IMAGE_LABEL }));
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setUploading(true);
    try {
      const tags = (autoTags ?? []).map((s) => s.trim()).filter(Boolean).join(',');
      const asset = await api.uploadAsset(file, uploadType, '', tags);
      await reloadAssets();
      onPick(asset.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  // Esc must close only this dialog — it can sit on top of another Modal (the
  // portrait-generation flow), whose own Esc handler listens on the bubble
  // phase. Capture + stopPropagation keeps the underlying modal open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Paste-to-upload while the dialog is open. Text pastes (e.g. into the
  // search box) have no image file and pass through untouched.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
      if (file) {
        e.preventDefault();
        void handleFile(file);
      }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  });

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal card ap-dialog ${dragOver ? 'ap-drop' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={t('asset.dialogTitle')}
        onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) void handleFile(file);
        }}
      >
        <div className="ap-dialog-head">
          <h2 className="ap-dialog-title">{t('asset.dialogTitle')}</h2>
          <button type="button" className="btn sm ghost" onClick={onClose} aria-label={t('asset.close')}>
            <Icon name="close" size={14} />
          </button>
        </div>

        <input
          type="search"
          className="ap-search"
          value={query}
          placeholder={t('asset.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus={window.matchMedia('(pointer: fine)').matches}
        />

        {presentTypes.length > 1 && (
          <div className="ap-chips">
            <button
              type="button"
              className={`btn sm ${filter === 'all' ? 'primary' : 'ghost'}`}
              onClick={() => setFilter('all')}
            >
              {t('asset.all')}
            </button>
            {presentTypes.map((ty) => (
              <button
                key={ty}
                type="button"
                className={`btn sm ${filter === ty ? 'primary' : 'ghost'}`}
                onClick={() => setFilter(ty)}
              >
                {assetTypeLabel(ty)}
              </button>
            ))}
          </div>
        )}

        {assets.length === 0 && !uploading ? (
          <div className="ap-empty">
            <Empty title={t('asset.noImages')} />
          </div>
        ) : (
          <div className="ap-dialog-grid">
            {/* "None" tile */}
            <button
              type="button"
              className={`ap-thumb ${value === null ? 'ap-selected' : ''}`}
              onClick={() => onPick(null)}
              title={t('asset.noPortrait')}
              aria-pressed={value === null}
            >
              <span className="ap-none-tile">{t('asset.none')}</span>
              <span className="ap-check" aria-hidden>✓</span>
            </button>

            {shown.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`ap-thumb ${value === a.id ? 'ap-selected' : ''}`}
                onClick={() => onPick(a.id)}
                title={`${a.filename} — ${assetTypeLabel(a.type)}`}
                aria-pressed={value === a.id}
              >
                <img
                  src={assetUrl(a.path)}
                  alt={a.altText || a.filename}
                  loading="lazy"
                  decoding="async"
                />
                <span className="ap-check" aria-hidden>✓</span>
              </button>
            ))}
          </div>
        )}
        {assets.length > 0 && shown.length === 0 && <p className="hint">{t('asset.noMatches')}</p>}

        <div className="ap-dialog-foot">
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
          <span className="hint">{t('asset.dropHint')}</span>
        </div>
        {error && <small className="ap-error">{error}</small>}
      </div>
    </div>,
    document.body,
  );
}
