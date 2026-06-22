import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Character, PackCharacterPreview, PackImportResult, PackInspectResult, World } from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { Icon } from './Icon';
import { Banner, Modal } from './ui';
import './sharetools.css';

const ACCEPT = '.hmchr,.hmwrld,.hmpack';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

function kindNounKey(kind: PackInspectResult['kind']): string {
  return kind === 'character' ? 'share.characterFile' : kind === 'world' ? 'share.worldFile' : 'share.bundle';
}

function fmtDate(ms: number, lang: string): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

/** Join localized "N thing" fragments (ICU-pluralized) with ' · ', dropping zeros. */
function joinCounts(t: TFn, parts: Array<[number, string]>): string {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, key]) => t(key, { count: n }))
    .join(' · ');
}

// --- shared bits ------------------------------------------------------------

function WorldCardView({
  name,
  tone,
  summary,
  locations,
  meta,
}: {
  name: string;
  tone: string;
  summary: string;
  locations: string[];
  meta?: string;
}) {
  const { t } = useTranslation(['pages', 'common']);
  return (
    <div className="share-world">
      <div className="share-world-head">
        <span className="share-world-name">{name}</span>
        {tone && <span className="share-chip">{tone}</span>}
      </div>
      {summary && <p className="share-world-sum">{summary}</p>}
      {locations.length > 0 && (
        <div className="share-world-locs">
          <Icon name="location" size={13} /> {t('share.locations', { count: locations.length })}
          <span className="share-locs-list">: {locations.slice(0, 8).join(', ')}{locations.length > 8 ? '…' : ''}</span>
        </div>
      )}
      {meta && <div className="share-world-meta">{meta}</div>}
    </div>
  );
}

function CharacterRow({ c }: { c: PackCharacterPreview }) {
  return (
    <li className="share-person">
      <span className="share-person-port" aria-hidden="true">
        <Icon name={c.hasPortrait ? 'image' : 'people'} size={13} />
      </span>
      <span className="share-person-main">
        <span className="share-person-name">{c.name}</span>
        <span className="share-person-meta">
          {c.age}
          {c.pronouns ? ` · ${c.pronouns}` : ''}
        </span>
        {c.shortDescription && <span className="share-person-desc">{c.shortDescription}</span>}
      </span>
    </li>
  );
}

// --- import -----------------------------------------------------------------

/** The rich, read-only preview of an uploaded share file: what worlds + people it
 *  holds, with a toggle to take the cast or just the world(s). */
