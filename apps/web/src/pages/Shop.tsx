import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  describeItemEffect,
  type ItemCategory,
  type ItemRarity,
  type ShopItem,
  type ShopItemCreate,
} from '@dsim/shared';
import { api } from '../lib/api';
import { useAsync, errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { itemCategoryLabel, itemRarityLabel } from '../i18n/labels';
import { Banner, Empty, Field, Loader, ConfirmDialog } from '../components/ui';
import { ResultCard, type ResultTone } from '../components/ResultCard';
import { Icon, type IconName } from '../components/Icon';
import './shop.page.css';

const RARITIES: ItemRarity[] = ['common', 'uncommon', 'rare', 'legendary'];
const CATEGORIES: ItemCategory[] = ['gift', 'consumable', 'apparel', 'book', 'special'];

const CATEGORY_ICON: Record<ItemCategory, IconName> = {
  gift: 'gift',
  consumable: 'consumable',
  apparel: 'apparel',
  book: 'book',
  special: 'special',
};

interface Draft {
  keep: boolean;
  item: ShopItemCreate;
}

export function Shop() {
  const { t } = useTranslation(['pages', 'common']);
  const { player, reloadPlayer, creatorMode, activeWorld, activeWorldId } = useAppData();
  const state = useAsync(() => api.listShopItems());
  const [note, setNote] = useState<{ tone: ResultTone; seal: string; kicker: string; text: string }>();
  const [error, setError] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<ShopItem | null>(null);
  const [buyingId, setBuyingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Generator (creator only)
  const [genOpen, setGenOpen] = useState(false);
  const [genForm, setGenForm] = useState<{
    count: number;
    theme: string;
    rarityHint: '' | ItemRarity;
    categoryHint: '' | ItemCategory;
    minPrice: string;
    maxPrice: string;
  }>({ count: 4, theme: '', rarityHint: '', categoryHint: '', minPrice: '', maxPrice: '' });
  const [generating, setGenerating] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [saving, setSaving] = useState(false);

  const buy = async (item: ShopItem) => {
    if (buyingId) return; // a purchase is in flight — don't double-spend
    setBuyingId(item.id);
    setNote(undefined);
    setError(undefined);
    try {
      await api.purchase(item.id, 1, activeWorldId ?? undefined);
      await reloadPlayer();
      state.reload();
      setNote({ tone: 'brass', seal: '✦', kicker: t('shop.resultAcquired'), text: t('shop.purchased', { name: item.name }) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBuyingId(null);
    }
  };

  const removeItem = async (item: ShopItem) => {
    if (deleting) return;
    setDeleting(true);
    setError(undefined);
    try {
      await api.deleteShopItem(item.id);
      state.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  };

  const generate = async () => {
    setGenerating(true);
    setError(undefined);
    setNote(undefined);
    setDrafts([]); // never leave a prior batch on screen that doesn't match this attempt
    try {
      const res = await api.generateShopItems({
        count: genForm.count,
        theme: genForm.theme,
        rarityHint: genForm.rarityHint || undefined,
        categoryHint: genForm.categoryHint || undefined,
        minPrice: genForm.minPrice === '' ? undefined : Number(genForm.minPrice),
        maxPrice: genForm.maxPrice === '' ? undefined : Number(genForm.maxPrice),
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
      if (res.ok) setDrafts(res.data.map((item) => ({ keep: true, item })));
      else setError(t('shop.genFailed', { error: res.error }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setGenerating(false);
    }
  };

  const editDraft = (i: number, patch: Partial<ShopItemCreate>) =>
    setDrafts((ds) => ds.map((d, idx) => (idx === i ? { ...d, item: { ...d.item, ...patch } } : d)));
  const toggleKeep = (i: number) =>
    setDrafts((ds) => ds.map((d, idx) => (idx === i ? { ...d, keep: !d.keep } : d)));

  const keptCount = drafts.filter((d) => d.keep).length;

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const kept = drafts.filter((d) => d.keep).map((d) => d.item);
      for (const item of kept) await api.createShopItem(item);
      setNote({ tone: 'brass', seal: '❧', kicker: t('shop.resultStocked'), text: t('shop.saved', { count: kept.length }) });
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

  const money = player?.money ?? 0;

  return (
    <div className="stack">
      <div className="card shop-counter">
        <div className="shop-counter-lamp"><Icon name="shop" size={28} /></div>
        <div className="shop-counter-text">
          <div className="kicker">{t('shop.kicker')}</div>
          <h1>{t('shop.title')}</h1>
          <p>{t('shop.blurb')}</p>
        </div>
        <div className="shop-counter-side">
          <span className="shop-purse">
            <span className="shop-purse-label">{t('shop.purse')}</span>
            <span className="shop-purse-coin">◈ {money}</span>
          </span>
          {creatorMode && !genOpen && (
            <button className="btn primary sm" onClick={() => setGenOpen(true)}>
              <Icon name="generate" size={15} /> {t('shop.generateItems')}
            </button>
          )}
        </div>
      </div>
      {note && <ResultCard tone={note.tone} seal={note.seal} kicker={note.kicker} summary={note.text} />}
      {error && <Banner kind="error">{error}</Banner>}

      {creatorMode && genOpen && (
        <div className="framed shop-gen stack">
          <div className="shop-gen-head">
            <div>
              <div className="kicker">{t('shop.workshop')}</div>
              <h2>{t('shop.genTitle')}</h2>
            </div>
            <button className="btn ghost sm" onClick={closeGen}>
              {t('shop.close')}
            </button>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            {t('shop.genHintPre')}
            {activeWorld ? <strong>{activeWorld.name}</strong> : t('shop.genericSetting')}
            {t('shop.genHintPost')}
          </p>

          <div className="inline-fields">
            <Field label={t('shop.howMany')}>
              <input
                type="number"
                min={1}
                max={12}
                value={genForm.count}
                onChange={(e) => setGenForm({ ...genForm, count: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })}
              />
            </Field>
            <Field label={t('shop.rarityHint')}>
              <select
                value={genForm.rarityHint}
                onChange={(e) => setGenForm({ ...genForm, rarityHint: e.target.value as '' | ItemRarity })}
              >
                <option value="">{t('shop.any')}</option>
                {RARITIES.map((r) => (
                  <option key={r} value={r}>
                    {itemRarityLabel(r)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('shop.categoryHint')}>
              <select
                value={genForm.categoryHint}
                onChange={(e) => setGenForm({ ...genForm, categoryHint: e.target.value as '' | ItemCategory })}
              >
                <option value="">{t('shop.any')}</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {itemCategoryLabel(c)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="inline-fields">
            <Field label={t('shop.minPrice')}>
              <input
                type="number"
                min={0}
                value={genForm.minPrice}
                onChange={(e) => setGenForm({ ...genForm, minPrice: e.target.value })}
              />
            </Field>
            <Field label={t('shop.maxPrice')}>
              <input
                type="number"
                min={0}
                value={genForm.maxPrice}
                onChange={(e) => setGenForm({ ...genForm, maxPrice: e.target.value })}
              />
            </Field>
          </div>
          <Field label={t('shop.theme')} hint={t('shop.themeHint')}>
            <textarea
              value={genForm.theme}
              onChange={(e) => setGenForm({ ...genForm, theme: e.target.value })}
              placeholder={t('shop.themePlaceholder')}
            />
          </Field>

          <div className="row">
            <button className="btn primary" onClick={generate} disabled={generating}>
              {generating ? t('shop.generating') : <><Icon name="generate" size={15} /> {t('shop.generate')}</>}
            </button>
            {drafts.length > 0 && (
              <button className="btn" onClick={save} disabled={saving || keptCount === 0}>
                {saving ? t('shop.saving') : t('shop.saveSelected', { count: keptCount })}
              </button>
            )}
          </div>

          {drafts.length > 0 && (
            <>
              <div className="shop-gen-divider">{t('shop.reviewRefine')}</div>
              <p className="hint" style={{ marginTop: 0 }}>
                {t('shop.reviewHint', { count: drafts.length })}
              </p>
              <div className="shop-drafts">
                {drafts.map((d, i) => (
                  <div className={`shop-draft${d.keep ? '' : ' dropped'}`} key={i}>
                    <div className="shop-draft-top">
                      <label className="shop-draft-keep">
                        <input type="checkbox" checked={d.keep} onChange={() => toggleKeep(i)} />
                        {d.keep ? t('shop.keep') : t('shop.skipped')}
                      </label>
                      <span className="money-pill">◈ {d.item.price ?? 0}</span>
                    </div>
                    <div className="inline-fields">
                      <Field label={t('shop.name')}>
                        <input value={d.item.name} onChange={(e) => editDraft(i, { name: e.target.value })} />
                      </Field>
                      <Field label={t('shop.price')}>
                        <input
                          type="number"
                          min={0}
                          value={d.item.price ?? 0}
                          onChange={(e) => editDraft(i, { price: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      </Field>
                    </div>
                    <div className="inline-fields">
                      <Field label={t('shop.rarity')}>
                        <select
                          value={d.item.rarity ?? 'common'}
                          onChange={(e) => editDraft(i, { rarity: e.target.value as ItemRarity })}
                        >
                          {RARITIES.map((r) => (
                            <option key={r} value={r}>
                              {itemRarityLabel(r)}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label={t('shop.category')}>
                        <select
                          value={d.item.category ?? 'gift'}
                          onChange={(e) => editDraft(i, { category: e.target.value as ItemCategory })}
                        >
                          {CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {itemCategoryLabel(c)}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <Field label={t('shop.description')}>
                      <textarea
                        value={d.item.description ?? ''}
                        onChange={(e) => editDraft(i, { description: e.target.value })}
                      />
                    </Field>
                    {(d.item.effects ?? []).length > 0 && (
                      <div className="tags">
                        {(d.item.effects ?? []).map((eff, j) => (
                          <span className="tag" key={j}>
                            {describeItemEffect(eff)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <Loader state={state}>
        {(items) =>
          items.length === 0 ? (
            <Empty icon={<Icon name="shop" size={34} />} title={t('shop.emptyTitle')}>
              <p className="muted">
                {creatorMode ? t('shop.emptyCreator') : t('shop.emptyPlayer')}
              </p>
            </Empty>
          ) : (
            <>
              <div className="section-head shop-shelf-head">
                <div className="titles">
                  <div className="kicker">{t('shop.onTheShelf')}</div>
                  <h2>{t('shop.inStock', { count: items.length })}</h2>
                </div>
                <div className="trail" />
              </div>
              <div className="shop-grid">
                {items.map((item) => {
                  const soldOut = !item.infiniteStock && item.stock <= 0;
                  const cantAfford = money < item.price;
                  return (
                    <div className={`shop-item rar-${item.rarity}${soldOut ? ' sold' : ''}`} key={item.id}>
                      <div className="shop-item-body">
                        <div className="shop-item-top">
                          <div className="shop-item-icon" aria-hidden="true">
                            <Icon name={CATEGORY_ICON[item.category]} size={22} />
                          </div>
                          <div className="flex-fill">
                            <h3 className="shop-item-name">{item.name}</h3>
                            <div className="shop-item-cat">{itemCategoryLabel(item.category)}</div>
                          </div>
                          <span className="shop-item-rarity">{itemRarityLabel(item.rarity)}</span>
                        </div>
                        <p className="shop-item-desc">{item.description}</p>
                        {item.effects.length > 0 && (
                          <div className="tags shop-item-effects">
                            {item.effects.map((eff, i) => (
                              <span className="tag" key={i}>
                                {describeItemEffect(eff)}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="shop-item-stats">
                        <span className={`shop-price${cantAfford && !soldOut ? ' too-dear' : ''}`}>
                          ◈ {item.price}
                        </span>
                        {!item.infiniteStock && (
                          <span className={`shop-stock${soldOut ? ' out' : ''}`}>
                            {soldOut ? t('shop.outOfStock') : t('shop.stockLeft', { count: item.stock })}
                          </span>
                        )}
                      </div>
                      <div className="shop-item-actions">
                        <button
                          className="btn primary flex-fill"
                          disabled={soldOut || cantAfford || buyingId !== null}
                          onClick={() => buy(item)}
                        >
                          {soldOut ? t('shop.soldOut') : cantAfford ? t('shop.notEnough') : buyingId === item.id ? t('shop.buying') : t('shop.buy')}
                        </button>
                        {creatorMode && (
                          <button className="btn danger ghost" onClick={() => setPendingDelete(item)} title={t('shop.deleteItem')} aria-label={t('shop.deleteItem')}>
                            <Icon name="trash" size={16} />
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

      {pendingDelete && (
        <ConfirmDialog
          title={t('shop.confirmDeleteTitle', { name: pendingDelete.name })}
          body={t('shop.confirmDeleteBody')}
          confirmLabel={t('shop.confirmDelete')}
          danger
          busy={deleting}
          onConfirm={() => removeItem(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
