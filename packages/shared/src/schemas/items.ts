import { z } from 'zod';
import { DatingStatKeySchema, RelationshipStatKeySchema } from '../stats';

/**
 * Typed shop-item effects. Item effects are applied SERVER-SIDE only. The
 * client may request "use item X on character Y", but never supplies stat
 * deltas or money changes directly.
 */
export const ItemEffectSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('relationship'),
    stat: RelationshipStatKeySchema,
    delta: z.number().int().min(-100).max(100),
  }),
  z.object({
    kind: z.literal('dating'),
    stat: DatingStatKeySchema,
    delta: z.number().int().min(-100).max(100),
  }),
  z.object({
    kind: z.literal('temp_buff'),
    stat: DatingStatKeySchema,
    delta: z.number().int().min(-100).max(100),
    durationSessions: z.number().int().positive().max(50),
  }),
  z.object({
    kind: z.literal('flag'),
    flag: z.string().min(1).max(64),
    value: z.boolean(),
  }),
  z.object({
    kind: z.literal('money'),
    // Bounded like other effects so authored items can't mint absurd currency.
    delta: z.number().int().min(-10_000).max(10_000),
  }),
]);
export type ItemEffect = z.infer<typeof ItemEffectSchema>;

export const ItemRaritySchema = z.enum(['common', 'uncommon', 'rare', 'legendary']);
export type ItemRarity = z.infer<typeof ItemRaritySchema>;

export const ItemCategorySchema = z.enum([
  'gift',
  'consumable',
  'apparel',
  'book',
  'special',
]);
export type ItemCategory = z.infer<typeof ItemCategorySchema>;

/** The non-self-use categories a player can actually GIVE to a character. */
export const GIFTABLE_CATEGORIES: readonly ItemCategory[] = ['gift', 'apparel', 'book', 'special'];

/**
 * Whether an item can be GIVEN to a character (on a date or by text). Consumables
 * are for the player's own use, and anything that moves money is a transaction,
 * not a gesture — neither is giftable. Everything else (gifts, apparel, books,
 * keepsakes) is. Used by the client gift pickers AND re-checked server-side.
 */
export function isGiftableItem(item: { category: ItemCategory; effects: ItemEffect[] }): boolean {
  return GIFTABLE_CATEGORIES.includes(item.category) && !item.effects.some((e) => e.kind === 'money');
}

/** A short human-readable summary of an effect, for UI badges. */
export function describeItemEffect(effect: ItemEffect): string {
  switch (effect.kind) {
    case 'relationship':
      return `${effect.delta >= 0 ? '+' : ''}${effect.delta} ${effect.stat}`;
    case 'dating':
      return `${effect.delta >= 0 ? '+' : ''}${effect.delta} ${effect.stat}`;
    case 'temp_buff':
      return `${effect.delta >= 0 ? '+' : ''}${effect.delta} ${effect.stat} (for ${effect.durationSessions} sessions)`;
    case 'flag':
      return `set flag "${effect.flag}" = ${effect.value}`;
    case 'money':
      return `${effect.delta >= 0 ? '+' : ''}${effect.delta} money`;
    default: {
      const _exhaustive: never = effect;
      return String(_exhaustive);
    }
  }
}
