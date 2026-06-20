import {
  CharacterMemorySchema,
  PROMPT_LIMITS,
  type CharacterMemory,
  type MemoryCandidate,
  type MemoryCreate,
} from '@dsim/shared';
import { memoriesRepo } from '../db/repositories';
import { newId } from '../lib/ids';

/** Tag marking a memory of the character's OWN off-screen life (from the world-sim). */
export const NPC_LIFE_TAG = 'npc_life';
/** How many npc_life memories may appear in one prompt — they never crowd out real ones. */
const NPC_LIFE_MEMORY_CAP = 2;

export function listMemories(characterId: string): CharacterMemory[] {
  return memoriesRepo.listByCharacter(characterId);
}

/**
 * A low-importance memory of the character's OWN recent life produced by the
 * world-sim (e.g. "caught up with Bo at the café"). Tagged so `selectTopMemories`
 * caps how many reach a prompt — they color "what's new with you" without burying
 * the real history with the player. `relatedCharacterId` (the other person the
 * moment involves) lets the two parties' memories of the same encounter be
 * cross-referenced and looked up by who they're about.
 */
export function addLifeMemory(
  characterId: string,
  text: string,
  importance: number,
  relatedCharacterId: string | null = null,
): CharacterMemory {
  return memoriesRepo.insert(
    CharacterMemorySchema.parse({
      id: newId('mem'),
      characterId,
      text,
      importance,
      tags: [NPC_LIFE_TAG],
      sourceEventId: null,
      relatedCharacterId,
      createdAt: Date.now(),
      lastUsedAt: null,
    }),
  );
}

/** Add a manually-authored memory from the character editor. */
export function addManualMemory(characterId: string, input: MemoryCreate): CharacterMemory {
  const memory = CharacterMemorySchema.parse({
    ...input,
    id: newId('mem'),
    characterId,
    sourceEventId: null,
    createdAt: Date.now(),
    lastUsedAt: null,
  });
  return memoriesRepo.insert(memory);
}

/** Persist memory candidates produced by a validated session evaluation. */
export function addMemoriesFromEvaluation(
  characterId: string,
  candidates: MemoryCandidate[],
  sourceEventId: string | null,
): CharacterMemory[] {
  const now = Date.now();
  return candidates.map((c) =>
    memoriesRepo.insert(
      CharacterMemorySchema.parse({
        id: newId('mem'),
        characterId,
        text: c.text,
        importance: c.importance,
        tags: c.tags,
        sourceEventId,
        createdAt: now,
        lastUsedAt: null,
      }),
    ),
  );
}

export function deleteMemory(id: string): void {
  memoriesRepo.delete(id);
}

/**
 * Select the most relevant memories for a prompt: highest importance first,
 * then most recent. Marks the chosen memories as recently used.
 */
export function selectTopMemories(
  characterId: string,
  limit: number = PROMPT_LIMITS.topMemories,
): CharacterMemory[] {
  const all = memoriesRepo.listByCharacter(characterId);
  const ranked = [...all].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return b.createdAt - a.createdAt;
  });
  // Take the top `limit`, but cap world-sim "life" memories so a busy social week
  // can't push out the real history with the player.
  const chosen: CharacterMemory[] = [];
  let lifeCount = 0;
  for (const m of ranked) {
    if (chosen.length >= limit) break;
    const isLife = m.tags.includes(NPC_LIFE_TAG);
    if (isLife && lifeCount >= NPC_LIFE_MEMORY_CAP) continue;
    if (isLife) lifeCount += 1;
    chosen.push(m);
  }
  const now = Date.now();
  for (const m of chosen) memoriesRepo.touch(m.id, now);
  return chosen;
}
