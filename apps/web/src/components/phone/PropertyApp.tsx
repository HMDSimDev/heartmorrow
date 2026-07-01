import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type Property,
  type PropertyView,
  type PropertyCreate,
  type PropertyCategory,
  type PropertyLease,
  type RentCadence,
  type RelationshipStatKey,
  RELATIONSHIP_STAT_KEYS,
} from '@dsim/shared';
import { api } from '../../lib/api';
import { useAsync, errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import {
  propertyCategoryLabel,
  rentCadenceLabel,
  rentCadencePer,
  relationshipStatLabel,
} from '../../i18n/labels';
import { Banner, Empty, Field, Loader, ConfirmDialog } from '../ui';
import { ResultCard, type ResultTone } from '../ResultCard';
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
  const { t } = useTranslation(['phone', 'common']);
  const { player, reloadPlayer, creatorMode, activeWorld, activeWorldId, worldState, dayTick } = useAppData();
  const state = useAsync(
    () => (activeWorldId ? api.listProperties(activeWorldId) : Promise.resolve({ properties: [] })),
    // Keyed on dayTick so the lease status (overdue / next-due) + evictions refetch
    // after End day, like every other day-derived surface.
    [activeWorldId, dayTick],
  );
  const [note, setNote] = useState<{ tone: ResultTone; seal: string; kicker: string; text: string }>();
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
      setNote({ tone: 'sage', seal: '✦', kicker: t('property.resultOwned'), text: t('property.toast.bought', { name: pv.property.name }) });
    });

  const sell = (pv: PropertyView) =>
    withBusy(pv.property.id, async () => {
      await api.sellProperty(activeWorldId!, pv.property.id);
      setNote({ tone: 'sage', seal: '◈', kicker: t('property.resultSold'), text: t('property.toast.sold', { name: pv.property.name, price: pv.property.buyPrice }) });
    });

  const startLease = (pv: PropertyView) =>
    withBusy(pv.property.id, async () => {
      await api.leaseProperty(activeWorldId!, pv.property.id);
      setNote({ tone: 'moon', seal: '☾', kicker: t('property.resultLease'), text: t('property.toast.leasing', { name: pv.property.name }) });
    });

  const payRent = (pv: PropertyView) =>
    withBusy(pv.property.id, async () => {
      await api.payRent(activeWorldId!, pv.property.id);
      setNote({ tone: 'moon', seal: '◈', kicker: t('property.resultRent'), text: t('property.toast.rentPaid', { name: pv.property.name }) });
    });

  const doEndLease = async (pv: PropertyView) => {
    setPendingEndLease(null);
    await withBusy(pv.property.id, async () => {
      await api.endLease(activeWorldId!, pv.property.id);
      setNote({ tone: 'ember', seal: '✖', kicker: t('property.resultMovedOut'), text: t('property.toast.movedOut', { name: pv.property.name }) });
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
        setError(t('property.toast.genFailed', { error: res.error }));
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
      setNote({ tone: 'brass', seal: '❧', kicker: t('property.resultSaved'), text: t('property.toast.savedDrafts', { count: kept.length }) });
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
      setNote({ tone: 'brass', seal: '✦', kicker: t('property.resultListed'), text: t('property.toast.created', { name: createForm.name }) });
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
        <PhoneAppBar title={t('property.title')} kicker={t('property.kicker')} icon="location" />
        <div className="phone-embed">
          <Empty icon={<Icon name="location" size={34} />} title={t('property.noWorldTitle')}>
            <p className="muted">{t('property.noWorldBody')}</p>
          </Empty>
        </div>
      </div>
    );
  }

  return (
    <div className="phone-app">
      <PhoneAppBar
        title={t('property.title')}
        kicker={t('property.kicker')}
        icon="location"
        right={
          <span className="prop-purse">
            <Icon name="coin" size={13} />
            <span className="prop-purse-coin">◈ {money}</span>
          </span>
        }
      />

      <div className="phone-embed prop-embed stack">
        {note && <ResultCard tone={note.tone} seal={note.seal} kicker={note.kicker} summary={note.text} />}
        {error && <Banner kind="error">{error}</Banner>}

        {/* ——— Creator: generate panel ——————————————————————— */}
        {creatorMode && (
          <div className="prop-creator-bar">
            {!genOpen && !createOpen && (
              <>
                <button className="btn primary sm" onClick={() => setGenOpen(true)}>
                  <Icon name="generate" size={14} /> {t('property.creator.generate')}
                </button>
                <button className="btn ghost sm" onClick={() => setCreateOpen(true)}>
                  <Icon name="plus" size={14} /> {t('property.creator.newProperty')}
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
                <div className="kicker">{t('property.creator.workshop')}</div>
                <h3 className="prop-gen-title">{t('property.gen.title')}</h3>
              </div>
              <button className="btn ghost sm" onClick={closeGen}>
                {t('property.creator.close')}
              </button>
            </div>
            <p className="hint" style={{ marginTop: 0 }}>
              {t('property.gen.hintPre')}
              {activeWorld ? <strong>{activeWorld.name}</strong> : t('property.gen.genericSetting')}
              {t('property.gen.hintPost')}
            </p>
            <div className="inline-fields">
              <Field label={t('property.gen.howMany')}>
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
              <Field label={t('property.gen.categoryHint')}>
                <select
                  value={genForm.categoryHint}
                  onChange={(e) => setGenForm({ ...genForm, categoryHint: e.target.value as '' | PropertyCategory })}
                >
                  <option value="">{t('property.gen.any')}</option>
                  {PROPERTY_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {propertyCategoryLabel(c)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={t('property.gen.theme')} hint={t('property.gen.themeHint')}>
              <textarea
                value={genForm.theme}
                onChange={(e) => setGenForm({ ...genForm, theme: e.target.value })}
                placeholder={t('property.gen.themePlaceholder')}
              />
            </Field>
            <div className="row">
              <button className="btn primary" onClick={generate} disabled={generating}>
                {generating ? t('property.gen.generating') : <><Icon name="generate" size={15} /> {t('property.creator.generate')}</>}
              </button>
              {drafts.length > 0 && (
                <button className="btn" onClick={saveDrafts} disabled={saving || keptCount === 0}>
                  {saving ? t('property.gen.saving') : t('property.gen.saveSelected', { count: keptCount })}
                </button>
              )}
            </div>

            {drafts.length > 0 && (
              <>
                <div className="prop-gen-divider">{t('property.gen.reviewRefine')}</div>
                <p className="hint" style={{ marginTop: 0 }}>
                  {t('property.gen.draftsGenerated', { count: drafts.length })}
                </p>
                <div className="prop-drafts">
                  {drafts.map((d, i) => (
                    <div className={`prop-draft${d.keep ? '' : ' dropped'}`} key={i}>
                      <div className="prop-draft-top">
                        <label className="prop-draft-keep">
                          <input type="checkbox" checked={d.keep} onChange={() => toggleKeep(i)} />
                          {d.keep ? t('property.gen.keep') : t('property.gen.skipped')}
                        </label>
                        <span className="prop-money-pill">◈ {d.item.buyPrice ?? 0}</span>
                      </div>
                      <div className="inline-fields">
                        <Field label={t('property.fields.name')}>
                          <input value={d.item.name} onChange={(e) => editDraft(i, { name: e.target.value })} />
                        </Field>
                        <Field label={t('property.fields.category')}>
                          <select
                            value={d.item.category ?? 'residence'}
                            onChange={(e) => editDraft(i, { category: e.target.value as PropertyCategory })}
                          >
                            {PROPERTY_CATEGORIES.map((c) => (
                              <option key={c} value={c}>
                                {propertyCategoryLabel(c)}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <div className="inline-fields">
                        <Field label={t('property.fields.buyPrice')}>
                          <input
                            type="number"
                            min={0}
                            value={d.item.buyPrice ?? 0}
                            onChange={(e) => editDraft(i, { buyPrice: Math.max(0, Number(e.target.value) || 0) })}
                          />
                        </Field>
                        <Field label={t('property.fields.leaseRent')}>
                          <input
                            type="number"
                            min={0}
                            value={d.item.rentAmount ?? 0}
                            onChange={(e) => editDraft(i, { rentAmount: Math.max(0, Number(e.target.value) || 0) })}
                          />
                        </Field>
                        <Field label={t('property.fields.cadence')}>
                          <select
                            value={d.item.rentCadence ?? 'weekly'}
                            onChange={(e) => editDraft(i, { rentCadence: e.target.value as RentCadence })}
                          >
                            {RENT_CADENCES.map((rc) => (
                              <option key={rc} value={rc}>
                                {rentCadenceLabel(rc)}
                              </option>
                            ))}
                          </select>
                        </Field>
                      </div>
                      <div className="inline-fields">
                        <Field label={t('property.fields.buffStat')}>
                          <select
                            value={d.item.buffStat ?? ''}
                            onChange={(e) =>
                              editDraft(i, { buffStat: (e.target.value as RelationshipStatKey) || null })
                            }
                          >
                            <option value="">{t('property.fields.none')}</option>
                            {RELATIONSHIP_STAT_KEYS.map((k) => (
                              <option key={k} value={k}>
                                {relationshipStatLabel(k)}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label={t('property.fields.buffAmount')}>
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
                      <Field label={t('property.fields.description')}>
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
                <div className="kicker">{t('property.creator.workshop')}</div>
                <h3 className="prop-gen-title">{t('property.create.title')}</h3>
              </div>
              <button className="btn ghost sm" onClick={() => { setCreateOpen(false); setCreateForm(EMPTY_CREATE); }}>
                {t('property.creator.close')}
              </button>
            </div>
            <div className="inline-fields">
              <Field label={t('property.fields.name')}>
                <input
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  placeholder={t('property.fields.namePlaceholder')}
                />
              </Field>
              <Field label={t('property.fields.category')}>
                <select
                  value={createForm.category}
                  onChange={(e) => setCreateForm({ ...createForm, category: e.target.value as PropertyCategory })}
                >
                  {PROPERTY_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {propertyCategoryLabel(c)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="inline-fields">
              <Field label={t('property.fields.buyPrice')}>
                <input
                  type="number"
                  min={0}
                  value={createForm.buyPrice}
                  onChange={(e) => setCreateForm({ ...createForm, buyPrice: Math.max(0, Number(e.target.value) || 0) })}
                />
              </Field>
              <Field label={t('property.fields.leaseRent')}>
                <input
                  type="number"
                  min={0}
                  value={createForm.rentAmount}
                  onChange={(e) =>
                    setCreateForm({ ...createForm, rentAmount: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
              </Field>
              <Field label={t('property.fields.cadence')}>
                <select
                  value={createForm.rentCadence}
                  onChange={(e) => setCreateForm({ ...createForm, rentCadence: e.target.value as RentCadence })}
                >
                  {RENT_CADENCES.map((rc) => (
                    <option key={rc} value={rc}>
                      {rentCadenceLabel(rc)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="inline-fields">
              <Field label={t('property.fields.buffStat')}>
                <select
                  value={createForm.buffStat ?? ''}
                  onChange={(e) =>
                    setCreateForm({ ...createForm, buffStat: (e.target.value as RelationshipStatKey) || null })
                  }
                >
                  <option value="">{t('property.fields.none')}</option>
                  {RELATIONSHIP_STAT_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {relationshipStatLabel(k)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('property.fields.buffAmount')}>
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
              <Field label={t('property.fields.indoor')}>
                <label className="prop-checkbox-label">
                  <input
                    type="checkbox"
                    checked={createForm.indoor}
                    onChange={(e) => setCreateForm({ ...createForm, indoor: e.target.checked })}
                  />
                  {t('property.fields.shelteredVenue')}
                </label>
              </Field>
            </div>
            <Field label={t('property.fields.description')}>
              <textarea
                value={createForm.description}
                onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                placeholder={t('property.fields.descPlaceholder')}
              />
            </Field>
            <div className="row">
              <button
                className="btn primary"
                onClick={submitCreate}
                disabled={creating || !createForm.name.trim()}
              >
                {creating ? t('property.create.adding') : <><Icon name="plus" size={14} /> {t('property.create.addProperty')}</>}
              </button>
            </div>
          </div>
        )}

        {/* ——— Property list ——————————————————————————————————————— */}
        <Loader state={state}>
          {({ properties }) =>
            properties.length === 0 ? (
              <Empty icon={<Icon name="location" size={34} />} title={t('property.list.emptyTitle')}>
                <p className="muted">
                  {creatorMode
                    ? t('property.list.emptyCreator')
                    : t('property.list.emptyPlayer')}
                </p>
              </Empty>
            ) : (
              <>
                <div className="section-head prop-list-head">
                  <div className="titles">
                    <div className="kicker">{t('property.list.onTheMarket')}</div>
                    <h3 className="prop-list-count">
                      {t('property.list.count', { count: properties.length })}
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
                        className={`ph-rise prop-card${owned ? ' owned bracketed' : ''}${isLeased ? ' leased' : ''}`}
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
                                {propertyCategoryLabel(property.category)}
                                {property.indoor ? t('property.card.indoor') : t('property.card.outdoor')}
                              </div>
                            </div>
                            {owned && <span className="prop-owned-badge">{t('property.card.owned')}</span>}
                            {isLeased && !isOverdue && <span className="prop-leased-badge">{t('property.card.leased')}</span>}
                            {isOverdue && (
                              <span className="prop-overdue-badge">
                                <Icon name="warn" size={11} /> {t('property.card.overdue')}
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
                              <span className="prop-price-label">{t('property.card.sellValue')}</span>
                              <span className="prop-price">◈ {property.buyPrice}</span>
                            </div>
                          ) : isLeased ? (
                            /* Leased: show lease status */
                            isOverdue ? (
                              <div className="prop-overdue-notice">
                                <Icon name="warn" size={13} />
                                <span>
                                  {t('property.card.rentOverdue', {
                                    rent: property.rentAmount,
                                    day: (lease as PropertyLease).graceUntilDay ?? '?',
                                  })}
                                </span>
                              </div>
                            ) : (
                              <div className="prop-econ-row">
                                <span className="prop-price-label">
                                  {t('property.card.rentPer', { rent: property.rentAmount, per: rentCadencePer(cadence) })}
                                </span>
                                <span className="prop-price secondary">
                                  {t('property.card.nextDue', { day: (lease as PropertyLease).nextDueDay })}
                                </span>
                              </div>
                            )
                          ) : (
                            /* Available: show both options */
                            <>
                              {property.rentAmount > 0 && (
                                <div className="prop-econ-row">
                                  <span className="prop-price-label">
                                    {t('property.card.leasePer', { per: rentCadencePer(cadence) })}
                                  </span>
                                  <span className="prop-price secondary">◈ {property.rentAmount}</span>
                                </div>
                              )}
                              <div className="prop-econ-row">
                                <span className="prop-price-label">{t('property.card.buy')}</span>
                                <span className="prop-price">◈ {property.buyPrice}</span>
                              </div>
                            </>
                          )}

                          {property.buffStat && property.buffAmount > 0 && (
                            <div className="prop-econ-row prop-buff-row">
                              <span className="prop-buff">
                                {t('property.card.buff', {
                                  amount: property.buffAmount,
                                  stat: relationshipStatLabel(property.buffStat),
                                  note: owned ? t('property.card.buffOwned') : t('property.card.buffLeased'),
                                })}
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
                              {isBusy ? t('property.card.selling') : t('property.card.sell', { price: property.buyPrice })}
                            </button>
                          ) : isLeased ? (
                            /* Leased: pay rent (only when due), buy, end lease */
                            <>
                              {rentDue && (
                                <button
                                  className={`btn flex-fill${isOverdue ? ' danger' : ''}`}
                                  disabled={!affordableLease || isBusy || busyId !== null}
                                  onClick={() => payRent(pv)}
                                  title={!affordableLease ? t('property.card.notEnough') : undefined}
                                >
                                  {isBusy ? t('property.card.paying') : !affordableLease ? t('property.card.notEnough') : t('property.card.payRent', { rent: property.rentAmount })}
                                </button>
                              )}
                              <button
                                className="btn primary"
                                disabled={!affordableBuy || isBusy || busyId !== null}
                                onClick={() => buy(pv)}
                                title={!affordableBuy ? t('property.card.notEnough') : t('property.card.buyOutright')}
                              >
                                {t('property.card.buyPrice', { price: property.buyPrice })}
                              </button>
                              <button
                                className="btn ghost"
                                disabled={isBusy || busyId !== null}
                                onClick={() => setPendingEndLease(pv)}
                                title={t('property.card.moveOut')}
                              >
                                {t('property.card.endLease')}
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
                                    ? t('property.card.leasing')
                                    : !affordableLease
                                    ? t('property.card.notEnough')
                                    : t('property.card.lease')}
                                </button>
                              )}
                              <button
                                className="btn primary flex-fill"
                                disabled={!affordableBuy || busyId !== null}
                                onClick={() => buy(pv)}
                              >
                                {isBusy
                                  ? t('property.card.buying')
                                  : !affordableBuy
                                  ? t('property.card.notEnough')
                                  : t('property.card.buyPrice', { price: property.buyPrice })}
                              </button>
                            </>
                          )}
                          {creatorMode && (
                            <button
                              className="btn danger ghost"
                              onClick={() => setPendingDelete(property)}
                              title={t('property.card.deleteProperty')}
                              aria-label={t('property.card.deleteProperty')}
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
          title={t('property.confirmDelete.title', { name: pendingDelete.name })}
          body={t('property.confirmDelete.body')}
          confirmLabel={t('property.confirmDelete.confirm')}
          danger
          busy={deleting}
          onConfirm={() => removeProperty(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingEndLease && (
        <ConfirmDialog
          title={t('property.confirmEndLease.title')}
          body={t('property.confirmEndLease.body', { name: pendingEndLease.property.name })}
          confirmLabel={t('property.confirmEndLease.confirm')}
          danger
          busy={busyId === pendingEndLease.property.id}
          onConfirm={() => doEndLease(pendingEndLease)}
          onCancel={() => setPendingEndLease(null)}
        />
      )}

    </div>
  );
}
