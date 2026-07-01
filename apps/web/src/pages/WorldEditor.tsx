import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  VENUE_TIERS,
  GAMBLING,
  type FeatureFlags,
  type GamblingConfig,
  type Location,
  type World,
  type WorldNote,
  type WorldNoteScope,
} from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { venueTierLabel, worldNoteScopeLabel } from '../i18n/labels';
import { Banner, ConfirmDialog, Empty, Field, Spinner, TagInput } from '../components/ui';
import { ResultCard, type ResultTone } from '../components/ResultCard';
import { DraftRestoreBar, UnsavedPill } from '../components/DraftBar';
import { useDraft } from '../lib/useDraft';
import { draftKey, listDrafts } from '../lib/drafts';
import { Icon } from '../components/Icon';
import { AssetPicker } from '../components/AssetPicker';
import { ShareExportDialog } from '../components/ShareTools';
import './creator.page.css';

const SCOPES: WorldNoteScope[] = ['global', 'location', 'faction', 'lore', 'rule', 'character', 'misc'];

// The user-editable slice of a World — exactly the fields save() sends. Drafts
// diff against THIS (not the whole record) so server-managed fields like
// updatedAt never make a freshly-loaded world look "unsaved".
type EditableWorld = Pick<
  World,
  'name' | 'summary' | 'tone' | 'globalNotes' | 'rules' | 'lore' | 'locations' | 'featureFlags' | 'gamblingConfig'
>;
const editableWorld = (w: World): EditableWorld => ({
  name: w.name,
  summary: w.summary,
  tone: w.tone,
  globalNotes: w.globalNotes,
  rules: w.rules,
  lore: w.lore,
  locations: w.locations,
  featureFlags: w.featureFlags,
  gamblingConfig: w.gamblingConfig,
});

