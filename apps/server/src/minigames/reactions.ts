import {
  type Character,
  type Grade,
  type MinigameId,
  type MinigameReaction,
  type RelationshipStatKey,
} from '@dsim/shared';
import { hashFloat } from '../lib/seeded-random';

/**
 * Deterministic (NO-LLM) minigame flavor so a play feels like time spent with a
 * person, not a detached arcade score. The server composes a short in-character
 * reaction from the grade + character; the client only renders it. This keeps
 * `finishMinigame` synchronous and fully testable.
 */

type Tone = MinigameReaction['tone'];

// Moved to @dsim/shared so the Arcade can SHOW a partner's favorite up front;
// re-exported here so server-side consumers keep their import path.
export { favoriteMinigameFor } from '@dsim/shared';

/** A genuine flop with someone isn't free — a small, real letdown (bounded later). */
export const FLOP_PENALTY: Partial<Record<RelationshipStatKey, number>> = { comfort: -2, tension: 2 };
/** A little extra when you play their favorite kind of game and it goes okay+. */
export const FAVORITE_BONUS: Partial<Record<RelationshipStatKey, number>> = { affection: 1, comfort: 1 };

function toneForGrade(grade: Grade): Tone {
  if (grade === 'S' || grade === 'A') return 'delighted';
  if (grade === 'B') return 'warm';
  if (grade === 'C') return 'playful';
  if (grade === 'D') return 'neutral';
  return 'disappointed';
}

const LINES: Record<Tone, string[]> = {
  delighted: [
    `"Okay, you clearly pay attention," {name} says, eyes bright.`,
    `{name} can't stop grinning. "We make a good team, you know that?"`,
    `"That was unfairly good," {name} laughs, leaning a little closer.`,
  ],
  warm: [
    `{name} smiles. "Not bad at all — I had fun with you."`,
    `"You're better at this than I expected," {name} admits, pleased.`,
    `{name} bumps your shoulder. "Good game. Let's do that again sometime."`,
  ],
  playful: [
    `{name} smirks. "A little rusty, but I'll allow it."`,
    `"We'll call that a warm-up," {name} teases.`,
    `{name} laughs. "You got lucky on a couple of those."`,
  ],
  neutral: [
    `{name} shrugs, easy about it. "Eh, it happens. Still nice hanging out."`,
    `"Not your night, huh?" {name} says, not unkindly.`,
    `{name} smiles a little. "Win or lose, I don't mind the company."`,
  ],
  disappointed: [
    `{name} raises an eyebrow. "...Were you even trying?"`,
    `"Oof. Maybe that one just wasn't for us," {name} says, a touch let down.`,
    `{name} sighs, more deflated than angry. "I thought you knew me better than that."`,
  ],
};

const FAVORITE_SUFFIX: Partial<Record<Tone, string>> = {
  delighted: ` "...and this is honestly my favorite thing to do."`,
  warm: ` "This is kind of my thing, so that means a lot."`,
  playful: ` "And this is supposed to be MY game!"`,
};

function pick<T>(arr: T[], seed: string): T {
  return arr[Math.floor(hashFloat(seed) * arr.length)] ?? arr[0]!;
}

/**
 * Build the in-character result-screen reaction. Returns null for solo plays
 * (no character) so the UI falls back to its plain layout.
 */
export function buildMinigameReaction(args: {
  character: Character | null;
  minigameId: MinigameId;
  grade: Grade;
  score: number;
  seed: string;
  playedFavorite: boolean;
}): MinigameReaction | null {
  const { character, grade, seed, playedFavorite } = args;
  if (!character) return null;

  const tone = toneForGrade(grade);
  let line = pick(LINES[tone], `${seed}|${tone}`).replaceAll('{name}', character.name);
  if (playedFavorite && FAVORITE_SUFFIX[tone]) line += FAVORITE_SUFFIX[tone];
  return { line, tone };
}
