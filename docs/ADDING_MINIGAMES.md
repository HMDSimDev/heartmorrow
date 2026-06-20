# Adding a minigame

Minigames follow a strict security model: the client only submits **raw performance
metrics**; the **server** holds the answer key / scoring formula and computes the score,
grade, and (clamped) rewards. The client can never send stat deltas or money.

## 1. Define the schemas (`packages/shared/src/schemas/minigames.ts`)

- Add your id to `MINIGAME_IDS`.
- Add a **config** schema (sent to the client) and add it to `MinigameConfigSchema`.
- Add a **submission** schema (sent by the client — performance metrics only) and add it
  to `MinigameSubmissionSchema`.

```ts
export const MINIGAME_IDS = ['memory_match', 'timing_meter', 'lore_quiz', 'my_game'] as const;

export const MyGameConfigSchema = z.object({ /* what the client needs to render */ });
export const MyGameSubmissionSchema = z.object({ /* metrics only, e.g. score inputs */ });
// add { minigameId: z.literal('my_game'), config/submission } to the unions
```

## 2. Implement the module (`apps/server/src/minigames/my-game.ts`)

Implement `MinigameModule` (`registry.ts`):

```ts
export const myGameModule: MinigameModule = {
  info: { id: 'my_game', title: 'My Game', description: '…', targetStats: ['charm'], rewardsCharacter: true },

  async build(ctx) {
    // ctx: { character, world, worldNotes, settings, log }
    // Return what the client renders (config) + SECRET server state (answer keys/totals).
    return { config: { /* ... */ }, state: { /* answer key, totals */ } };
  },

  resolve(submission, state) {
    const sub = MyGameSubmissionSchema.parse(submission);
    // Clamp client-claimed performance against `state` (what's physically possible).
    const score = /* 0..100 from sub + state */;
    return {
      score,
      grade: scoreToGrade(score),
      reward: MinigameRewardSchema.parse({ dating: { charm: 3 }, relationship: { affection: 2 }, money: scoreToMoney(score) }),
    };
  },
};
```

If you generate content with the LLM, use `callStructuredLlm` + a Zod schema **and**
provide a deterministic fallback (see `lore-quiz.ts`).

## 3. Register it (`apps/server/src/minigames/index.ts`)

```ts
import { myGameModule } from './my-game';
registerMinigame(myGameModule);
```

## 4. Build the React view (`apps/web/src/components/minigames/MyGame.tsx`)

A component that takes the parsed `config` and calls `onComplete(submission)` with metrics.
Wire it into `apps/web/src/pages/Minigames.tsx#GameView` (parse config with your config
schema and wrap the submission as `{ minigameId: 'my_game', submission }`).

## Guarantees

- `minigame-service.finishMinigame` looks up the server-held run state, validates the
  submission matches the started game, calls your `resolve`, then **bounds every reward**
  (`±10` per stat, `≤100` money) and applies them via `stat-service` / `player-service`.
- The client cannot grant arbitrary rewards — there is no reward field in any submission.
- Covered by `apps/server/src/services/game.test.ts`.
