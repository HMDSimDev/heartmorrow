import { useState } from 'react';
import {
  type Property,
  type PropertyView,
  type PropertyCreate,
  type PropertyCategory,
  type PropertyLease,
  type RentCadence,
  type RelationshipStatKey,
  PROPERTY_CATEGORY_LABELS,
  RELATIONSHIP_STAT_LABELS,
  RELATIONSHIP_STAT_KEYS,
  RENT_CADENCE_LABELS,
  RENT_CADENCE_PER,
} from '@dsim/shared';
import { api } from '../../lib/api';
import { useAsync, errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import { Banner, Empty, Field, Loader, ConfirmDialog } from '../ui';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import './phone-property.css';

const PROPERTY_CATEGORIES: PropertyCategory[] = ['residence', 'retreat', 'social', 'estate', 'land'];
const RENT_CADENCES: RentCadence[] = ['daily', 'weekly', 'monthly'];

interface Draft {
  keep: boolean;
  item: PropertyCreate;
}

const EMPTY_CREATE: Omit<PropertyCreate, 'worldId'> = {
  name: '',
  description: '',
  category: 'residence',
  buyPrice: 0,
  rentAmount: 0,
  rentCadence: 'weekly',
  indoor: true,
  tags: [],
  buffStat: null,
  buffAmount: 0,
  assetId: null,
};

export function PropertyApp() {
  const { player, reloadPlayer, creatorMode, activeWorld, activeWorldId, worldState, dayTick } = useAppData();
  const state = useAsync(
    () => (activeWorldId ? api.listProperties(activeWorldId) : Promise.resolve({ properties: [] })),
    // Keyed on dayTick so the lease status (overdue / next-due) + evictions refetch
    // after End day, like every other day-derived surface.
    [activeWorldId, dayTick],
  );
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);

  // Creator: delete
  const [pendingDelete, setPendingDelete] = useState<Property | null>(null);
  const [deleting, setDeleting] = useState(false);

  // End-lease confirm
  const [pendingEndLease, setPendingEndLease] = useState<PropertyView | null>(null);

  // Creator: generate panel
  const [genOpen, setGenOpen] = useState(false);
  const [genForm, setGenForm] = useState<{
    count: number;
    theme: string;
    categoryHint: '' | PropertyCategory;
  }>({ count: 4, theme: '', categoryHint: '' });
  const [generating, setGenerating] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [saving, setSaving] = useState(false);

  // Creator: manual create form
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<Omit<PropertyCreate, 'worldId'>>(EMPTY_CREATE);
  const [creating, setCreating] = useState(false);

  const money = player?.money ?? 0;

  // ——— Helpers ——————————————————————————————————————————————————————————
  const withBusy = async (id: string, fn: () => Promise<void>) => {
    if (!activeWorldId || busyId) return;
    setBusyId(id);
    setNote(undefined);
    setError(undefined);
    try {
      await fn();
      await reloadPlayer();
      state.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  // ——— Player actions ——————————————————————————————————————————————————
  const buy = (pv: PropertyView) =>
    withBusy(pv.property.id, async () => {
      await api.buyProperty(activeWorldId!, pv.property.id);
      setNote(`You now own ${pv.property.name}!`);
    });

  const sell = (pv: PropertyView) =>
    withBusy(pv.property.id, async () => {
      await api.sellProperty(activeWorldId!, pv.property.id);
      setNote(`Sold ${pv.property.name}. ◈ ${pv.property.buyPrice} returned.`);
    });

  const startLease = (pv: PropertyView) =>
    withBusy(pv.property.id, async () => {
      await api.leaseProperty(activeWorldId!, pv.property.id);
      setNote(`Leasing ${pv.property.name}.`);
    });

  const payRent = (pv: PropertyView) =>
    withBusy(pv.property.id, async () => {
      await api.payRent(activeWorldId!, pv.property.id);
      setNote(`Rent paid for ${pv.property.name}.`);
    });

  const doEndLease = async (pv: PropertyView) => {
    setPendingEndLease(null);
    await withBusy(pv.property.id, async () => {
      await api.endLease(activeWorldId!, pv.property.id);
      setNote(`Moved out of ${pv.property.name}.`);
    });
  };

  // ——— Creator: delete ——————————————————————————————————————————————————
  const removeProperty = async (prop: Property) => {
    if (deleting) return;
    setDeleting(true);
    setError(undefined);
    try {
      await api.deleteProperty(prop.id);
      state.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  // ——— Creator: generate ——————————————————————————————————————————————
  const generate = async () => {
    if (!activeWorldId) return;
    setGenerating(true);
    setError(undefined);
    setNote(undefined);
    setDrafts([]);
    try {
      const res = await api.generateProperties(activeWorldId, {
        count: genForm.count,
        theme: genForm.theme,
        categoryHint: genForm.categoryHint || undefined,
        world: activeWorld
          ? {
              name: activeWorld.name,
              summary: activeWorld.summary,
              tone: activeWorld.tone,
              lore: activeWorld.lore,
              rules: activeWorld.rules,
            }
          : undefined,
      });
      if (res.ok) {
        setDrafts(res.data.map((item) => ({ keep: true, item: { ...item, worldId: activeWorldId } })));
      } else {
        setError(`Property generation failed: ${res.error}`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  const editDraft = (i: number, patch: Partial<PropertyCreate>) =>
    setDrafts((ds) => ds.map((d, idx) => (idx === i ? { ...d, item: { ...d.item, ...patch } } : d)));
  const toggleKeep = (i: number) =>
    setDrafts((ds) => ds.map((d, idx) => (idx === i ? { ...d, keep: !d.keep } : d)));
  const keptCount = drafts.filter((d) => d.keep).length;

  const saveDrafts = async () => {
    if (!activeWorldId) return;
    setSaving(true);
    setError(undefined);
    try {
      const kept = drafts.filter((d) => d.keep).map((d) => d.item);
      for (const item of kept) await api.createProperty({ ...item, worldId: activeWorldId });
      setNote(`Saved ${kept.length} propert${kept.length === 1 ? 'y' : 'ies'}.`);
      setGenOpen(false);
      setDrafts([]);
      state.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const closeGen = () => {
    setGenOpen(false);
    setDrafts([]);
  };

  // ——— Creator: manual create ——————————————————————————————————————————
  const submitCreate = async () => {
    if (!activeWorldId || creating) return;
    setCreating(true);
    setError(undefined);
    try {
      await api.createProperty({ ...createForm, worldId: activeWorldId });
      setNote(`"${createForm.name}" added.`);
      setCreateForm(EMPTY_CREATE);
      setCreateOpen(false);
      state.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  // ——— Guard: no active world ——————————————————————————————————————————
  if (!activeWorldId) {
    return (
      <div className="phone-app">
        <PhoneAppBar title="Property" kicker="Real estate" icon="location" />
        <div className="phone-embed">
          <Empty icon={<Icon name="location" size={34} />} title="No world active">
            <p className="muted">Pick a world to browse properties.</p>
          </Empty>
        </div>
      </div>
    );
  }

  return (
    <div className="phone-app">
      <PhoneAppBar
        title="Property"
        kicker="Real estate"
        icon="location"
        right={
          <span className="prop-purse">
            <Icon name="coin" size={13} />
            <span className="prop-purse-coin">◈ {money}</span>
          </span>
        }
      />

      <div className="phone-embed prop-embed stack">
        {note && <Banner kind="ok">{note}</Banner>}
        {error && <Banner kind="error">{error}</Banner>}

        {/* ——— Creator: generate panel ——————————————————————— */}
        {creatorMode && (
          <div className="prop-creator-bar">
            {!genOpen && !createOpen && (
              <>
                <button className="btn primary sm" onClick={() => setGenOpen(true)}>
                  <Icon name="generate" size={14} /> Generate
                </button>
                <button className="btn ghost sm" onClick={() => setCreateOpen(true)}>
                  <Icon name="plus" size={14} /> New property
                </button>
              </>
            )}
          </div>
        )}

        {/* Generate panel */}
        {creatorMode && genOpen && (
          <div className="framed prop-gen stack">
            <div className="prop-gen-head">
              <div>
                <div className="kicker">Creator Workshop</div>
                <h3 className="prop-gen-title">Generate properties</h3>
              </div>
              <button className="btn ghost sm" onClick={closeGen}>
                Close
              </button>
            </div>
            <p className="hint" style={{ marginTop: 0 }}>
              Generates lore-friendly properties for{' '}
              {activeWorld ? <strong>{activeWorld.name}</strong> : 'a generic setting'}. Nothing is saved until
              you press Save — review and tweak first.
            </p>
            <div className="inline-fields">
              <Field label="How many (1–8)">
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={genForm.count}
                  onChange={(e) =>
                    setGenForm({ ...genForm, count: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })
                  }
                />
              </Field>
              <Field label="Category hint">
                <select
                  value={genForm.categoryHint}
                  onChange={(e) => setGenForm({ ...genForm, categoryHint: e.target.value as '' | PropertyCategory })}
                >
                  <option value="">— any —</option>
                  {PROPERTY_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {PROPERTY_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Theme / guidance" hint='Optional — e.g. "cozy harbour apartments" or "grand countryside estates".'>
              <textarea
                value={genForm.theme}
                onChange={(e) => setGenForm({ ...genForm, theme: e.target.value })}
                placeholder="Describe the kind of properties you want…"
              />
            </Field>
            <div className="row">
              <button className="btn primary" onClick={generate} disabled={generating}>
                {generating ? 'Generating…' : <><Icon name="generate" size={15} /> Generate</>}
              </button>
              {drafts.length > 0 && (
                <button className="btn" onClick={saveDrafts} disabled={saving || keptCount === 0}>
                  {saving ? 'Saving…' : `Save ${keptCount} selected`}
                </button>
              )}
            </div>

            {drafts.length > 0 && (
              <>
                <div className="prop-gen-divider">Review &amp; refine</div>
                <p className="hint" style={{ marginTop: 0 }}>
                  {drafts.length} propert{drafts.length === 1 ? 'y' : 'ies'} generated. Uncheck any you don't want,
                  edit the rest, then Save.
                </p>
                <div className="prop-drafts">
                  {drafts.map((d, i) => (
                    <div className={`prop-draft${d.keep ? '' : ' dropped'}`} key={i}>
                      <div className="prop-draft-top">
                        <label className="prop-draft-keep">
                          <input type="checkbox" checked={d.keep} onChange={() => toggleKeep(i)} />
                          {d.keep ? 'Keep' : 'Skipped'}
                        </label>
                        <span className="prop-money-pill">◈ {d.item.buyPrice ?? 0}</span>
                      </div>
                      <div className="inline-fields">
                        <Field label="Name">
                          <input value={d.item.name} onChange={(e) => editDraft(i, { name: e.target.value })} />
                        </Field>
                        <Field label="Category">
                          <select
                            value={d.item.category ?? 'residence'}
                            onChange={(e) => editDraft(i, { category: e.target.value as PropertyCategory })}
                          >
                            {PROPERTY_CATEGORIES.map((c) => (
                              <option key={c} value={c}>
                                {PROPERTY_CATEGORY_LABELS[c]}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <div className="inline-fields">
                        <Field label="Buy price (◈)">
                          <input
                            type="number"
                            min={0}
                            value={d.item.buyPrice ?? 0}
                            onChange={(e) => editDraft(i, { buyPrice: Math.max(0, Number(e.target.value) || 0) })}
                          />
                        </Field>
                        <Field label="Lease rent (◈)">
                          <input
                            type="number"
                            min={0}
                            value={d.item.rentAmount ?? 0}
                            onChange={(e) => editDraft(i, { rentAmount: Math.max(0, Number(e.target.value) || 0) })}
                          />
                        </Field>
                        <Field label="Cadence">
                          <select
                            value={d.item.rentCadence ?? 'weekly'}
                            onChange={(e) => editDraft(i, { rentCadence: e.target.value as RentCadence })}
                          >
                            {RENT_CADENCES.map((rc) => (
                              <option key={rc} value={rc}>
                                {RENT_CADENCE_LABELS[rc]}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <div className="inline-fields">
                        <Field label="Date buff stat">
                          <select
                            value={d.item.buffStat ?? ''}
                            onChange={(e) =>
                              editDraft(i, { buffStat: (e.target.value as RelationshipStatKey) || null })
                            }
                          >
                            <option value="">— none —</option>
                            {RELATIONSHIP_STAT_KEYS.map((k) => (
                              <option key={k} value={k}>
                                {RELATIONSHIP_STAT_LABELS[k]}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Buff amount (0–5)">
                          <input
                            type="number"
                            min={0}
                            max={5}
                            value={d.item.buffAmount ?? 0}
                            onChange={(e) =>
                              editDraft(i, { buffAmount: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })
                            }
                          />
                        </Field>
                      </div>
                      <Field label="Description">
                        <textarea
                          value={d.item.description ?? ''}
                          onChange={(e) => editDraft(i, { description: e.target.value })}
                        />
                      </Field>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Manual create form */}
        {creatorMode && createOpen && (
          <div className="framed prop-create-form stack">
            <div className="prop-gen-head">
              <div>
                <div className="kicker">Creator Workshop</div>
                <h3 className="prop-gen-title">New property</h3>
              </div>
              <button className="btn ghost sm" onClick={() => { setCreateOpen(false); setCreateForm(EMPTY_CREATE); }}>
                Close
              </button>
            </div>
            <div className="inline-fields">
              <Field label="Name">
                <input
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  placeholder="e.g. The Amber Flat"
                />
              </Field>
              <Field label="Category">
                <select
                  value={createForm.category}
                  onChange={(e) => setCreateForm({ ...createForm, category: e.target.value as PropertyCategory })}
                >
                  {PROPERTY_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {PROPERTY_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="inline-fields">
              <Field label="Buy price (◈)">
                <input
                  type="number"
                  min={0}
                  value={createForm.buyPrice}
                  onChange={(e) => setCreateForm({ ...createForm, buyPrice: Math.max(0, Number(e.target.value) || 0) })}
                />
              </Field>
              <Field label="Lease rent (◈)">
                <input
                  type="number"
                  min={0}
                  value={createForm.rentAmount}
                  onChange={(e) =>
                    setCreateForm({ ...createForm, rentAmount: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </Field>
              <Field label="Cadence">
                <select
                  value={createForm.rentCadence}
                  onChange={(e) => setCreateForm({ ...createForm, rentCadence: e.target.value as RentCadence })}
                >
                  {RENT_CADENCES.map((rc) => (
                    <option key={rc} value={rc}>
                      {RENT_CADENCE_LABELS[rc]}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="inline-fields">
              <Field label="Date buff stat">
                <select
                  value={createForm.buffStat ?? ''}
                  onChange={(e) =>
                    setCreateForm({ ...createForm, buffStat: (e.target.value as RelationshipStatKey) || null })
                  }
                >
                  <option value="">— none —</option>
                  {RELATIONSHIP_STAT_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {RELATIONSHIP_STAT_LABELS[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Buff amount (0–5)">
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={createForm.buffAmount}
                  onChange={(e) =>
                    setCreateForm({
                      ...createForm,
                      buffAmount: Math.max(0, Math.min(5, Number(e.target.value) || 0)),
                    })
                  }
                />
              </Field>
              <Field label="Indoor">
                <label className="prop-checkbox-label">
                  <input
                    type="checkbox"
                    checked={createForm.indoor}
                    onChange={(e) => setCreateForm({ ...createForm, indoor: e.target.checked })}
                  />
                  Sheltered venue
                </label>
              </Field>
            </div>
            <Field label="Description">
              <textarea
                value={createForm.description}
                onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                placeholder="A lamplit room with brass fixtures and faded curtains…"
              />
            </Field>
            <div className="row">
              <button
                className="btn primary"
                onClick={submitCreate}
                disabled={creating || !createForm.name.trim()}
              >
                {creating ? 'Adding…' : <><Icon name="plus" size={14} /> Add property</>}
              </button>
            </div>
          </div>
        )}

        {/* ——— Property list ——————————————————————————————————————— */}
        <Loader state={state}>
          {({ properties }) =>
            properties.length === 0 ? (
              <Empty icon={<Icon name="location" size={34} />} title="No properties yet">
                <p className="muted">
                  {creatorMode
                    ? 'Generate or add a property above to list it here.'
                    : 'No properties are available in this world.'}
                </p>
              </Empty>
            ) : (
              <>
                <div className="section-head prop-list-head">
                  <div className="titles">
                    <div className="kicker">On the market</div>
                    <h3 className="prop-list-count">
                      {properties.length} propert{properties.length === 1 ? 'y' : 'ies'}
                    </h3>
                  </div>
                </div>
                <div className="prop-grid">
                  {properties.map((pv) => {
                    const { property, owned, lease, affordableBuy, affordableLease } = pv;
                    const isBusy = busyId === property.id;
                    const cadence = property.rentCadence;
                    const isLeased = !owned && lease !== null;
                    const isOverdue = isLeased && lease!.status === 'overdue';
                    // Rent is only payable when it's actually owed (overdue, or this
                    // period has come due) — otherwise paying just wastes money.
                    const rentDue = isLeased && (isOverdue || (worldState?.day ?? 1) >= lease!.nextDueDay);

                    return (
                      <div
                        className={`ph-rise prop-card${owned ? ' owned' : ''}${isLeased ? ' leased' : ''}`}
                        key={property.id}
                      >
                        <div className="prop-card-body">
                          <div className="prop-card-top">
                            <div className="prop-card-icon" aria-hidden="true">
                              <Icon name="location" size={18} />
                            </div>
                            <div className="flex-fill">
                              <h4 className="prop-card-name">{property.name}</h4>
                              <div className="prop-card-cat">
                                {PROPERTY_CATEGORY_LABELS[property.category]}
                                {property.indoor ? ' · Indoor' : ' · Outdoor'}
                              </div>
                            </div>
                            {owned && <span className="prop-owned-badge">Owned</span>}
                            {isLeased && !isOverdue && <span className="prop-leased-badge">Leased</span>}
                            {isOverdue && (
                              <span className="prop-overdue-badge">
                                <Icon name="warn" size={11} /> Overdue
                              </span>
                            )}
                          </div>

                          {property.description && (
                            <p className="prop-card-desc">{property.description}</p>
                          )}

                          {property.tags.length > 0 && (
                            <div className="tags">
                              {property.tags.map((t) => (
                                <span className="tag" key={t}>
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Economics strip */}
                        <div className="prop-card-econ">
                          {owned ? (
                            /* Owned: just buy-back price + buff */
                            <div className="prop-econ-row">
                              <span className="prop-price-label">Sell value</span>
                              <span className="prop-price">◈ {property.buyPrice}</span>
                            </div>
                          ) : isLeased ? (
                            /* Leased: show lease status */
                            isOverdue ? (
                              <div className="prop-overdue-notice">
                                <Icon name="warn" size={13} />
                                <span>
                                  RENT OVERDUE — pay ◈{property.rentAmount} by Day {(lease as PropertyLease).graceUntilDay ?? '?'} or you'll be evicted
                                </span>
                              </div>
                            ) : (
                              <div className="prop-econ-row">
                                <span className="prop-price-label">
                                  Rent ◈{property.rentAmount}/{RENT_CADENCE_PER[cadence]}
                                </span>
                                <span className="prop-price secondary">
                                  next due Day {(lease as PropertyLease).nextDueDay}
                                </span>
                              </div>
                            )
                          ) : (
                            /* Available: show both options */
                            <>
                              {property.rentAmount > 0 && (
                                <div className="prop-econ-row">
                                  <span className="prop-price-label">
                                    Lease /{RENT_CADENCE_PER[cadence]}
                                  </span>
                                  <span className="prop-price secondary">◈ {property.rentAmount}</span>
                                </div>
                              )}
                              <div className="prop-econ-row">
                                <span className="prop-price-label">Buy</span>
                                <span className="prop-price">◈ {property.buyPrice}</span>
                              </div>
                            </>
                          )}

                          {property.buffStat && property.buffAmount > 0 && (
                            <div className="prop-econ-row prop-buff-row">
                              <span className="prop-buff">
                                +{property.buffAmount} {RELATIONSHIP_STAT_LABELS[property.buffStat]} on dates here
                                {' '}({owned ? 'full when owned' : 'half when leased, full when owned'})
                              </span>
                            </div>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="prop-card-actions">
                          {owned ? (
                            /* Owned: only sell */
                            <button
                              className="btn ghost flex-fill"
                              disabled={isBusy || busyId !== null}
                              onClick={() => sell(pv)}
                            >
                              {isBusy ? 'Selling…' : `Sell (◈ ${property.buyPrice})`}
                            </button>
                          ) : isLeased ? (
                            /* Leased: pay rent (only when due), buy, end lease */
                            <>
                              {rentDue && (
                                <button
                                  className={`btn flex-fill${isOverdue ? ' danger' : ''}`}
                                  disabled={!affordableLease || isBusy || busyId !== null}
                                  onClick={() => payRent(pv)}
                                  title={!affordableLease ? 'Not enough ◈' : undefined}
                                >
                                  {isBusy ? 'Paying…' : !affordableLease ? 'Not enough ◈' : `Pay rent (◈ ${property.rentAmount})`}
                                </button>
                              )}
                              <button
                                className="btn primary"
                                disabled={!affordableBuy || isBusy || busyId !== null}
                                onClick={() => buy(pv)}
                                title={!affordableBuy ? 'Not enough ◈' : `Buy outright`}
                              >
                                {`Buy (◈ ${property.buyPrice})`}
                              </button>
                              <button
                                className="btn ghost"
                                disabled={isBusy || busyId !== null}
                                onClick={() => setPendingEndLease(pv)}
                                title="Move out"
                              >
                                End lease
                              </button>
                            </>
                          ) : (
                            /* Available: lease and/or buy */
                            <>
                              {property.rentAmount > 0 && (
                                <button
                                  className="btn ghost flex-fill"
                                  disabled={!affordableLease || busyId !== null}
                                  onClick={() => startLease(pv)}
                                >
                                  {isBusy
                                    ? 'Leasing…'
                                    : !affordableLease
                                    ? 'Not enough ◈'
                                    : 'Lease'}
                                </button>
                              )}
                              <button
                                className="btn primary flex-fill"
                                disabled={!affordableBuy || busyId !== null}
                                onClick={() => buy(pv)}
                              >
                                {isBusy
                                  ? 'Buying…'
                                  : !affordableBuy
                                  ? 'Not enough ◈'
                                  : `Buy (◈ ${property.buyPrice})`}
                              </button>
                            </>
                          )}
                          {creatorMode && (
                            <button
                              className="btn danger ghost"
                              onClick={() => setPendingDelete(property)}
                              title="Delete property"
                              aria-label="Delete property"
                            >
                              <Icon name="trash" size={15} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )
          }
        </Loader>
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={`Delete ${pendingDelete.name}?`}
          body="This removes the property from the world permanently."
          confirmLabel="Delete"
          danger
          busy={deleting}
          onConfirm={() => removeProperty(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingEndLease && (
        <ConfirmDialog
          title="Move out?"
          body={`You'll lose your lease on ${pendingEndLease.property.name}. Any overdue rent will be forgiven but you'll need to lease again to return.`}
          confirmLabel="Move out"
          danger
          busy={busyId === pendingEndLease.property.id}
          onConfirm={() => doEndLease(pendingEndLease)}
          onCancel={() => setPendingEndLease(null)}
        />
      )}

    </div>
  );
}