function ImportPreview({
  preview,
  includeChars,
  onToggleChars,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  preview: PackInspectResult;
  includeChars: boolean;
  onToggleChars: (on: boolean) => void;
  busy: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t, i18n } = useTranslation(['pages', 'common']);
  const tt = t as unknown as TFn;
  const showCharToggle = preview.worlds.length > 0 && preview.characters.length > 0;
  const date = fmtDate(preview.createdAt, i18n.language);
  const summary = joinCounts(tt, [
    [preview.counts.worlds, 'share.cWorlds'],
    [includeChars || !showCharToggle ? preview.counts.characters : 0, 'share.cCharacters'],
    [preview.counts.assets, 'share.cImages'],
  ]);

  return (
    <Modal onClose={busy ? () => {} : onCancel}>
      <div className="kicker">{t('share.importTitle')}</div>
      <h2 className="share-title">{preview.title || t('share.shareFallback')}</h2>
      <p className="hint share-sub">
        {tt(kindNounKey(preview.kind))}
        {date ? t('share.madeOn', { date }) : ''}
        {preview.formatVersion ? t('share.formatV', { version: preview.formatVersion }) : ''}
      </p>
      {preview.note && <p className="share-note">“{preview.note}”</p>}

      <p className="share-adds">{t('share.addsSummary', { summary: summary || t('share.nothing') })}</p>

      {preview.warnings.map((w, i) => (
        <Banner kind="info" key={i}>
          {w}
        </Banner>
      ))}

      <div className="share-scroll">
        {preview.worlds.map((w, i) => (
          <WorldCardView
            key={i}
            name={w.name}
            tone={w.tone}
            summary={w.summary}
            locations={w.locations}
            meta={joinCounts(tt, [
              [w.characterCount, 'share.cPeople'],
              [w.propertyCount, 'share.cProperties'],
              [w.companyCount, 'share.cCompanies'],
            ])}
          />
        ))}

        {preview.characters.length > 0 && (includeChars || !showCharToggle) && (
          <div className={`share-people${showCharToggle ? '' : ''}`}>
            <div className="share-section-head">
              <Icon name="people" size={14} /> {t('share.peopleHead', { count: preview.characters.length })}
            </div>
            <ul className="share-people-list">
              {preview.characters.slice(0, 40).map((c, i) => (
                <CharacterRow key={i} c={c} />
              ))}
            </ul>
            {preview.characters.length > 40 && (
              <div className="share-more">{t('share.more', { count: preview.characters.length - 40 })}</div>
            )}
          </div>
        )}
      </div>

      {showCharToggle && (
        <label className="share-toggle">
          <input type="checkbox" checked={includeChars} onChange={(e) => onToggleChars(e.target.checked)} />
          <span>
            {t('share.importCharsToggle', { count: preview.counts.characters, worlds: preview.counts.worlds })}
          </span>
        </label>
      )}

      {error && <Banner kind="error">{error}</Banner>}

      <div className="row end share-actions">
        <button className="btn ghost" onClick={onCancel} disabled={busy} type="button">
          {t('share.cancel')}
        </button>
        <button className="btn primary" onClick={onConfirm} disabled={busy} type="button" autoFocus>
          {busy ? t('share.importing') : t('share.import')}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Import a `.hmchr` / `.hmwrld` / `.hmpack` share file. Reads + previews the file
 * first (a safe, read-only inspect) showing exactly what's inside, then imports on
 * confirm. Loose characters land in `targetWorldId` when provided.
 */
export function ShareImportButton({
  targetWorldId,
  onImported,
  label,
  className = 'btn ghost',
}: {
  targetWorldId?: string | null;
  onImported: (result: PackImportResult) => void;
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file: File; preview: PackInspectResult } | null>(null);
  const [includeChars, setIncludeChars] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [inspectError, setInspectError] = useState<string>();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(undefined);
    setInspectError(undefined);
    setIncludeChars(true);
    try {
      const preview = await api.inspectPackFile(file);
      setPending({ file, preview });
    } catch (err) {
      setInspectError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!pending) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.importPackFile(pending.file, targetWorldId ?? undefined, includeChars);
      setPending(null);
      onImported(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className={className} onClick={() => inputRef.current?.click()} disabled={busy} type="button">
        <Icon name="upload" size={16} /> {label ?? t('share.import')}
      </button>
      <input ref={inputRef} type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={onFile} />

      {pending && (
        <ImportPreview
          preview={pending.preview}
          includeChars={includeChars}
          onToggleChars={setIncludeChars}
          busy={busy}
          error={error}
          onConfirm={confirmImport}
          onCancel={() => {
            if (busy) return;
            setPending(null);
            setError(undefined);
          }}
        />
      )}

      {inspectError && (
        <Modal onClose={() => setInspectError(undefined)}>
          <div className="kicker">{t('share.cantRead')}</div>
          <h2 style={{ marginTop: 0 }}>{t('share.importFailed')}</h2>
          <Banner kind="error">{inspectError}</Banner>
          <div className="row end" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => setInspectError(undefined)} type="button">
              {t('share.close')}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

// --- export -----------------------------------------------------------------

/**
 * A preview-and-tweak step before downloading a share file: shows the selected
 * worlds (with their locations) and people, lets the creator set a title + note and
 * choose whether the cast travels, then downloads the right file type.
 */
export function ShareExportDialog({
  worlds,
  characters,
  onClose,
}: {
  worlds: World[];
  characters: Character[];
  onClose: () => void;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const suggested =
    worlds.length === 1 && characters.length === 0
      ? worlds[0]!.name
      : characters.length === 1 && worlds.length === 0
        ? characters[0]!.name
        : t('share.bundleName');
  const [title, setTitle] = useState(suggested);
  const [note, setNote] = useState('');
  const [includeChars, setIncludeChars] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const ext =
    worlds.length === 1 && characters.length === 0
      ? '.hmwrld'
      : worlds.length === 0 && characters.length === 1
        ? '.hmchr'
        : worlds.length === 0
          ? '.hmpack'
          : '.hmpack';

  const download = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.exportBundleFile({
        worldIds: worlds.map((w) => w.id),
        characterIds: characters.map((c) => c.id),
        includeCharacters: includeChars,
        title: title.trim(),
        note: note.trim(),
      });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={busy ? () => {} : onClose}>
      <div className="kicker">{t('share.exportTitle')}</div>
      <h2 className="share-title">
        {worlds.length > 0
          ? worlds.length === 1
            ? t('share.shareWorld')
            : t('share.shareWorlds', { count: worlds.length })
          : t('share.shareCharacters', { count: characters.length })}
      </h2>
      <p className="hint share-sub">{t('share.exportSub', { ext })}</p>

      <div className="share-scroll">
        {worlds.map((w) => (
          <WorldCardView
            key={w.id}
            name={w.name}
            tone={w.tone}
            summary={w.summary}
            locations={(w.locations ?? []).map((l) => l.name)}
          />
        ))}
        {characters.length > 0 && (
          <div className="share-people">
            <div className="share-section-head">
              <Icon name="people" size={14} /> {t('share.peopleHead', { count: characters.length })}
            </div>
            <ul className="share-people-list">
              {characters.slice(0, 40).map((c) => (
                <CharacterRow
                  key={c.id}
                  c={{
                    name: c.name,
                    age: c.age,
                    pronouns: c.pronouns,
                    shortDescription: c.shortDescription,
                    hasPortrait: !!c.portraitAssetId,
                    world: null,
                  }}
                />
              ))}
            </ul>
          </div>
        )}
      </div>

      {worlds.length > 0 && (
        <label className="share-toggle">
          <input type="checkbox" checked={includeChars} onChange={(e) => setIncludeChars(e.target.checked)} />
          <span>{t('share.exportCharsToggle', { count: worlds.length })}</span>
        </label>
      )}

      <div className="field share-field">
        <label>{t('share.title')}</label>
        <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder={suggested} />
      </div>
      <div className="field share-field">
        <label>{t('share.note')} <span className="muted">{t('share.noteOptional')}</span></label>
        <textarea
          value={note}
          maxLength={2000}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('share.notePlaceholder')}
        />
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="row end share-actions">
        <button className="btn ghost" onClick={onClose} disabled={busy} type="button">
          {t('share.cancel')}
        </button>
        <button className="btn primary" onClick={download} disabled={busy} type="button">
          <Icon name="download" size={16} /> {busy ? t('share.preparing') : t('share.download', { ext })}
        </button>
      </div>
    </Modal>
  );
}
