# Adding shop items

Items have **typed effects** that are applied **server-side only** when used/gifted. The
client never supplies prices, deltas, or money changes.

## Effect types (`packages/shared/src/schemas/items.ts`)

`ItemEffect` is a discriminated union on `kind`:

| kind | fields | applied to |
| --- | --- | --- |
| `relationship` | `stat` (relationship stat), `delta` | the target character's relationship |
| `dating` | `stat` (dating stat), `delta` | the target character's base dating stats |
| `temp_buff` | `stat` (dating stat), `delta`, `durationSessions` | a temporary buff to effective dating stats (decays per session) |
| `flag` | `flag`, `value` | a relationship flag |
| `money` | `delta` | the player's money (no character needed) |

Any effect other than `money` requires a target character when used.

## Via the UI

Shop items are seeded by `pnpm seed`. To create more at runtime, use the API
(`POST /api/shop/items`) — e.g. from the Debug tools or your own script.

## Programmatically / seeding (`apps/server/src/seed.ts`)

```ts
import { createShopItem } from './services/shop-service';

createShopItem({
  name: 'Mixtape',
  description: 'A carefully curated playlist.',
  price: 40,
  category: 'gift',            // gift | consumable | apparel | book | special
  rarity: 'uncommon',          // common | uncommon | rare | legendary
  effects: [
    { kind: 'relationship', stat: 'chemistry', delta: 4 },
    { kind: 'temp_buff', stat: 'charm', delta: 5, durationSessions: 2 },
  ],
  infiniteStock: true,         // or false + a `stock` count
  stock: 0,
  assetId: null,
});
```

## Server-side guarantees

- **Purchase** (`shop-service.purchaseItem`) computes the total cost, checks funds and
  stock, decrements stock, and adds to inventory — all in a single transaction. Insufficient
  funds/stock throws.
- **Use** (`shop-service.useItem`) applies each effect through `stat-service` (which
  clamps every value to 0–100 and records a `GameEvent`).
- Covered by `apps/server/src/services/game.test.ts`.
