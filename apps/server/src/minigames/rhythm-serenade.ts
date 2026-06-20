import {
  RhythmSerenadeConfigSchema,
  RhythmSerenadeSubmissionSchema,
  MinigameRewardSchema,
  type MinigameInfo,
} from '@dsim/shared';
import {
  clamp01,
  scaleReward,
  scoreToGrade,
  type BuiltMinigame,
  type MinigameBuildContext,
  type MinigameModule,
  type ResolveResult,
} from './registry';

const INFO: MinigameInfo = {
  id: 'rhythm_serenade',
  title: 'Heartbeat Serenade',
  description: 'Tap with the beat-lanterns as a little song scrolls by — hold off on the rests, and keep your streak alive.',
  targetStats: ['confidence', 'charm', 'chemistry'],
  rewardsCharacter: true,
};

const BEAT_COUNT = 16;
const HIT_WINDOW_MS = 180;
const PERFECT_MS = 45;
const COMBO_STEP = 0.08;
const MAX_COMBO_MULT = 1.5;

interface RhythmState {
  beatSlots: number[];
  restSlots: number[];
  hitWindowMs: number;
  perfectMs: number;
  comboStep: number;
  maxComboMult: number;
  beatCount: number;
}

/**
 * Single in-order combo walk shared by the scored pass AND the max-possible
 * denominator, so the two can never drift (a perfect run is exactly 100).
 *  - beatQ(index): quality 0..1 of the tap on a beat slot.
 *  - restTapped(index): whether a rest slot was (wrongly) tapped.
 */
function comboWalk(
  state: RhythmState,
  beatQ: (index: number) => number,
  restTapped: (index: number) => boolean,
): number {
  const beats = new Set(state.beatSlots);
  let raw = 0;
  let streak = 0;
  for (let i = 0; i < state.beatCount; i += 1) {
    if (beats.has(i)) {
      const q = beatQ(i);
      if (q >= 0.5) {
        streak += 1;
        raw += q * Math.min(1 + state.comboStep * streak, state.maxComboMult);
      } else {
        streak = 0;
        raw += q; // small partial credit, no combo
      }
    } else if (restTapped(i)) {
      raw -= 0.5; // tapping a rest costs and breaks the streak
      streak = 0;
    }
    // a correctly-skipped rest keeps the streak alive
  }
  return raw;
}

export const rhythmSerenadeModule: MinigameModule = {
  info: INFO,

  build(ctx: MinigameBuildContext): Promise<BuiltMinigame> {
    const bpm = 96 + Math.floor(Math.random() * 28); // 96..123
    const slots: Array<{ index: number; kind: 'beat' | 'rest'; laneHint: number }> = [];
    const beatSlots: number[] = [];
    const restSlots: number[] = [];
    for (let i = 0; i < BEAT_COUNT; i += 1) {
      // ~28% rests, never the first slot and never two rests in a row.
      const prevRest = slots[i - 1]?.kind === 'rest';
      const isRest = i > 0 && !prevRest && Math.random() < 0.28;
      const kind: 'beat' | 'rest' = isRest ? 'rest' : 'beat';
      slots.push({ index: i, kind, laneHint: Math.floor(Math.random() * 4) });
      (kind === 'beat' ? beatSlots : restSlots).push(i);
    }
    const config = RhythmSerenadeConfigSchema.parse({
      bpm,
      leadInMs: 1600,
      beatCount: BEAT_COUNT,
      hitWindowMs: HIT_WINDOW_MS,
      slots,
      themeLabel: ctx.character ? `A little song for ${ctx.character.name}` : 'A little night song',
    });
    const state: RhythmState = {
      beatSlots,
      restSlots,
      hitWindowMs: HIT_WINDOW_MS,
      perfectMs: PERFECT_MS,
      comboStep: COMBO_STEP,
      maxComboMult: MAX_COMBO_MULT,
      beatCount: BEAT_COUNT,
    };
    return Promise.resolve({ config, state });
  },

  resolve(submission: unknown, state: unknown): ResolveResult {
    const sub = RhythmSerenadeSubmissionSchema.parse(submission);
    const st = state as RhythmState;

    // Sanitize: at most ONE tap per slot, discard out-of-range, coerce bad offsets.
    const tapBySlot = new Map<number, number>();
    for (const t of sub.taps) {
      if (t.slotIndex < 0 || t.slotIndex >= st.beatCount) continue;
      if (tapBySlot.has(t.slotIndex)) continue; // keep first
      const off = Number.isFinite(t.offsetMs) ? Math.abs(t.offsetMs) : st.hitWindowMs;
      tapBySlot.set(t.slotIndex, Math.min(off, st.hitWindowMs));
    }

    const beatQ = (i: number): number => {
      const d = tapBySlot.get(i);
      if (d === undefined) return 0; // missed beat
      return d <= st.perfectMs ? 1 : 1 - d / st.hitWindowMs;
    };
    const restTapped = (i: number): boolean => tapBySlot.has(i);

    const raw = comboWalk(st, beatQ, restTapped);
    // Denominator: every beat perfect (q=1), no rest taps — same walk, no drift.
    const maxRaw = comboWalk(st, () => 1, () => false);
    const score = maxRaw > 0 ? Math.round(clamp01(raw / maxRaw) * 100) : 0;
    const grade = scoreToGrade(score);

    const base = MinigameRewardSchema.parse({
      dating: { confidence: 4, charm: 3 },
      relationship: { chemistry: 6, comfort: 2 },
      money: 30,
    });
    return { score, grade, reward: scaleReward(base, grade) };
  },
};
