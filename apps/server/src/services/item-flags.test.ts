import { describe, it, expect } from 'vitest';
import { GenerateShopItemsInputSchema, type GeneratedShopItem } from '@dsim/shared';
import { boundGeneratedItem } from './shop-service';

describe('generated item flag effects are canonical', () => {
  it('keeps a canonical story flag and drops a free-form one', () => {
    const data = GenerateShopItemsInputSchema.parse({ count: 1 });
    const g: GeneratedShopItem = {
      name: 'Keepsake',
      description: 'a small token of the night',
      category: 'gift',
      rarity: 'common',
      price: 20,
      effects: [
        { kind: 'flag', flag: 'firstKiss', value: true }, // canonical → kept
        { kind: 'flag', flag: 'wentDancing', value: true }, // free-form → dropped
      ],
    };
    const bounded = boundGeneratedItem(g, data);
    const flags = (bounded.effects ?? []).flatMap((e) => (e.kind === 'flag' ? [e.flag] : []));
    expect(flags).toEqual(['firstKiss']);
  });
});
