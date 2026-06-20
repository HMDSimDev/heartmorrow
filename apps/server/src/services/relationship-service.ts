import {
  DEFAULT_PLAYER_ID,
  DEFAULT_RELATIONSHIP_STATS,
  RelationshipSchema,
  type Relationship,
} from '@dsim/shared';
import { relationshipsRepo } from '../db/repositories';
import { newId } from '../lib/ids';

/** Get the relationship between a character and the player, creating it if missing. */
export function ensureRelationship(
  characterId: string,
  playerId: string = DEFAULT_PLAYER_ID,
): Relationship {
  const existing = relationshipsRepo.getByCharacter(characterId, playerId);
  if (existing) return existing;
  const rel = RelationshipSchema.parse({
    id: newId('rel'),
    characterId,
    playerId,
    ...DEFAULT_RELATIONSHIP_STATS,
    flags: {},
    updatedAt: Date.now(),
  });
  return relationshipsRepo.insert(rel);
}

export function getRelationship(
  characterId: string,
  playerId: string = DEFAULT_PLAYER_ID,
): Relationship {
  return ensureRelationship(characterId, playerId);
}
