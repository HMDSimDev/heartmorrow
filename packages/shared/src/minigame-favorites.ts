import { DATING_STAT_KEYS } from './stats';
import type { Character } from './schemas/entities';
import type { MinigameId } from './schemas/minigames';

/**
 * Each character's strongest trait maps to the kind of game they love most.
 * Shared (not server-only) so the Arcade can SHOW the favorite up front — the
 * warmth bonus for playing it, and the sting of a flop, otherwise surprise the
 * player after the fact. The server stays authoritative for the actual bonus
 * (minigames/reactions.ts consumes this same map).
 */
export const FAVORITE_BY_STAT: Record<(typeof DATING_STAT_KEYS)[number], MinigameId> = {
  charm: 'timing_meter',
  empathy: 'sweet_and_sour',
  humor: 'two_truths_a_lie',
  confidence: 'rhythm_serenade',
  intellect: 'lore_quiz',
  style: 'memory_match',
};

/** The game this character enjoys most, from their highest innate stat. */
export function favoriteMinigameFor(character: Character): MinigameId {
  let bestKey: (typeof DATING_STAT_KEYS)[number] = DATING_STAT_KEYS[0];
  let bestVal = -Infinity;
  for (const k of DATING_STAT_KEYS) {
    const v = character.datingStats[k];
    if (v > bestVal) {
      bestVal = v;
      bestKey = k;
    }
  }
  return FAVORITE_BY_STAT[bestKey];
}
