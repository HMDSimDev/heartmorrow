import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { generateShopItems } from './shop-service';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('shop item generation (server bounding)', () => {
  it('guards against a money-printer and drops reserved internal flags', async () => {
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({
          items: [
            {
              name: 'Lucky Coin',
              description: 'A coin that always lands your way.',
              category: 'gift',
              rarity: 'common',
              price: 10,
              effects: [
                { kind: 'money', delta: 100 },
                { kind: 'flag', flag: 'lastSeenDay', value: true }, // reserved bookkeeping key
              ],
            },
          ],
        }),
      ]),
    );
    const res = await generateShopItems({ count: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const item = res.data[0]!;
    // Buying it can never net a profit: price must exceed the money payout.
    expect(item.price).toBeGreaterThanOrEqual(101);
    const effects = item.effects ?? [];
    expect(effects.some((e) => e.kind === 'money')).toBe(true);
    expect(effects.some((e) => e.kind === 'flag')).toBe(false); // reserved flag dropped
  });

  it('clamps generated price up to the requested minimum', async () => {
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({
          items: [{ name: 'Trinket', description: 'A small thing.', category: 'gift', rarity: 'common', price: 5, effects: [] }],
        }),
      ]),
    );
    const res = await generateShopItems({ count: 1, minPrice: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0]!.price).toBeGreaterThanOrEqual(50);
  });

  it('fails safe (no throw, ok:false) when the model returns unusable output', async () => {
    setAdapterOverride(new ScriptedAdapter(['not json at all']));
    const res = await generateShopItems({ count: 2 });
    expect(res.ok).toBe(false);
  });
});
