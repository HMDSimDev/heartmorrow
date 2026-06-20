import {
  CharacterEndingSchema,
  EpilogueSchema,
  DEFAULT_PLAYER_ID,
  endingEligible,
  type CharacterEnding,
  type ConversationMode,
  type Epilogue,
} from '@dsim/shared';
import { parseJsonStrict } from '../lib/json';
import { charactersRepo, endingsRepo } from '../db/repositories';
import { getCharacter } from './character-service';
import { getRelationship } from './relationship-service';
import { getChronicle, appendChronicleLine } from './chronicle-service';
import { getOrCreatePlayer } from './player-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import { buildEpilogueMessages } from '../prompt/prompt-builder';
import { recordEvent } from './event-service';

/** Every "happy ending" the player has reached, oldest first (for the gallery, optionally scoped to one world). */
export function listEndings(worldId?: string): CharacterEnding[] {
  const all = endingsRepo.list();
  if (!worldId) return all;
  return all.filter((e) => charactersRepo.get(e.characterId)?.worldId === worldId);
}

export function getEnding(characterId: string, playerId: string = DEFAULT_PLAYER_ID): CharacterEnding | undefined {
  return endingsRepo.getByCharacter(characterId, playerId);
}

/**
 * Trim text to `max` chars on a sentence/word boundary so a salvage never cuts
 * mid-word: prefer the last sentence end in the back ~40% of the cut, else the
 * last space, else a hard cut.
 */
function softTrim(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentenceEnd >= max * 0.6) return cut.slice(0, sentenceEnd + 1).trim();
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Last-ditch salvage for the once-per-relationship epilogue: if strict validation
 * failed only because the model slightly overshot the length, recover its own JSON
 * from the final raw reply and soft-trim title/epilogue to fit — rather than
 * discarding the milestone entirely (which would leave the player with NO ending).
 * Returns null when there's nothing usable (no raw, not JSON, or empty fields), so
 * the caller still fails safe. Safe here because the epilogue carries no stat fields.
 */
function salvageEpilogue(raw: string | undefined): Epilogue | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = parseJsonStrict(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.title !== 'string' || typeof obj.epilogue !== 'string') return null;
  const candidate = { title: softTrim(obj.title, 80), epilogue: softTrim(obj.epilogue, 2000) };
  const check = EpilogueSchema.safeParse(candidate);
  return check.success ? check.data : null;
}

/**
 * If a relationship has reached its committed peak (living together + sweethearts
 * + calm), generate and record a one-time "happy ending" — a SOFT win. It never
 * locks the character or ends the game; the player keeps playing. Once per
 * (character, player); fail-safe (no record if the LLM can't comply, retried next
 * eligible date). Call AFTER this turn's stat deltas + strain are applied.
 */
export async function maybeReachEnding(
  characterId: string,
  ctx: { day: number; mode: ConversationMode },
  playerId: string = DEFAULT_PLAYER_ID,
): Promise<CharacterEnding | null> {
  if (endingsRepo.getByCharacter(characterId, playerId)) return null; // already reached, once only
  const rel = getRelationship(characterId);
  if (!endingEligible(rel)) return null;

  const character = getCharacter(characterId);
  const settings = getLlmSettings();
  const result = await callStructuredLlm(
    EpilogueSchema,
    buildEpilogueMessages({
      character,
      playerName: getOrCreatePlayer(playerId).name,
      chronicle: getChronicle(characterId, playerId),
    }),
    {
      settings,
      task: `Write the happy-ending epilogue for ${character.name}.`,
      schemaName: 'Epilogue',
      // The epilogue can run to ~2000 chars; floor the budget so a lowered default
      // doesn't cut it mid-JSON (which would discard this once-only milestone).
      maxTokens: Math.max(settings.maxTokens, 2000),
    },
  );
  // Fail-safe WITH a salvage step: this fires once per relationship, so an
  // otherwise-good epilogue that merely overshot the length is recovered and
  // trimmed rather than thrown away (which would leave the player no ending).
  const data = result.ok ? result.data : salvageEpilogue(result.lastRaw);
  if (!data) {
    recordEvent('ending_failed', { characterId, error: result.ok ? 'no epilogue data' : result.error });
    return null;
  }
  if (!result.ok) recordEvent('ending_salvaged', { characterId });

  const ending = endingsRepo.insert(
    CharacterEndingSchema.parse({
      characterId,
      playerId,
      title: data.title,
      epilogue: data.epilogue,
      day: ctx.day,
      createdAt: Date.now(),
    }),
  );
  addMemoriesFromEvaluation(
    characterId,
    [{ text: `We built a happy life together — "${data.title}".`, importance: 5, tags: ['ending'] }],
    null,
  );
  try {
    appendChronicleLine(characterId, ctx.day, ctx.mode, `🏆 ${data.title}`, { bumpSession: false });
  } catch {
    /* chronicle is best-effort */
  }
  recordEvent('ending_reached', { characterId, day: ctx.day, title: data.title });
  return ending;
}
