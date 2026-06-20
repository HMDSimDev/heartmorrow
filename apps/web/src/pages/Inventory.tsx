import { useEffect, useRef, useState } from 'react';
import { describeItemEffect, isGiftableItem, type InventoryItem, type ShopItem } from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { Banner, Empty, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import './inventory.page.css';

interface Entry {
  inventoryItem: InventoryItem;
  item: ShopItem | null;
}

export function Inventory() {
  const { reloadPlayer, activeWorldId, dayTick } = useAppData();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [usingId, setUsingId] = useState<string | null>(null);
  // Monotonic ticket: only the latest load() may commit, so a world switch
  // mid-fetch can't paint a stale world's satchel.
  const reqRef = useRef(0);

  const load = async () => {
    const ticket = ++reqRef.current;
    const world = activeWorldId;
    setLoading(true);
    try {
      const inv = await api.getInventory(world ?? undefined);
      if (ticket !== reqRef.current) return; // superseded by a newer load
      setEntries(inv.entries);
    } catch (e) {
      if (ticket === reqRef.current) setError(errorMessage(e));
    } finally {
      if (ticket === reqRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorldId, dayTick]);

  // The bag is now a viewer: gifts are given on a date or sent by text. The only
  // action left here is using a self-use item (money/consumable) on yourself.
  const use = async (entry: Entry) => {
    if (!entry.item || usingId) return; // a use is in flight — don't consume twice
    setUsingId(entry.inventoryItem.id);
    setNote(undefined);
    setError(undefined);
    try {
      await api.useItem(entry.inventoryItem.id, null, activeWorldId ?? undefined);
      await reloadPlayer();
      await load();
      setNote(`Used ${entry.item.name}.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUsingId(null);
    }
  };

  if (loading) return <Spinner />;

  const slots = entries.reduce((sum, e) => sum + e.inventoryItem.quantity, 0);

  return (
    <div className="stack">
      <div className="framed inv-satchel">
        <div className="inv-satchel-top">
          <div className="inv-satchel-mark" aria-hidden>
            <Icon name="bag" size={26} />
          </div>
          <div className="inv-satchel-titles">
            <span className="kicker">The Satchel</span>
            <h1>Inventory</h1>
            <p>Your keepsakes. Give a gift in person on a date, or send one in a text.</p>
          </div>
          <div className="readout inv-satchel-readout">
            held <span className="num">{slots}</span>
          </div>
        </div>
      </div>

      {note && <Banner kind="ok">{note}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}

      {entries.length === 0 ? (
        <Empty icon={<Icon name="bag" size={34} />} title="Your bag is empty">
          <p>Buy something from the shop first.</p>
        </Empty>
      ) : (
        <div className="inv-grid">
          {entries.map((entry) => {
            const item = entry.item;
            const moneyOnly = !!item && item.effects.every((e) => e.kind === 'money');
            return (
              <div
                className={`inv-pocket rar-${item?.rarity ?? 'common'}`}
                key={entry.inventoryItem.id}
              >
                <div className="inv-pocket-head">
                  <div className="inv-pocket-meta">
                    {item && <span className="inv-pocket-kick">{item.category}</span>}
                    <h3 className="inv-pocket-name">{item?.name ?? 'Unknown item'}</h3>
                  </div>
                  <span className="inv-qty">
                    <span className="x">×</span>
                    <span className="n">{entry.inventoryItem.quantity}</span>
                  </span>
                </div>
                {item && (
                  <>
                    {item.description && <p className="inv-desc">{item.description}</p>}
                    {item.effects.length > 0 && (
                      <div className="inv-effects">
                        {item.effects.map((eff, i) => {
                          const tone =
                            eff.kind === 'money'
                              ? 'coin'
                              : 'delta' in eff && eff.delta < 0
                                ? 'loss'
                                : 'delta' in eff
                                  ? 'gain'
                                  : '';
                          return (
                            <span className={`inv-eff ${tone}`} key={i}>
                              {describeItemEffect(eff)}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    <div className="inv-act">
                      {moneyOnly ? (
                        <button
                          className="btn primary block"
                          onClick={() => use(entry)}
                          disabled={usingId !== null}
                        >
                          {usingId === entry.inventoryItem.id ? 'Using…' : 'Use'}
                        </button>
                      ) : isGiftableItem(item) ? (
                        <p className="inv-hint"><Icon name="gift" size={13} /> Give on a date or by text</p>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
