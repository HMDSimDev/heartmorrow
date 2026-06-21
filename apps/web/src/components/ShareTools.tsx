import { useRef, useState } from 'react';
import type { Character, PackCharacterPreview, PackImportResult, PackInspectResult, World } from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { Icon } from './Icon';
import { Banner, Modal } from './ui';
import './sharetools.css';

const ACCEPT = '.hmchr,.hmwrld,.hmpack';

function kindNoun(kind: PackInspectResult['kind']): string {
  return kind === 'character' ? 'character file' : kind === 'world' ? 'world file' : 'bundle';
}

function fmtDate(ms: number): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function countLine(parts: Array<[number, string, string]>): string {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
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
  return (
    <div className="share-world">
      <div className="share-world-head">
        <span className="share-world-name">{name}</span>
        {tone && <span className="share-chip">{tone}</span>}
      </div>
      {summary && <p className="share-world-sum">{summary}</p>}
      {locations.length > 0 && (
        <div className="share-world-locs">
          <Icon name="location" size={13} /> {locations.length} {locations.length === 1 ? 'location' : 'locations'}
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
  const showCharToggle = preview.worlds.length > 0 && preview.characters.length > 0;
  const date = fmtDate(preview.createdAt);
  const summary = countLine([
    [preview.counts.worlds, 'world', 'worlds'],
    [includeChars || !showCharToggle ? preview.counts.characters : 0, 'character', 'characters'],
    [preview.counts.assets, 'image', 'images'],
  ]);

  return (
    <Modal onClose={busy ? () => {} : onCancel}>
      <div className="kicker">Import share file</div>
      <h2 className="share-title">{preview.title || 'Heartmorrow share'}</h2>
      <p className="hint share-sub">
        {kindNoun(preview.kind)}
        {date ? ` · made ${date}` : ''}
        {preview.formatVersion ? ` · format v${preview.formatVersion}` : ''}
      </p>
      {preview.note && <p className="share-note">“{preview.note}”</p>}

      <p className="share-adds">Adds {summary || 'nothing'} to your almanac. Your existing worlds and people are untouched.</p>

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
            meta={countLine([
              [w.characterCount, 'person', 'people'],
              [w.propertyCount, 'property', 'properties'],
              [w.companyCount, 'company', 'companies'],
            ])}
          />
        ))}

        {preview.characters.length > 0 && (includeChars || !showCharToggle) && (
          <div className={`share-people${showCharToggle ? '' : ''}`}>
            <div className="share-section-head">
              <Icon name="people" size={14} /> {preview.characters.length}{' '}
              {preview.characters.length === 1 ? 'person' : 'people'}
            </div>
            <ul className="share-people-list">
              {preview.characters.slice(0, 40).map((c, i) => (
                <CharacterRow key={i} c={c} />
              ))}
            </ul>
            {preview.characters.length > 40 && (
              <div className="share-more">+{preview.characters.length - 40} more</div>
            )}
          </div>
        )}
      </div>

      {showCharToggle && (
        <label className="share-toggle">
          <input type="checkbox" checked={includeChars} onChange={(e) => onToggleChars(e.target.checked)} />
          <span>
            Import the {preview.counts.characters} {preview.counts.characters === 1 ? 'character' : 'characters'} too —
            uncheck to take just the world{preview.counts.worlds === 1 ? '' : 's'} &amp; its locations
          </span>
        </label>
      )}

      {error && <Banner kind="error">{error}</Banner>}

      <div className="row end share-actions">
        <button className="btn ghost" onClick={onCancel} disabled={busy} type="button">
          Cancel
        </button>
        <button className="btn primary" onClick={onConfirm} disabled={busy} type="button" autoFocus>
          {busy ? 'Importing…' : 'Import'}
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
  label = 'Import',
  className = 'btn ghost',
}: {
  targetWorldId?: string | null;
  onImported: (result: PackImportResult) => void;
  label?: string;
  className?: string;
}) {
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
        <Icon name="upload" size={16} /> {label}
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
          <div className="kicker">Couldn't read that file</div>
          <h2 style={{ marginTop: 0 }}>Import failed</h2>
          <Banner kind="error">{inspectError}</Banner>
          <div className="row end" style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => setInspectError(undefined)} type="button">
              Close
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
  const suggested =
    worlds.length === 1 && characters.length === 0
      ? worlds[0]!.name
      : characters.length === 1 && worlds.length === 0
        ? characters[0]!.name
        : 'Heartmorrow bundle';
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
      <div className="kicker">Export share file</div>
      <h2 className="share-title">Share {worlds.length > 0 ? (worlds.length === 1 ? 'a world' : `${worlds.length} worlds`) : `${characters.length} ${characters.length === 1 ? 'character' : 'characters'}`}</h2>
      <p className="hint share-sub">Saves a {ext} file you can hand to anyone — it carries the content, never your save.</p>

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
              <Icon name="people" size={14} /> {characters.length} {characters.length === 1 ? 'person' : 'people'}
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
          <span>Include each world's characters (uncheck to share just the world{worlds.length === 1 ? '' : 's'} &amp; its locations)</span>
        </label>
      )}

      <div className="field share-field">
        <label>Title</label>
        <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder={suggested} />
      </div>
      <div className="field share-field">
        <label>Note <span className="muted">(optional — a message for whoever opens it)</span></label>
        <textarea
          value={note}
          maxLength={2000}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. The full Lumen Quarter cast — let me know what you think!"
        />
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      <div className="row end share-actions">
        <button className="btn ghost" onClick={onClose} disabled={busy} type="button">
          Cancel
        </button>
        <button className="btn primary" onClick={download} disabled={busy} type="button">
          <Icon name="download" size={16} /> {busy ? 'Preparing…' : `Download ${ext}`}
        </button>
      </div>
    </Modal>
  );
}
