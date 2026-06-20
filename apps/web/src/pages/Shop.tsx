import { useState } from 'react';
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
import { Banner, Empty, Field, Loader, ConfirmDialog } from '../components/ui';
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
  const { player, reloadPlayer, creatorMode, activeWorld, activeWorldId } = useAppData();
  const state = useAsync(() => api.listShopItems());
  const [note, setNote] = useState<string>();
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
      setNote(`Purchased ${item.name}!`);
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
      else setError(`Item generation failed: ${res.error}`);
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
      setNote(`Saved ${kept.length} item(s) to the shop.`);
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
          <div className="kicker">The Merchant's Shelf</div>
          <h1>Shop</h1>
          <p>Trinkets, gifts, and small luxuries to bring along on your dates.</p>
        </div>
        <div className="shop-counter-side">
          <span className="shop-purse">
            <span className="shop-purse-label">Purse</span>
            <span className="shop-purse-coin">◈ {money}</span>
          </span>
          {creatorMode && !genOpen && (
            <button className="btn primary sm" onClick={() => setGenOpen(true)}>
              <Icon name="generate" size={15} /> Generate items
            </button>
          )}
        </div>
      </div>
      {note && <Banner kind="ok">{note}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}

      {creatorMode && genOpen && (
        <div className="framed shop-gen stack">
          <div className="shop-gen-head">
            <div>
              <div className="kicker">Creator Workshop</div>
              <h2>Generate in-world items</h2>
            </div>
            <button className="btn ghost sm" onClick={closeGen}>
              Close
            </button>
          </div>
          <p className="hint" style={{ marginTop: 0 }}>
            Creates a batch of lore-friendly items based on{' '}
            {activeWorld ? <strong>{activeWorld.name}</strong> : 'a generic modern setting'}. Nothing is saved until
            you press Save — review and tweak first.
          </p>

          <div className="inline-fields">
            <Field label="How many (1–12)">
              <input
                type="number"
                min={1}
                max={12}
                value={genForm.count}
                onChange={(e) => setGenForm({ ...genForm, count: Math.max(1, Math.min(12, Number(e.target.value) || 1)) })}
              />
            </Field>
            <Field label="Rarity hint">
              <select
                value={genForm.rarityHint}
                onChange={(e) => setGenForm({ ...genForm, rarityHint: e.target.value as '' | ItemRarity })}
              >
                <option value="">— any —</option>
                {RARITIES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Category hint">
              <select
                value={genForm.categoryHint}
                onChange={(e) => setGenForm({ ...genForm, categoryHint: e.target.value as '' | ItemCategory })}
              >
                <option value="">— any —</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="inline-fields">
            <Field label="Min price (◈)">
              <input
                type="number"
                min={0}
                value={genForm.minPrice}
                onChange={(e) => setGenForm({ ...genForm, minPrice: e.target.value })}
              />
            </Field>
            <Field label="Max price (◈)">
              <input
                type="number"
                min={0}
                value={genForm.maxPrice}
                onChange={(e) => setGenForm({ ...genForm, maxPrice: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Theme / guidance" hint="Optional — e.g. “cozy autumn café trinkets” or “relics from the old harbor”.">
            <textarea
              value={genForm.theme}
              onChange={(e) => setGenForm({ ...genForm, theme: e.target.value })}
              placeholder="Describe the kind of items you want…"
            />
          </Field>

          <div className="row">
            <button className="btn primary" onClick={generate} disabled={generating}>
              {generating ? 'Generating…' : <><Icon name="generate" size={15} /> Generate</>}
            </button>
            {drafts.length > 0 && (
              <button className="btn" onClick={save} disabled={saving || keptCount === 0}>
                {saving ? 'Saving…' : `Save ${keptCount} selected`}
              </button>
            )}
          </div>

          {drafts.length > 0 && (
            <>
              <div className="shop-gen-divider">Review &amp; refine</div>
              <p className="hint" style={{ marginTop: 0 }}>
                Review the {drafts.length} generated item(s). Uncheck any you don't want, edit the rest, then Save.
                Effects are balanced behind the scenes and shown read-only.
              </p>
              <div className="shop-drafts">
                {drafts.map((d, i) => (
                  <div className={`shop-draft${d.keep ? '' : ' dropped'}`} key={i}>
                    <div className="shop-draft-top">
                      <label className="shop-draft-keep">
                        <input type="checkbox" checked={d.keep} onChange={() => toggleKeep(i)} />
                        {d.keep ? 'Keep' : 'Skipped'}
                      </label>
                      <span className="money-pill">◈ {d.item.price ?? 0}</span>
                    </div>
                    <div className="inline-fields">
                      <Field label="Name">
                        <input value={d.item.name} onChange={(e) => editDraft(i, { name: e.target.value })} />
                      </Field>
                      <Field label="Price (◈)">
                        <input
                          type="number"
                          min={0}
                          value={d.item.price ?? 0}
                          onChange={(e) => editDraft(i, { price: Math.max(0, Number(e.target.value) || 0) })}
                        />
                      </Field>
                    </div>
                    <div className="inline-fields">
                      <Field label="Rarity">
                        <select
                          value={d.item.rarity ?? 'common'}
                          onChange={(e) => editDraft(i, { rarity: e.target.value as ItemRarity })}
                        >
                          {RARITIES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Category">
                        <select
                          value={d.item.category ?? 'gift'}
                          onChange={(e) => editDraft(i, { category: e.target.value as ItemCategory })}
                        >
                          {CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <Field label="Description">
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
            <Empty icon={<Icon name="shop" size={34} />} title="The shelves are empty">
              <p className="muted">
                {creatorMode ? 'Generate a batch of items above to stock the shelf.' : 'Check back later — new wares arrive in time.'}
              </p>
            </Empty>
          ) : (
            <>
              <div className="section-head shop-shelf-head">
                <div className="titles">
                  <div className="kicker">On the Shelf</div>
                  <h2>{items.length} item{items.length === 1 ? '' : 's'} in stock</h2>
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
                            <div className="shop-item-cat">{item.category}</div>
                          </div>
                          <span className="shop-item-rarity">{item.rarity}</span>
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
                            {soldOut ? 'Out of stock' : `${item.stock} left`}
                          </span>
                        )}
                      </div>
                      <div className="shop-item-actions">
                        <button
                          className="btn primary flex-fill"
                          disabled={soldOut || cantAfford || buyingId !== null}
                          onClick={() => buy(item)}
                        >
                          {soldOut ? 'Sold out' : cantAfford ? 'Not enough ◈' : buyingId === item.id ? 'Buying…' : 'Buy'}
                        </button>
                        {creatorMode && (
                          <button className="btn danger ghost" onClick={() => setPendingDelete(item)} title="Delete item" aria-label="Delete item">
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
          title={`Delete ${pendingDelete.name}?`}
          body="This removes the item from the shop."
          confirmLabel="Delete"
          danger
          busy={deleting}
          onConfirm={() => removeItem(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
