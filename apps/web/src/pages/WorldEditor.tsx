import { useEffect, useState } from 'react';
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
import { Banner, ConfirmDialog, Empty, Field, Spinner, TagInput } from '../components/ui';
import { Icon } from '../components/Icon';
import './creator.page.css';

const SCOPES: WorldNoteScope[] = ['global', 'location', 'faction', 'lore', 'rule', 'character', 'misc'];

export function WorldEditor() {
  const [worlds, setWorlds] = useState<World[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [world, setWorld] = useState<World | null>(null);
  const [notes, setNotes] = useState<WorldNote[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string>();
  const [genPrompt, setGenPrompt] = useState('');
  const [genCount, setGenCount] = useState(4);
  const [generating, setGenerating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  useEffect(() => {
    if (!selectedId) {
      setWorld(null);
      setNotes([]);
      return;
    }
    void (async () => {
      try {
        setWorld(await api.getWorld(selectedId));
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
      await loadWorlds();
      setSavedNote('World saved!');
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
      await api.deleteWorld(world.id);
      setSelectedId(null);
      await loadWorlds();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeletingWorld(false);
      setConfirmDelete(false);
    }
  };

  const addLocation = () =>
    setField('locations', [
      ...(world?.locations ?? []),
      { id: crypto.randomUUID(), name: 'New location', description: '', tags: [], indoor: false, priceTier: 0 },
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
    setGenerating(true);
    setError(undefined);
    setSavedNote(undefined);
    try {
      const res = await api.generateLocations(world.id, { count: genCount, prompt: genPrompt });
      if (res.ok) {
        setField('locations', [...(world.locations ?? []), ...res.data]);
        setSavedNote(
          `Added ${res.data.length} generated location${res.data.length === 1 ? '' : 's'} below — review, then Save world to keep them.`,
        );
      } else {
        setError(`Location generation failed: ${res.error}`);
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
            <span className="kicker">World workbench</span>
            {world && <span className="creator-tool-tag">{world.locations.length} locations</span>}
          </div>
          <h1>World editor</h1>
          <p>Define the setting. World/lore notes are sent to the model as reference data, not as instructions.</p>
        </div>
        <div className="creator-head-actions">
          <button className="btn primary" onClick={createWorld} disabled={creatingWorld}>
            <Icon name="plus" size={14} />
            New world
          </button>
          {world && (
            <button className="btn primary" onClick={save} disabled={saving}>
              <Icon name="save" size={14} />
              {saving ? 'Saving…' : 'Save world'}
            </button>
          )}
        </div>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {savedNote && <Banner kind="ok">{savedNote}</Banner>}

      {/* ------------------------------------------------------------------ */}
      {/* Two-column layout: world list sidebar + detail pane                 */}
      {/* ------------------------------------------------------------------ */}
      <div className="we-canvas">

        {/* World list sidebar */}
        <aside className="we-sidebar">
          <div className="we-sidebar-header">
            <span className="kicker">Worlds</span>
          </div>
          {worlds.length === 0 ? (
            <p className="muted we-sidebar-empty">No worlds yet.</p>
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
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Detail pane */}
        <div className="we-detail stack">
          {!world ? (
            <Empty title="No world selected">
              <p className="hint">Pick a world from the list, or create one.</p>
              <button className="btn primary" onClick={createWorld} disabled={creatingWorld}>
                <Icon name="plus" size={14} />
                Create a world
              </button>
            </Empty>
          ) : (
            <>
              <div className="grid cols-2">
                <div className="card">
                  <div className="creator-sec">
                    <span className="creator-index">01</span>
                    <h2>Setting</h2>
                    <span className="trail" />
                  </div>
                  <Field label="Name">
                    <input value={world.name} onChange={(e) => setField('name', e.target.value)} />
                  </Field>
                  <Field label="Summary">
                    <textarea value={world.summary} onChange={(e) => setField('summary', e.target.value)} />
                  </Field>
                  <Field label="Tone">
                    <input value={world.tone} onChange={(e) => setField('tone', e.target.value)} />
                  </Field>
                  <Field label="Global notes">
                    <textarea value={world.globalNotes} onChange={(e) => setField('globalNotes', e.target.value)} />
                  </Field>
                </div>

                <div className="card">
                  <div className="creator-sec">
                    <span className="creator-index">02</span>
                    <h2>Lore & rules</h2>
                    <span className="trail" />
                  </div>
                  <Field label="Lore">
                    <textarea value={world.lore} onChange={(e) => setField('lore', e.target.value)} />
                  </Field>
                  <Field label="Rules (in-fiction)">
                    <textarea value={world.rules} onChange={(e) => setField('rules', e.target.value)} />
                  </Field>
                  <div className="divider" />
                  <div className="creator-sec">
                    <h3>Game features</h3>
                    <span className="trail" />
                  </div>
                  <p className="muted" style={{ marginTop: 0 }}>
                    Optional life-and-money systems. Turn these off for a world where they wouldn&apos;t fit — the
                    apps disappear and authored property/companies simply lie dormant.
                  </p>
                  <div className="creator-flags">
                    <label className="creator-flag">
                      <input
                        type="checkbox"
                        checked={world.featureFlags.property}
                        onChange={(e) => setFeature('property', e.target.checked)}
                      />
                      Property — rent or buy places, collect rent, date there for a buff
                    </label>
                    <label className="creator-flag">
                      <input
                        type="checkbox"
                        checked={world.featureFlags.stockMarket}
                        onChange={(e) => setFeature('stockMarket', e.target.checked)}
                      />
                      Stock market — invest in fictional in-world companies
                    </label>
                    <label className="creator-flag">
                      <input
                        type="checkbox"
                        checked={world.featureFlags.gambling}
                        onChange={(e) => setFeature('gambling', e.target.checked)}
                      />
                      Casino — wager money on slots, blackjack, roulette &amp; video poker
                    </label>
                  </div>
                  {world.featureFlags.gambling && (
                    <div className="row" style={{ gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
                      <Field label="Max bet (◈)" hint={`Flat per-bet cap · up to ${GAMBLING.ABSOLUTE_MAX_BET}`}>
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
                      <Field label="Daily wager cap (◈)" hint={`Total staked per day · up to ${GAMBLING.ABSOLUTE_MAX_DAILY_WAGER}`}>
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
                  <h2>Locations</h2>
                  <span className="trail" />
                  <button className="btn sm creator-sec-action" onClick={addLocation}>
                    <Icon name="plus" size={13} />
                    Add location
                  </button>
                </div>

                {/* AI generation subcard */}
                <div className="creator-subcard" style={{ marginBottom: 12 }}>
                  <div className="creator-sec">
                    <h3>
                      <Icon name="generate" size={14} />
                      {' '}Generate with AI
                    </h3>
                    <span className="trail" />
                  </div>
                  <p className="muted" style={{ marginTop: 0 }}>
                    Describe what you want. The model uses this world&apos;s tone, lore, and existing locations to invent new
                    ones — they appear below for you to review and edit before saving.
                  </p>
                  <Field label="Prompt">
                    <textarea
                      placeholder="e.g. cozy rainy-evening spots near the old harbor district"
                      value={genPrompt}
                      onChange={(e) => setGenPrompt(e.target.value)}
                    />
                  </Field>
                  <div className="we-gen-row">
                    <Field label="How many">
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
                      {generating ? 'Generating…' : 'Generate locations'}
                    </button>
                  </div>
                </div>

                {world.locations.length === 0 && <p className="muted">No locations yet.</p>}

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
                  Delete world
                </button>
                <button className="btn primary" onClick={save} disabled={saving}>
                  <Icon name="save" size={14} />
                  {saving ? 'Saving…' : 'Save world'}
                </button>
              </div>

              <WorldNotes worldId={world.id} notes={notes} onChange={setNotes} onError={setError} />
            </>
          )}
        </div>
      </div>

      {/* ConfirmDialog for world deletion */}
      {confirmDelete && world && (
        <ConfirmDialog
          kicker="Destructive action"
          title={`Delete "${world.name}"?`}
          body="Notes are removed; characters are detached. This cannot be undone."
          confirmLabel="Delete world"
          danger
          busy={deletingWorld}
          onConfirm={deleteWorld}
          onCancel={() => setConfirmDelete(false)}
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
          <span className="we-loc-name">{location.name || 'Untitled location'}</span>
          {location.indoor && <span className="badge we-loc-badge">Indoor</span>}
          {location.tags.slice(0, 3).map((t) => (
            <span className="badge" key={t}>{t}</span>
          ))}
          {location.tags.length > 3 && (
            <span className="badge">+{location.tags.length - 3}</span>
          )}
        </button>
        <button className="btn sm danger" onClick={onRemove} title="Remove location">
          <Icon name="trash" size={13} />
        </button>
      </div>

      {/* Expandable detail */}
      {open && (
        <div className="we-loc-body stack">
          <Field label="Name">
            <input value={location.name} onChange={(e) => onUpdate({ name: e.target.value })} />
          </Field>
          <Field label="Description">
            <textarea
              placeholder="Describe the vibe, sights, and feel of this place."
              value={location.description}
              onChange={(e) => onUpdate({ description: e.target.value })}
            />
          </Field>
          <Field label="Tags">
            <TagInput value={location.tags} onChange={(tags) => onUpdate({ tags })} placeholder="tags…" />
          </Field>
          <label className="we-loc-indoor">
            <input
              type="checkbox"
              checked={location.indoor}
              onChange={(e) => onUpdate({ indoor: e.target.checked })}
            />
            Indoor (sheltered from the weather)
          </label>
          <Field label="Cost to date here">
            <select
              value={location.priceTier ?? 0}
              onChange={(e) => onUpdate({ priceTier: Number(e.target.value) })}
            >
              {VENUE_TIERS.map((t) => (
                <option key={t.tier} value={t.tier}>
                  {t.label}
                  {t.cost > 0 ? ` (${t.symbol} ${t.cost})` : ' (no cost)'}
                </option>
              ))}
            </select>
          </Field>
          {/* Note: a location image field would require a schema addition — deferred */}
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
        <h2>World notes</h2>
        <span className="trail" />
      </div>
      <div className="creator-callout">
        <span className="creator-callout-mark">
          <Icon name="info" size={13} />
        </span>
        <span>Notes are reference data the model can read — not instructions. Higher importance surfaces sooner.</span>
      </div>
      <div className="rule" />
      <div className="grid cols-2">
        <Field label="Title">
          <input value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
        </Field>
        <div className="inline-fields">
          <Field label="Scope">
            <select
              value={draft.scope}
              onChange={(e) => setDraft((d) => ({ ...d, scope: e.target.value as WorldNoteScope }))}
            >
              {SCOPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Importance">
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
      <Field label="Body">
        <textarea value={draft.body} onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} />
      </Field>
      <button className="btn" onClick={add} disabled={adding || !draft.title.trim()}>
        <Icon name="plus" size={14} />
        {adding ? 'Adding…' : 'Add note'}
      </button>

      <div className="divider" />
      {notes.length === 0 ? (
        <p className="muted">No notes yet.</p>
      ) : (
        notes.map((n) => (
          <div className="list-item" key={n.id}>
            <span className="badge">{n.scope}</span>
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
              Delete
            </button>
          </div>
        ))
      )}
    </div>
  );
}
