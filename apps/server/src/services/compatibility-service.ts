import { mutualAttraction, type Character, type MutualAttraction, type PlayerProfile } from '@dsim/shared';
import { charactersRepo } from '../db/repositories';
import { getOrCreatePlayer } from './player-service';
import { playerIdForWorldOrDefault } from '../lib/ids';

/**
 * Orientation compatibility between the player and a character. `mutual` false
 * means romance is GATED (warmth can't climb past the incompatible ceiling, so no
 * dating/milestones/intimacy). `bIntoA` is whether the CHARACTER is attracted to
 * the player — when false, the character is the one who reveals their orientation
 * and gently declines romance.
 */
export interface RomanticCompat extends MutualAttraction {
  character: Character;
  player: PlayerProfile;
}

/** Read the player↔character attraction compatibility, or null if no such character. */
export function romanticCompatFor(characterId: string): RomanticCompat | null {
  const character = charactersRepo.get(characterId);
  if (!character) return null;
  const player = getOrCreatePlayer(playerIdForWorldOrDefault(character.worldId));
  const m = mutualAttraction(
    { gender: player.gender, sexuality: player.sexuality },
    { gender: character.gender, sexuality: character.sexuality },
  );
  return { ...m, character, player };
}
