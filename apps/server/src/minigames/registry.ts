import { MinigameRewardSchema } from '@dsim/shared';
import type {
  Character,
  Grade,
  LlmSettings,
  MinigameId,
  MinigameInfo,
  MinigameReward,
  Relationship,
  World,
  WorldNote,
} from '@dsim/shared';

/**
 * Minigame framework. Each minigame is a `MinigameModule` with:
 *  - `info`: static metadata for listings.
 *  - `build`: produce the client config + opaque server-side STATE (answer
 *    keys, totals) that the client never sees.
 *  - `resolve`: given the client's raw performance submission + the server
 *    state, compute the authoritative score/grade/reward.
 *
 * See docs/ADDING_MINIGAMES.md to add a new one.
 */

export interface MinigameBuildContext {
  character: Character | null;
  /** The player's relationship with `character`, if any — lets a game scale to closeness. */
  relationship: Relationship | null;
  world: World | null;
  worldNotes: WorldNote[];
  settings: LlmSettings;
  log?: (message: string) => void;
}

export interface BuiltMinigame {
  /** Sent to the client (validated by the matching config schema). */
  config: unknown;
  /** Kept SERVER-SIDE only (answer keys, totals). Never returned to client. */
  state: unknown;
}

export interface ResolveResult {
  score: number; // 0..100
  grade: Grade;
  reward: MinigameReward;
}

export interface MinigameModule {
  info: MinigameInfo;
  build(ctx: MinigameBuildContext): Promise<BuiltMinigame>;
  resolve(submission: unknown, state: unknown): ResolveResult;
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function scoreToGrade(score: number): Grade {
  if (score >= 95) return 'S';
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/** Money reward scaled by score/grade. */
export function scoreToMoney(score: number): number {
  return Math.round((score / 100) * 40);
}

/**
 * Per-grade reward multiplier — makes the GRADE load-bearing so an S play is
 * meaningfully better than a B and an F earns nothing. Applied by each module to
 * its base reward via `scaleReward`.
 */
export const GRADE_REWARD_MULT: Record<Grade, number> = {
  S: 1,
  A: 0.85,
  B: 0.65,
  C: 0.45,
  D: 0.25,
  F: 0,
};

/**
 * Scale a base reward by the grade. POSITIVE rewards shrink at lower grades;
 * NEGATIVE consequences (e.g. tension from being fooled) are kept as-is, so a
 * bad play still stings rather than being scaled away. The final ±10 / money cap
 * is enforced separately by `boundReward` in the service (defense in depth).
 */
export function scaleReward(base: MinigameReward, grade: Grade): MinigameReward {
  const m = GRADE_REWARD_MULT[grade] ?? 0;
  const scale = (rec: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(rec)) {
      const next = v >= 0 ? Math.round(v * m) : v;
      if (next !== 0) out[k] = next;
    }
    return out;
  };
  return MinigameRewardSchema.parse({
    dating: scale(base.dating),
    relationship: scale(base.relationship),
    money: Math.round(base.money * m),
  });
}

// Registry is populated by `index.ts` to avoid import cycles.
export const MINIGAME_MODULES: Partial<Record<MinigameId, MinigameModule>> = {};

export function registerMinigame(module: MinigameModule): void {
  MINIGAME_MODULES[module.info.id] = module;
}

export function getMinigameModule(id: MinigameId): MinigameModule {
  const module = MINIGAME_MODULES[id];
  if (!module) throw new Error(`Minigame "${id}" is not registered.`);
  return module;
}

export function listMinigameInfo(): MinigameInfo[] {
  return Object.values(MINIGAME_MODULES)
    .filter((m): m is MinigameModule => Boolean(m))
    .map((m) => m.info);
}