export function WorldEditor() {
  const { t } = useTranslation(['pages', 'common']);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [world, setWorld] = useState<World | null>(null);
  // The saved snapshot of the selected world, diffed against `world` for drafts.
  const [baseline, setBaseline] = useState<World | null>(null);
  const [notes, setNotes] = useState<WorldNote[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<{ tone: ResultTone; seal: string; kicker: string; text: string }>();
  const [genPrompt, setGenPrompt] = useState('');
  const [genCount, setGenCount] = useState(4);
  const [generating, setGenerating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [deleteChars, setDeleteChars] = useState(false);
  const [deletingWorld, setDeletingWorld] = useState(false);
  const [creatingWorld, setCreatingWorld] = useState(false);

  const loadWorlds = async () => {
    setLoading(true);
    try {
      const list = await api.listWorlds();
      setWorlds(list);
      if (!selectedId && list[0]) setSelectedId(list[0].id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWorlds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track the live selection so an async op (e.g. location generation) can tell if the
  // user switched worlds mid-flight and drop a now-stale result instead of writing it
  // into the wrong world.
  const selectedIdRef = useRef(selectedId);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setWorld(null);
      setBaseline(null);
      setNotes([]);
      return;
    }
    void (async () => {
      try {
        const w = await api.getWorld(selectedId);
        setWorld(w);
        setBaseline(w); // the loaded world is the clean baseline for drafts
        setNotes(await api.listWorldNotes(selectedId));
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, [selectedId]);

  const createWorld = async () => {
    if (creatingWorld) return; // don't mint duplicate "New World" records on spam
    setCreatingWorld(true);
    try {
      const w = await api.createWorld({ name: 'New World' });
      await loadWorlds();
      setSelectedId(w.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCreatingWorld(false);
    }
  };

  // Auto-keep unsaved world edits as a draft, keyed by the selected world. The
  // sidebar can edit many worlds without a route change, so switching worlds
  // re-keys the draft (the hook flushes the leaving world's draft first).
  const draftValue = useMemo(() => (world ? editableWorld(world) : null), [world]);
  const draftBaseline = useMemo(() => (baseline ? editableWorld(baseline) : null), [baseline]);
  const draft = useDraft<EditableWorld>({
    key: selectedId ? draftKey.world(selectedId) : null,
    value: draftValue as EditableWorld,
    baseline: draftBaseline,
    enabled: !!world && !!baseline && world.id === selectedId && baseline.id === selectedId,
    meta: {
      kind: 'world',
      scopeId: selectedId ?? '',
      worldId: selectedId,
      isNew: false,
      label: () => world?.name?.trim() || t('pages:worldEditor.untitledWorld'),
    },
  });

  // Other worlds in the sidebar that carry an unsaved draft get a lamplit dot
  // (the selected world is excluded — its state is shown by the masthead pill).
  // `draft.persisted` re-reads localStorage right after a draft is written/cleared.
  const draftedWorldIds = useMemo(
    () => new Set(listDrafts({ kind: 'world' }).map((d) => d.scopeId)),
    [worlds, draft.persisted],
  );

  const setField = <K extends keyof World>(key: K, value: World[K]) =>
    setWorld((w) => (w ? { ...w, [key]: value } : w));

  const setFeature = <K extends keyof FeatureFlags>(key: K, value: FeatureFlags[K]) =>
    setWorld((w) => (w ? { ...w, featureFlags: { ...w.featureFlags, [key]: value } } : w));

  const setGambling = <K extends keyof GamblingConfig>(key: K, value: GamblingConfig[K]) =>
    setWorld((w) => (w ? { ...w, gamblingConfig: { ...w.gamblingConfig, [key]: value } } : w));

  const save = async () => {
    if (!world) return;
    setSaving(true);
    setSavedNote(undefined);
    setError(undefined);
    try {
      const updated = await api.updateWorld(world.id, {
        name: world.name,
        summary: world.summary,
        tone: world.tone,
        globalNotes: world.globalNotes,
        rules: world.rules,
        lore: world.lore,
        locations: world.locations,
        featureFlags: world.featureFlags,
        gamblingConfig: world.gamblingConfig,
      });
      setWorld(updated);
      setBaseline(updated); // saved → the world is clean again
      draft.clear();
      await loadWorlds();
      setSavedNote({ tone: 'brass', seal: '❧', kicker: t('pages:worldEditor.savedKicker'), text: t('pages:worldEditor.worldSaved') });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const deleteWorld = async () => {
    if (!world) return;
    setDeletingWorld(true);
    try {
      await api.deleteWorld(world.id, deleteChars);
      setSelectedId(null);
      await loadWorlds();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeletingWorld(false);
      setConfirmDelete(false);
      setDeleteChars(false);
    }
  };

  const addLocation = () =>
    setField('locations', [
      ...(world?.locations ?? []),
      { id: crypto.randomUUID(), name: 'New location', description: '', tags: [], indoor: false, priceTier: 0, imageAssetId: null },
    ]);

  const updateLocation = (i: number, patch: Partial<Location>) =>
    setField(
      'locations',
      (world?.locations ?? []).map((l, j) => (j === i ? { ...l, ...patch } : l)),
    );

  // Generate locations from the world's own lore + a free-form prompt. Drafts are
  // appended to the (unsaved) location list so they reuse the inline editor below;
  // the creator reviews/edits them and clicks "Save world" to keep them.
  const generateLocations = async () => {
    if (!world) return;
    const wid = world.id; // the world we're generating FOR — guard the seconds-long await
    setGenerating(true);
    setError(undefined);
    setSavedNote(undefined);
    try {
      const res = await api.generateLocations(wid, { count: genCount, prompt: genPrompt });
      // The user may have switched worlds during the await. If so, DROP the result
      // rather than merging world A's (stale-closure) locations into world B.
      if (selectedIdRef.current !== wid) return;
      if (res.ok) {
        // Merge into the CURRENT world state via the functional updater (never the
        // stale `world` closure), and only if it's still the world we generated for.
        setWorld((w) => (w && w.id === wid ? { ...w, locations: [...(w.locations ?? []), ...res.data] } : w));
        setSavedNote({ tone: 'brass', seal: '✦', kicker: t('pages:worldEditor.genKicker'), text: t('pages:worldEditor.generatedAdded', { count: res.data.length }) });
      } else {
        setError(t('pages:worldEditor.locGenFailed', { error: res.error }));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="we-layout stack">
      {/* ------------------------------------------------------------------ */}
      {/* Masthead                                                             */}
      {/* ------------------------------------------------------------------ */}
      <div className="framed creator-head">
        <div className="creator-head-titles">
          <div className="creator-meta">
            <span className="kicker">{t('pages:worldEditor.workbench')}</span>
            {world && (
              <span className="creator-tool-tag">
                {t('pages:worldEditor.locationsTag', { count: world.locations.length })}
              </span>
            )}
          </div>
          <h1>{t('pages:worldEditor.title')}</h1>
          <p>{t('pages:worldEditor.intro')}</p>
        </div>
        <div className="creator-head-actions">
          <button className="btn primary" onClick={createWorld} disabled={creatingWorld}>
            <Icon name="plus" size={14} />
            {t('pages:worldEditor.newWorld')}
          </button>
          {world && <UnsavedPill dirty={draft.dirty} failed={draft.persistError} />}
          {world && (
            <button
              className="btn ghost"
              onClick={() => setExportOpen(true)}
              disabled={saving || draft.dirty}
              title={draft.dirty ? t('pages:worldEditor.exportDirtyHint') : undefined}
            >
              <Icon name="download" size={14} />
              {t('pages:worldEditor.export')}
            </button>
          )}
          {world && (
            <button className="btn primary" onClick={save} disabled={saving}>
              <Icon name="save" size={14} />
              {saving ? t('pages:worldEditor.saving') : t('pages:worldEditor.saveWorld')}
            </button>
          )}
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {savedNote && <ResultCard tone={savedNote.tone} seal={savedNote.seal} kicker={savedNote.kicker} summary={savedNote.text} />}

      {draft.found && (
        <DraftRestoreBar
          env={draft.found}
          noun={t('pages:worldEditor.noun')}
          onRestore={() => {
            const d = draft.restore();
            if (d) setWorld((w) => (w ? { ...w, ...d } : w)); // merge editable fields, keep id/timestamps
          }}
          onDiscard={() => draft.discard()}
          onDismiss={() => draft.dismissFound()}
        />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Two-column layout: world list sidebar + detail pane                 */}
      {/* ------------------------------------------------------------------ */}
      <div className="we-canvas">

        {/* World list sidebar */}
        <aside className="we-sidebar">
          <div className="we-sidebar-header">
            <span className="kicker">{t('pages:worldEditor.worldsHeader')}</span>
          </div>
          {worlds.length === 0 ? (
            <p className="muted we-sidebar-empty">{t('pages:worldEditor.noWorlds')}</p>
          ) : (
            <ul className="we-world-list">
              {worlds.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    className={`we-world-item ${selectedId === w.id ? 'we-world-item-active' : ''}`}
                    onClick={() => setSelectedId(w.id)}
                  >
                    <Icon name="location" size={14} />
                    <span className="we-world-name">{w.name}</span>
                    {w.id !== selectedId && draftedWorldIds.has(w.id) && (
                      <span className="we-world-draft-dot" title={t('pages:worldEditor.hasUnsaved')} aria-label={t('pages:worldEditor.hasUnsaved')} />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Detail pane */}
        <div className="we-detail stack">
          {!world ? (
            <Empty title={t('pages:worldEditor.noWorldSelected')}>
              <p className="hint">{t('pages:worldEditor.pickOrCreate')}</p>
              <button className="btn primary" onClick={createWorld} disabled={creatingWorld}>
                <Icon name="plus" size={14} />
                {t('pages:worldEditor.createWorld')}
              </button>
            </Empty>
          ) : (
            <>
              <div className="grid cols-2">
                <div className="card">
                  <div className="creator-sec">
                    <span className="creator-index">01</span>
                    <h2>{t('pages:worldEditor.secSetting')}</h2>
                    <span className="trail" />
                  </div>
                  <Field label={t('pages:worldEditor.name')}>
                    <input value={world.name} onChange={(e) => setField('name', e.target.value)} />
                  </Field>
                  <Field label={t('pages:worldEditor.summary')}>
                    <textarea value={world.summary} onChange={(e) => setField('summary', e.target.value)} />
                  </Field>
                  <Field label={t('pages:worldEditor.tone')}>
                    <input value={world.tone} onChange={(e) => setField('tone', e.target.value)} />
                  </Field>
                  <Field label={t('pages:worldEditor.globalNotes')}>
                    <textarea value={world.globalNotes} onChange={(e) => setField('globalNotes', e.target.value)} />
                  </Field>
                </div>

                <div className="card">
                  <div className="creator-sec">
                    <span className="creator-index">02</span>
                    <h2>{t('pages:worldEditor.secLoreRules')}</h2>
                    <span className="trail" />
                  </div>
                  <Field label={t('pages:worldEditor.lore')}>
                    <textarea value={world.lore} onChange={(e) => setField('lore', e.target.value)} />
                  </Field>
                  <Field label={t('pages:worldEditor.rulesInFiction')}>
                    <textarea value={world.rules} onChange={(e) => setField('rules', e.target.value)} />
                  </Field>
                  <div className="divider" />
                  <div className="creator-sec">
                    <h3>{t('pages:worldEditor.gameFeatures')}</h3>
                    <span className="trail" />
                  </div>
                  <p className="muted" style={{ marginTop: 0 }}>{t('pages:worldEditor.featuresNote')}</p>
                  <div className="creator-flags">
                    <label className="creator-flag">
                      <input
                        type="checkbox"
                        checked={world.featureFlags.property}
                        onChange={(e) => setFeature('property', e.target.checked)}
                      />
                      {t('pages:worldEditor.featureProperty')}
                    </label>
                    <label className="creator-flag">
                      <input
                        type="checkbox"
                        checked={world.featureFlags.stockMarket}
                        onChange={(e) => setFeature('stockMarket', e.target.checked)}
                      />
                      {t('pages:worldEditor.featureStock')}
                    </label>
                    <label className="creator-flag">
                      <input
                        type="checkbox"
                        checked={world.featureFlags.gambling}
                        onChange={(e) => setFeature('gambling', e.target.checked)}
                      />
                      {t('pages:worldEditor.featureCasino')}
                    </label>
                  </div>
                  {world.featureFlags.gambling && (
                    <div className="row" style={{ gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
                      <Field label={t('pages:worldEditor.maxBet')} hint={t('pages:worldEditor.maxBetHint', { max: GAMBLING.ABSOLUTE_MAX_BET })}>
                        <input
                          type="number"
                          min={GAMBLING.MIN_BET}
                          max={GAMBLING.ABSOLUTE_MAX_BET}
                          value={world.gamblingConfig.maxBet}
                          onChange={(e) =>
                            setGambling('maxBet', Math.max(GAMBLING.MIN_BET, Math.min(GAMBLING.ABSOLUTE_MAX_BET, Number(e.target.value) || GAMBLING.MIN_BET)))
                          }
                        />
                      </Field>
                      <Field label={t('pages:worldEditor.dailyCap')} hint={t('pages:worldEditor.dailyCapHint', { max: GAMBLING.ABSOLUTE_MAX_DAILY_WAGER })}>
                        <input
                          type="number"
                          min={world.gamblingConfig.maxBet}
                          max={GAMBLING.ABSOLUTE_MAX_DAILY_WAGER}
                          value={world.gamblingConfig.dailyWagerLimit}
                          onChange={(e) =>
                            setGambling('dailyWagerLimit', Math.max(GAMBLING.MIN_BET, Math.min(GAMBLING.ABSOLUTE_MAX_DAILY_WAGER, Number(e.target.value) || GAMBLING.DEFAULT_DAILY_WAGER_LIMIT)))
                          }
                        />
                      </Field>
                    </div>
                  )}
                </div>
              </div>

              <div className="card">
                <div className="creator-sec">
                  <span className="creator-index">03</span>
                  <h2>{t('pages:worldEditor.secLocations')}</h2>
                  <span className="trail" />
                  <button className="btn sm creator-sec-action" onClick={addLocation}>
                    <Icon name="plus" size={13} />
                    {t('pages:worldEditor.addLocation')}
                  </button>
                </div>

                {/* AI generation subcard */}
                <div className="creator-subcard" style={{ marginBottom: 12 }}>
                  <div className="creator-sec">
                    <h3>
                      <Icon name="generate" size={14} />
                      {' '}{t('pages:worldEditor.generateWithAI')}
                    </h3>
                    <span className="trail" />
                  </div>
                  <p className="muted" style={{ marginTop: 0 }}>{t('pages:worldEditor.genNote')}</p>
                  <Field label={t('pages:worldEditor.promptLabel')}>
                    <textarea
                      placeholder={t('pages:worldEditor.promptPlaceholder')}
                      value={genPrompt}
                      onChange={(e) => setGenPrompt(e.target.value)}
                    />
                  </Field>
                  <div className="we-gen-row">
                    <Field label={t('pages:worldEditor.howMany')}>
                      <select value={genCount} onChange={(e) => setGenCount(Number(e.target.value))}>
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <button className="btn primary we-gen-btn" onClick={generateLocations} disabled={generating}>
                      <Icon name="generate" size={14} />
                      {generating ? t('pages:worldEditor.generating') : t('pages:worldEditor.generateLocations')}
                    </button>
                  </div>
                </div>

                {world.locations.length === 0 && <p className="muted">{t('pages:worldEditor.noLocations')}</p>}

                {/* Location list — each one is a collapsible card */}
                <div className="we-locations">
                  {world.locations.map((loc, i) => (
                    <LocationCard
                      key={loc.id}
                      location={loc}
                      onUpdate={(patch) => updateLocation(i, patch)}
                      onRemove={() => setField('locations', world.locations.filter((_, j) => j !== i))}
                    />
                  ))}
                </div>
              </div>

              <div className="row end">
                <button className="btn danger ghost" onClick={() => setConfirmDelete(true)}>
                  <Icon name="trash" size={14} />
                  {t('pages:worldEditor.deleteWorld')}
                </button>
                <button className="btn primary" onClick={save} disabled={saving}>
                  <Icon name="save" size={14} />
                  {saving ? t('pages:worldEditor.saving') : t('pages:worldEditor.saveWorld')}
                </button>
              </div>

              <WorldNotes worldId={world.id} notes={notes} onChange={setNotes} onError={setError} />
            </>
          )}
        </div>
      </div>

      {exportOpen && world && (
        <ShareExportDialog worlds={[world]} characters={[]} onClose={() => setExportOpen(false)} />
      )}

      {/* ConfirmDialog for world deletion */}
      {confirmDelete && world && (
        <ConfirmDialog
          kicker={t('pages:worldEditor.deleteKicker')}
          title={t('pages:worldEditor.deleteTitle', { name: world.name })}
          body={
            <>
              {t('pages:worldEditor.deleteBody')}
              <label
                style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer', marginTop: 12 }}
              >
                <input
                  type="checkbox"
                  checked={deleteChars}
                  onChange={(e) => setDeleteChars(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>{t('pages:worldEditor.deleteCharsLabel')}</span>
              </label>
            </>
          }
          confirmLabel={t('pages:worldEditor.deleteWorld')}
          danger
          busy={deletingWorld}
          onConfirm={deleteWorld}
          onCancel={() => {
            setConfirmDelete(false);
            setDeleteChars(false);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LocationCard — collapsible per-location editor
// ---------------------------------------------------------------------------

function LocationCard({
  location,
  onUpdate,
  onRemove,
}: {
  location: Location;
  onUpdate: (patch: Partial<Location>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('pages');
  const [open, setOpen] = useState(false);

  return (
    <div className="we-loc-card creator-subcard">
      {/* Summary row — always visible */}
      <div className="we-loc-header">
        <button
          type="button"
          className="we-loc-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
          <span className="we-loc-name">{location.name || t('worldEditor.untitledLocation')}</span>
          {location.indoor && <span className="badge we-loc-badge">{t('worldEditor.indoorBadge')}</span>}
          {location.tags.slice(0, 3).map((tag) => (
            <span className="badge" key={tag}>{tag}</span>
          ))}
          {location.tags.length > 3 && (
            <span className="badge">+{location.tags.length - 3}</span>
          )}
        </button>
        <button className="btn sm danger" onClick={onRemove} title={t('worldEditor.removeLocation')}>
          <Icon name="trash" size={13} />
        </button>
      </div>

      {/* Expandable detail */}
      {open && (
        <div className="we-loc-body stack">
          <Field label={t('worldEditor.locName')}>
            <input value={location.name} onChange={(e) => onUpdate({ name: e.target.value })} />
          </Field>
          <Field label={t('worldEditor.locDescription')}>
            <textarea
              placeholder={t('worldEditor.locDescPlaceholder')}
              value={location.description}
              onChange={(e) => onUpdate({ description: e.target.value })}
            />
          </Field>
          <Field label={t('worldEditor.locTags')}>
            <TagInput value={location.tags} onChange={(tags) => onUpdate({ tags })} placeholder={t('worldEditor.tagsPlaceholder')} />
          </Field>
          <label className="we-loc-indoor">
            <input
              type="checkbox"
              checked={location.indoor}
              onChange={(e) => onUpdate({ indoor: e.target.checked })}
            />
            {t('worldEditor.indoorLabel')}
          </label>
          <Field label={t('worldEditor.costToDate')}>
            <select
              value={location.priceTier ?? 0}
              onChange={(e) => onUpdate({ priceTier: Number(e.target.value) })}
            >
              {VENUE_TIERS.map((tier) => (
                <option key={tier.tier} value={tier.tier}>
                  {venueTierLabel(tier.tier)}
                  {tier.cost > 0
                    ? t('worldEditor.tierCost', { symbol: tier.symbol, cost: tier.cost })
                    : t('worldEditor.tierNoCost')}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('worldEditor.photoOptional')}>
            <AssetPicker
              value={location.imageAssetId ?? null}
              onChange={(imageAssetId) => onUpdate({ imageAssetId })}
              uploadType="location"
              filterType="location"
            />
            <small className="muted">{t('worldEditor.photoHint')}</small>
          </Field>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorldNotes sub-component (unchanged logic, icons added)
// ---------------------------------------------------------------------------

function WorldNotes({
  worldId,
  notes,
  onChange,
  onError,
}: {
  worldId: string;
  notes: WorldNote[];
  onChange: (notes: WorldNote[]) => void;
  onError: (e: string) => void;
}) {
  const { t } = useTranslation('pages');
  const [draft, setDraft] = useState({ title: '', body: '', scope: 'global' as WorldNoteScope, importance: 3 });
  const [adding, setAdding] = useState(false);

  const refresh = async () => onChange(await api.listWorldNotes(worldId));

  const add = async () => {
    if (!draft.title.trim() || adding) return;
    setAdding(true);
    try {
      await api.createWorldNote(worldId, {
        title: draft.title.trim(),
        body: draft.body,
        scope: draft.scope,
        importance: draft.importance,
        tags: [],
      });
      setDraft({ title: '', body: '', scope: 'global', importance: 3 });
      await refresh();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="card">
      <div className="creator-sec">
        <span className="creator-index">04</span>
        <h2>{t('worldEditor.secNotes')}</h2>
        <span className="trail" />
      </div>
      <div className="creator-callout">
        <span className="creator-callout-mark">
          <Icon name="info" size={13} />
        </span>
        <span>{t('worldEditor.notesCallout')}</span>
      </div>
      <div className="rule" />
      <div className="grid cols-2">
        <Field label={t('worldEditor.noteTitle')}>
          <input value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
        </Field>
        <div className="inline-fields">
          <Field label={t('worldEditor.noteScope')}>
            <select
              value={draft.scope}
              onChange={(e) => setDraft((d) => ({ ...d, scope: e.target.value as WorldNoteScope }))}
            >
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {worldNoteScopeLabel(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('worldEditor.noteImportance')}>
            <select
              value={draft.importance}
              onChange={(e) => setDraft((d) => ({ ...d, importance: Number(e.target.value) }))}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <Field label={t('worldEditor.noteBody')}>
        <textarea value={draft.body} onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} />
      </Field>
      <button className="btn" onClick={add} disabled={adding || !draft.title.trim()}>
        <Icon name="plus" size={14} />
        {adding ? t('worldEditor.adding') : t('worldEditor.addNote')}
      </button>

      <div className="divider" />
      {notes.length === 0 ? (
        <p className="muted">{t('worldEditor.noNotes')}</p>
      ) : (
        notes.map((n) => (
          <div className="list-item" key={n.id}>
            <span className="badge">{worldNoteScopeLabel(n.scope)}</span>
            <span className="badge accent">{n.importance}</span>
            <div className="flex-fill">
              <strong>{n.title}</strong>
              <div className="dim" style={{ fontSize: '0.85rem' }}>
                {n.body}
              </div>
            </div>
            <button
              className="btn sm danger"
              onClick={async () => {
                await api.deleteWorldNote(n.id);
                onChange(await api.listWorldNotes(worldId));
              }}
            >
              {t('worldEditor.delete')}
            </button>
          </div>
        ))
      )}
    </div>
  );
}
