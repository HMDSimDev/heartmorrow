import './imagelibrary.page.css';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_IMAGE_LABEL,
  IMAGE_UPLOAD_ACCEPT,
  AssetTypeSchema,
  type Asset,
  type AssetType,
  type AssetUpdate,
  type AssetUsage,
} from '@dsim/shared';
import { api, assetUrl, assetThumbUrl } from '../lib/api';
import { useAsync, errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { assetTypeLabel, assetUsageKindLabel, expressionLabel } from '../i18n/labels';
import { Icon } from '../components/Icon';
import { Banner, ConfirmDialog, Empty, Field, Modal, TagInput } from '../components/ui';

type Filter = AssetType | 'all' | 'unused';

/**
 * Creator tool: browse, edit, and prune every uploaded image. The management
 * half of the picker split — the AssetPicker chooses images in context; this
 * page answers "what do I have, where is it used, what can go".
 */
export function ImageLibrary() {
  const { t } = useTranslation(['pages', 'common']);
  const { assets, reloadAssets, worlds } = useAppData();
  const usageState = useAsync(() => api.assetUsage(), [assets]);
  const usages = usageState.data;

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [worldFilter, setWorldFilter] = useState<string>('all');
  const [detail, setDetail] = useState<Asset | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  // Bumped after a thumbnail rebuild so <img> tags that already fell back to the
  // original retry the (now existing) thumb URL.
  const [thumbEpoch, setThumbEpoch] = useState(0);

  const presentTypes = useMemo(
    () => AssetTypeSchema.options.filter((ty) => assets.some((a) => a.type === ty)),
    [assets],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets
      .filter((a) => {
        if (filter === 'unused') return usages !== undefined && !usages[a.id];
        return filter === 'all' || a.type === filter;
      })
      // "In this world" = referenced by something living in that world. Global
      // content (shop items) and unused images only appear under All worlds.
      .filter(
        (a) =>
          worldFilter === 'all' ||
          (usages?.[a.id] ?? []).some((u) => u.worldId === worldFilter),
      )
      .filter(
        (a) =>
          !q ||
          a.filename.toLowerCase().includes(q) ||
          a.altText.toLowerCase().includes(q) ||
          a.tags.some((tag) => tag.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [assets, filter, query, usages, worldFilter]);

  const unusedCount = useMemo(
    () => (usages === undefined ? undefined : assets.filter((a) => !usages[a.id]).length),
    [assets, usages],
  );

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const cancelSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const runDelete = async (ids: string[]) => {
    setBusy(true);
    setError(undefined);
    try {
      for (const id of ids) await api.deleteAsset(id);
      await reloadAssets();
      setNote(t('pages:library.deleted', { count: ids.length }));
      cancelSelecting();
      setDetail(null);
    } catch (e) {
      setError(errorMessage(e));
      await reloadAssets(); // partial bulk delete: resync to what actually remains
    } finally {
      setBusy(false);
      setPendingDelete(null);
    }
  };

  const rebuildThumbs = async () => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const r = await api.rebuildThumbnails();
      setNote(t('pages:library.rebuildDone', { generated: r.generated, failed: r.failed }));
      setThumbEpoch((e) => e + 1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const uploadRef = useRef<HTMLInputElement>(null);
  const handleUpload = async (file: File) => {
    setError(undefined);
    setNote(undefined);
    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(t('common:unsupportedImage', { label: ALLOWED_IMAGE_LABEL }));
      if (uploadRef.current) uploadRef.current.value = '';
      return;
    }
    setBusy(true);
    try {
      // Type 'other' by default — retype from the detail dialog. A byte-identical
      // re-upload comes back as the existing asset (server-side dedup).
      const asset = await api.uploadAsset(file, 'other', '', '');
      await reloadAssets();
      setNote(t('pages:library.uploaded', { name: asset.filename }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      if (uploadRef.current) uploadRef.current.value = '';
    }
  };

  const inUseSelected = pendingDelete
    ? pendingDelete.filter((id) => usages?.[id]?.length).length
    : 0;

  return (
    <div className="stack">
      <div className="page-head il-head">
        <div>
          <span className="kicker">{t('pages:library.kicker')}</span>
          <h1>{t('pages:library.title')}</h1>
          <p>{t('pages:library.blurb')}</p>
        </div>
        <div className="row il-head-actions">
          {selecting ? (
            <>
              <span className="muted il-selcount">
                {t('pages:library.selected', { count: selected.size })}
              </span>
              <button
                className="btn sm"
                onClick={() => setSelected(new Set(shown.map((a) => a.id)))}
                disabled={busy || shown.length === 0}
              >
                {t('pages:library.selectShown')}
              </button>
              <button
                className="btn sm danger"
                onClick={() => setPendingDelete([...selected])}
                disabled={busy || selected.size === 0}
              >
                <Icon name="trash" size={13} />
                {t('pages:library.deleteSelected')}
              </button>
              <button className="btn sm ghost" onClick={cancelSelecting} disabled={busy}>
                {t('common:cancel')}
              </button>
            </>
          ) : (
            <>
              <button className="btn sm ghost" onClick={rebuildThumbs} disabled={busy || assets.length === 0}>
                <Icon name="refresh" size={13} />
                {t('pages:library.rebuildThumbs')}
              </button>
              <label className={`btn sm ${busy ? 'disabled' : ''}`} style={{ cursor: 'pointer' }}>
                <Icon name="upload" size={13} />
                {t('common:asset.uploadImage')}
                <input
                  ref={uploadRef}
                  type="file"
                  accept={IMAGE_UPLOAD_ACCEPT}
                  hidden
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleUpload(f);
                  }}
                />
              </label>
              <button className="btn sm" onClick={() => setSelecting(true)} disabled={assets.length === 0}>
                {t('pages:library.select')}
              </button>
            </>
          )}
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {note && <Banner kind="ok">{note}</Banner>}
      {usageState.error && <Banner kind="error">{usageState.error}</Banner>}

      {assets.length === 0 ? (
        <Empty icon={<Icon name="image" size={28} />} title={t('pages:library.emptyTitle')}>
          <p>{t('pages:library.emptyBody')}</p>
        </Empty>
      ) : (
        <>
          <div className="il-controls">
            <input
              type="search"
              className="il-search"
              value={query}
              placeholder={t('common:asset.searchPlaceholder')}
              onChange={(e) => setQuery(e.target.value)}
            />
            {worlds.length > 1 && (
              <select
                className="il-world"
                value={worldFilter}
                disabled={usages === undefined}
                onChange={(e) => setWorldFilter(e.target.value)}
                aria-label={t('pages:library.worldFilter')}
              >
                <option value="all">{t('pages:library.allWorlds')}</option>
                {worlds.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
            <div className="il-chips">
              <button
                type="button"
                className={`btn sm ${filter === 'all' ? 'primary' : 'ghost'}`}
                onClick={() => setFilter('all')}
              >
                {t('common:asset.all')}
              </button>
              <button
                type="button"
                className={`btn sm ${filter === 'unused' ? 'primary' : 'ghost'}`}
                onClick={() => setFilter('unused')}
                disabled={usages === undefined}
              >
                {t('pages:library.unused')}
                {unusedCount !== undefined && unusedCount > 0 && (
                  <span className="badge il-unused-badge">{unusedCount}</span>
                )}
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
            <span className="muted il-count">{t('pages:library.shownCount', { count: shown.length })}</span>
          </div>

          {shown.length === 0 ? (
            <p className="hint">{t('common:asset.noMatches')}</p>
          ) : (
            <div className="il-grid">
              {shown.map((a) => {
                const usage = usages?.[a.id];
                const isSelected = selected.has(a.id);
                // Which expression slots this image fills, across all characters.
                const expressions = usage ? [...new Set(usage.flatMap((u) => u.expressions ?? []))] : [];
                return (
                  <button
                    key={a.id}
                    type="button"
                    className={`il-card ${selecting && isSelected ? 'il-card-selected' : ''}`}
                    onClick={() => (selecting ? toggleSelect(a.id) : setDetail(a))}
                    aria-pressed={selecting ? isSelected : undefined}
                  >
                    <span className="il-card-img">
                      {/* key: an epoch bump must remount (resetting the fallback
                          state), or a pre-rebuild fallback would never retry. */}
                      <ThumbImg key={thumbEpoch} asset={a} epoch={thumbEpoch} />
                      {selecting && (
                        <span className={`il-tick ${isSelected ? 'on' : ''}`} aria-hidden>
                          ✓
                        </span>
                      )}
                    </span>
                    <span className="il-card-name" title={a.filename}>
                      {a.filename}
                    </span>
                    <span className="il-card-meta">
                      {/* The concrete expression name beats the generic
                          "Expressions" type chip whenever we know it. */}
                      {(expressions.length === 0 || a.type !== 'expression') && (
                        <span className="badge">{assetTypeLabel(a.type)}</span>
                      )}
                      {expressions.map((e) => (
                        <span key={e} className="badge il-badge-expr">
                          {expressionLabel(e)}
                        </span>
                      ))}
                      {usages !== undefined &&
                        (usage ? (
                          <span className="badge">{t('pages:library.usedCount', { count: usage.length })}</span>
                        ) : (
                          <span className="badge il-badge-unused">{t('pages:library.unused')}</span>
                        ))}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {detail && (
        <AssetDetail
          asset={detail}
          usage={usages?.[detail.id] ?? []}
          usageLoaded={usages !== undefined}
          busy={busy}
          onClose={() => setDetail(null)}
          onSaved={async () => {
            await reloadAssets();
            setDetail(null);
          }}
          onReplaced={async () => {
            await reloadAssets();
            setThumbEpoch((e) => e + 1); // stale-cache buster: retry thumb URLs
            setNote(t('pages:library.replaced'));
            setDetail(null);
          }}
          onDelete={() => setPendingDelete([detail.id])}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          danger
          title={t('pages:library.deleteTitle', { count: pendingDelete.length })}
          body={
            inUseSelected > 0
              ? t('pages:library.deleteInUseWarn', { count: inUseSelected })
              : t('pages:library.deleteBody', { count: pendingDelete.length })
          }
          confirmLabel={t('pages:library.deleteConfirm')}
          busy={busy}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void runDelete(pendingDelete)}
        />
      )}
    </div>
  );
}

/** Thumb with graceful fallback: pre-thumbnail uploads 404 on the thumb URL and
 *  drop back to the original. `epoch` remounts after a rebuild so they retry. */
function ThumbImg({ asset, epoch }: { asset: Asset; epoch: number }) {
  const [fallback, setFallback] = useState(false);
  // The epoch query also busts the browser cache after an in-place replace,
  // where the URL would otherwise be identical to the old image's.
  const bust = epoch ? `?e=${epoch}` : '';
  return (
    <img
      src={fallback ? `${assetUrl(asset.path)}${bust}` : `${assetThumbUrl(asset.path)}${bust}`}
      alt={asset.altText || asset.filename}
      loading="lazy"
      decoding="async"
      onError={() => setFallback(true)}
    />
  );
}

function AssetDetail({
  asset,
  usage,
  usageLoaded,
  busy,
  onClose,
  onSaved,
  onReplaced,
  onDelete,
}: {
  asset: Asset;
  usage: AssetUsage[];
  usageLoaded: boolean;
  busy: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onReplaced: () => Promise<void>;
  onDelete: () => void;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const [form, setForm] = useState<Required<AssetUpdate>>({
    filename: asset.filename,
    altText: asset.altText,
    tags: asset.tags,
    type: asset.type,
  });
  const [saving, setSaving] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState<string>();
  const replaceRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await api.updateAsset(asset.id, form);
      await onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  const replace = async (file: File) => {
    setError(undefined);
    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(t('common:unsupportedImage', { label: ALLOWED_IMAGE_LABEL }));
      if (replaceRef.current) replaceRef.current.value = '';
      return;
    }
    setReplacing(true);
    try {
      await api.replaceAssetFile(asset.id, file);
      await onReplaced();
    } catch (e) {
      setError(errorMessage(e));
      setReplacing(false);
      if (replaceRef.current) replaceRef.current.value = '';
    }
  };

  const working = saving || replacing;

  return (
    <Modal onClose={() => !working && onClose()}>
      <div className="kicker">{t('pages:library.detailKicker')}</div>
      <h2 style={{ marginTop: 0 }}>{form.filename}</h2>

      <div className="il-detail-preview">
        <img src={assetUrl(asset.path)} alt={form.altText || form.filename} />
      </div>

      <div className="il-replace-row">
        <label className={`btn sm ghost ${working || busy ? 'disabled' : ''}`} style={{ cursor: 'pointer' }}>
          <Icon name="upload" size={13} />
          {replacing ? t('pages:library.replacing') : t('pages:library.replace')}
          <input
            ref={replaceRef}
            type="file"
            accept={IMAGE_UPLOAD_ACCEPT}
            hidden
            disabled={working || busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void replace(f);
            }}
          />
        </label>
        <span className="hint">{t('pages:library.replaceHint')}</span>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="stack" style={{ gap: 12 }}>
        <Field label={t('pages:library.fieldName')}>
          <input
            value={form.filename}
            maxLength={120}
            onChange={(e) => setForm((f) => ({ ...f, filename: e.target.value }))}
          />
        </Field>
        <Field label={t('pages:library.fieldType')}>
          <select
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as AssetType }))}
          >
            {AssetTypeSchema.options.map((ty) => (
              <option key={ty} value={ty}>
                {assetTypeLabel(ty)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('pages:library.fieldAlt')} hint={t('pages:library.fieldAltHint')}>
          <textarea
            value={form.altText}
            maxLength={300}
            rows={2}
            onChange={(e) => setForm((f) => ({ ...f, altText: e.target.value }))}
          />
        </Field>
        <Field label={t('pages:library.fieldTags')}>
          <TagInput value={form.tags} onChange={(tags) => setForm((f) => ({ ...f, tags }))} />
        </Field>

        <div>
          <div className="kicker">{t('pages:library.usageHead')}</div>
          {!usageLoaded ? null : usage.length === 0 ? (
            <p className="hint">{t('pages:library.usageNone')}</p>
          ) : (
            <ul className="il-usage-list">
              {usage.map((u, i) => (
                <li key={`${u.kind}-${u.refId}-${i}`}>
                  <span className="badge">{assetUsageKindLabel(u.kind)}</span>
                  <span className="il-usage-label">
                    {u.kind === 'texts'
                      ? t('pages:library.textsCount', { count: u.count ?? 0 })
                      : u.expressions?.length
                        ? `${u.label} — ${u.expressions.map((e) => expressionLabel(e)).join(', ')}`
                        : u.label}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="row il-detail-actions">
        <button className="btn danger" onClick={onDelete} disabled={working || busy}>
          <Icon name="trash" size={14} />
          {t('pages:library.delete')}
        </button>
        <span className="flex-fill" />
        <button className="btn ghost" onClick={onClose} disabled={working}>
          {t('common:cancel')}
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={working || !form.filename.trim()}>
          {saving ? t('pages:library.saving') : t('pages:library.save')}
        </button>
      </div>
    </Modal>
  );
}
