# Adding characters

## Via the UI (recommended)

1. Open the app → **People** → **+ New**.
2. Fill out identity (name, age 18+, pronouns), description, personality, speech style,
   likes/dislikes/goals/boundaries, and private creator notes. The better you fill this out, the better the character will play.
3. Optionally pick a **World** so world notes and locations are available on dates.
4. Set base **dating stats** with the sliders.
5. Upload a **portrait** and any **expression** images (e.g. `happy`, `sad`). The session
   evaluator may pick an expression key to drive which image is shown.
6. **Create**. After saving you can add manual **memories** and **Preview prompt** to see
   exactly what context will be sent to the model.

All free-text fields are sent to the model as **character data**, never as instructions —
they cannot override the system guardrails.

## Programmatically / seeding

Use the character service (server-side) — see `apps/server/src/seed.ts` for a full example:

```ts
import { createCharacter } from './services/character-service';

createCharacter({
  worldId: world.id,           // or null
  name: 'New Person',
  age: 24,                      // must be >= 18 (schema-enforced)
  pronouns: 'they/them',
  shortDescription: '…',
  personality: '…',
  speechStyle: '…',
  likes: ['…'], dislikes: ['…'], goals: ['…'], boundaries: ['…'],
  datingStats: { charm: 60, empathy: 70, humor: 65, confidence: 55, intellect: 72, style: 50 },
  expressionAssets: {},        // { happy: assetId, ... }
});
```

`createCharacter` validates the input (including age ≥ 18), normalizes defaults, persists,
and creates the initial relationship row automatically.

## Notes

- Age under 18 is rejected at validation time (`CharacterCreateSchema`).
- A relationship row (affection/trust/etc.) is created with every character.
- `portraitAssetId` / `expressionAssets` reference uploaded **assets** by id — see
  [ADDING_ART.md](ADDING_ART.md).
