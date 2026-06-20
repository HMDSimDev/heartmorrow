import {
  CharacterChronicleSchema,
  ChronicleSchema,
  CHRONICLE_FOLD_EVERY,
  DEFAULT_PLAYER_ID,
  type CharacterChronicle,
  type ConversationMode,
} from '@dsim/shared';
import { charactersRepo, chroniclesRepo } from '../db/repositories';
import { getLlmSettings } from './settings-service';
import { getOrCreatePlayer } from './player-service';
import { callStructuredLlm } from '../llm/structured';
import { buildChronicleFoldMessages } from '../prompt/prompt-builder';
import { recordEvent } from './event-service';
import { playerIdForWorldOrDefault } from '../lib/ids';

/** Get (or lazily create) the running chronicle of history with a character. */
export function getChronicle(characterId: string, playerId: string = DEFAULT_PLAYER_ID): CharacterChronicle {
  const existing = chroniclesRepo.getByCharacter(characterId, playerId);
  if (existing) return existing;
  return chroniclesRepo.insert(
    CharacterChronicleSchema.parse({ characterId, playerId, chronicle: '', recentLines: [], sessionCount: 0, updatedAt: Date.now() }),
  );
}

/**
 * Record a date's one-line highlight in the chronicle. Every few dates the
 * accumulated highlights are FOLDED (compressed) into the narrative so the
 * character can reference older dates without unbounded prompt growth.
 */
export function appendSessionToChronicle(
  characterId: string,
  summaryLine: string,
  mode: ConversationMode,
  day: number,
  playerId: string = DEFAULT_PLAYER_ID,
): void {
  // A real date counts as a session in the chronicle's date tally.
  appendChronicleLine(characterId, day, mode, summaryLine, { bumpSession: true }, playerId);
}

/**
 * Push one line into the chronicle's recent-highlights buffer. Used by both
 * date summaries (bumpSession) and out-of-band notes like milestones
 * (bumpSession=false, so they don't inflate the "N dates" count). Folds when the
 * buffer crosses the threshold, exactly like a normal append.
 */
export function appendChronicleLine(
  characterId: string,
  day: number,
  mode: ConversationMode,
  line: string,
  opts: { bumpSession?: boolean } = {},
  playerId: string = DEFAULT_PLAYER_ID,
): void {
  if (!line || !line.trim()) return;
  const chron = getChronicle(characterId, playerId);
  // 600 mirrors ChronicleLineSchema.line / SessionEvaluationSchema.summaryLine.
  const recentLines = [...chron.recentLines, { day, mode, line: line.slice(0, 600) }];
  chroniclesRepo.update(
    CharacterChronicleSchema.parse({
      ...chron,
      recentLines,
      sessionCount: chron.sessionCount + (opts.bumpSession ? 1 : 0),
      updatedAt: Date.now(),
    }),
  );
  recordEvent('chronicle_appended', { characterId });
  if (recentLines.length >= CHRONICLE_FOLD_EVERY) {
    void foldChronicle(characterId, playerId).catch(() => undefined); // background; fail-safe
  }
}

/**
 * Folds currently in flight, keyed by character+player. The append trigger can
 * fire on every date once the buffer is at/over the threshold, and folding is
 * async — without coalescing, two overlapping folds would each
 * `slice(folded.length)` off the same buffer and silently drop lines. Re-entrant
 * callers SHARE the running fold's promise (so an awaiting caller sees it finish)
 * while only one fold actually runs per key.
 */
const foldsInFlight = new Map<string, Promise<void>>();

/** Compress the recent highlights into the folded narrative (structured, fail-safe). */
export function foldChronicle(characterId: string, playerId: string = DEFAULT_PLAYER_ID): Promise<void> {
  const key = `${characterId}|${playerId}`;
  const running = foldsInFlight.get(key);
  if (running) return running; // coalesce onto the in-flight fold
  const chron = getChronicle(characterId, playerId);
  const folded = chron.recentLines; // captured before the (async) LLM call
  if (folded.length === 0) return Promise.resolve();
  const run = (async () => {
    const character = charactersRepo.get(characterId);
    const settings = getLlmSettings();
    const result = await callStructuredLlm(
      ChronicleSchema,
      buildChronicleFoldMessages({
        characterName: character?.name ?? 'They',
        playerName: getOrCreatePlayer(playerIdForWorldOrDefault(character?.worldId)).name,
        existing: chron.chronicle,
        lines: folded,
      }),
      {
        settings,
        task: 'Fold recent date highlights into the chronicle.',
        schemaName: 'Chronicle',
        // The chronicle may run up to ~5000 chars; ensure enough output budget to
        // finish the JSON (otherwise it's cut off mid-string and discarded).
        maxTokens: Math.max(settings.maxTokens, 4000),
      },
    );
    if (!result.ok) {
      recordEvent('chronicle_fold_failed', { characterId, error: result.error });
      return; // keep the buffer; try again next time
    }
    // Re-read and drop only the folded prefix, keeping any lines added meanwhile.
    const latest = getChronicle(characterId, playerId);
    chroniclesRepo.update(
      CharacterChronicleSchema.parse({
        ...latest,
        chronicle: result.data.chronicle,
        recentLines: latest.recentLines.slice(folded.length),
        updatedAt: Date.now(),
      }),
    );
    recordEvent('chronicle_folded', { characterId });
  })().finally(() => foldsInFlight.delete(key));
  foldsInFlight.set(key, run);
  return run;
}
