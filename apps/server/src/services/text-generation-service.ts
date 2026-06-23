import {
  DailyTextPlanSchema,
  RelationshipBeatTextSchema,
  TextMessageSchema,
  DEFAULT_PLAYER_ID,
  GIFTABLE_RARITIES,
  LAST_SEEN_FLAG,
  FORLORN_NEGLECT_DAYS,
  DAILY_TEXT_CHANCE,
  FORLORN_TEXT_CHANCE,
  DAILY_TEXT_PHASES,
  giftChance,
  isBrokenUp,
  type Character,
  type CharacterMemory,
  type LlmSettings,
  type Relationship,
} from '@dsim/shared';
import { charactersRepo, chroniclesRepo, shopItemsRepo, textMessagesRepo } from '../db/repositories';
import { ensureRelationship, getRelationship } from './relationship-service';
import { setRelationshipFlag } from './stat-service';
import { getOrCreateThread, getRecentTexts, hasDated } from './text-message-service';
import { currentNpcPartners } from './character-service';
import { getWorldAvailability } from './availability-service';
import { listMemories } from './memory-service';
import { getOrCreatePlayer } from './player-service';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import { buildDailyTextPlanMessages, buildRelationshipBeatMessages } from '../prompt/prompt-builder';
import { newId, playerIdForWorldOrDefault } from '../lib/ids';
import { hashFloat, type SeededRandom } from '../lib/seeded-random';
import { recordEvent } from './event-service';

type RelationshipBeat = 'rocks' | 'breakup' | 'reconcile' | 'orientation';

/** Pick the server-owned delivery phase for a queued text (never afternoon). */
function pickTextPhase(seed: string, rng: SeededRandom) {
  return DAILY_TEXT_PHASES[
    Math.min(DAILY_TEXT_PHASES.length - 1, Math.floor(rng(seed) * DAILY_TEXT_PHASES.length))
  ]!;
}

/**
 * Deliver a relationship turning-point text (on-the-rocks warning / breakup /
 * reconcile). These are SERVER-decided beats that must arrive reliably, so they
 * bypass the normal daily cadence — but NOT the availability gate (the caller
 * skips characters who are busy today, and `beat:pending` persists, so the beat
 * simply fires on the next day they're available). Clears `beat:pending` only on
 * success (so a transient LLM failure retries next day). Re-checks the flag after
 * the await to avoid a double-send on overlapping passes.
 */
async function deliverRelationshipBeat(
  worldId: string,
  day: number,
  character: Character,
  rel: Relationship,
  beat: RelationshipBeat,
  settings: LlmSettings,
  playerName: string,
  rng: SeededRandom,
): Promise<void> {
  const result = await callStructuredLlm(
    RelationshipBeatTextSchema,
    buildRelationshipBeatMessages({
      character,
      relationship: rel,
      playerName,
      beat,
      playerGender: getOrCreatePlayer(playerIdForWorldOrDefault(worldId)).gender,
      chronicle: chronicleForPrompt(character.id),
      memories: topMemoriesFor(character.id),
    }),
    { settings, task: `Write ${character.name}'s ${beat} text.`, schemaName: 'RelationshipBeatText' },
  );
  if (!result.ok) {
    recordEvent('relationship_beat_failed', { characterId: character.id, beat, error: result.error });
    return; // keep beat:pending so it retries on a future day
  }
  // Re-check AFTER the await: an overlapping pass may have already sent + cleared it.
  if (getRelationship(character.id).flags['beat:pending'] !== beat) return;
  setRelationshipFlag(character.id, 'beat:pending', '', { source: 'beat' });

  const thread = getOrCreateThread(character.id);
  const now = Date.now();
  textMessagesRepo.insert(
    TextMessageSchema.parse({
      id: newId('txt'),
      threadId: thread.id,
      sender: 'character',
      body: result.data.body,
      status: 'queued',
      dayNumber: day,
      scheduledPhase: pickTextPhase(`beatphase|${worldId}|${day}|${character.id}`, rng),
      attachment: null,
      deliveredAt: null,
      createdAt: now,
    }),
  );
  recordEvent('relationship_beat_sent', { characterId: character.id, beat, day });
}

/** A few top memories (importance, then recency) for personalizing a text. */
function topMemoriesFor(characterId: string, limit = 5): CharacterMemory[] {
  return [...listMemories(characterId)]
    .sort((a, b) => (b.importance !== a.importance ? b.importance - a.importance : b.createdAt - a.createdAt))
    .slice(0, limit);
}

/** The folded cross-date history for a character, shaped for the phone prompts so
 *  outgoing texts reflect the last date(s) shared (chronicle is world-isolated
 *  through the character, hence keyed on DEFAULT_PLAYER_ID). */
function chronicleForPrompt(characterId: string) {
  const row = chroniclesRepo.getByCharacter(characterId, DEFAULT_PLAYER_ID);
  return row ? { chronicle: row.chronicle, recentLines: row.recentLines } : null;
}

/**
 * Generate the day's queued text for every ENGAGED, available character in a
 * world. Server-decided cadence: each dated character has only a CHANCE of ONE
 * text per day, scheduled to morning/evening/night (never afternoon). Long-
 * neglected characters text even more rarely. Gifts are a separate, much-rarer
 * warmth-weighted roll. Deterministic per (world, day, character) so it is
 * idempotent/replay-safe; `rng` is injectable for tests.
 */
export async function generateDailyTextsForDay(
  worldId: string,
  day: number,
  playerId: string = DEFAULT_PLAYER_ID,
  rng: SeededRandom = hashFloat,
): Promise<void> {
  const settings = getLlmSettings();
  const player = getOrCreatePlayer(playerIdForWorldOrDefault(worldId));
  const playerName = player.name;
  const giftable = shopItemsRepo
    .list()
    .filter((i) => (GIFTABLE_RARITIES as readonly string[]).includes(i.rarity))
    .map((i) => ({ id: i.id, name: i.name }));
  const giftableIds = new Set(giftable.map((g) => g.id));
  // Compute availability once for the whole world (avoids an O(n^2) rehash).
  const availableIds = new Set(
    getWorldAvailability(worldId, day).filter((a) => a.available).map((a) => a.characterId),
  );

  for (const character of charactersRepo.listByWorld(worldId)) {
    // Only characters you've DATED can text you.
    if (!hasDated(character.id)) continue;

    const rel = ensureRelationship(character.id, playerId);

    // A character who's busy today doesn't text — not even a pending turning
    // point. The beat:pending flag persists, so it lands on the next day they're
    // free (and a memorialized/dead character, who is never available, never
    // texts at all).
    if (!availableIds.has(character.id)) continue;

    // A queued relationship turning point (warning / breakup / reconcile) takes
    // priority over the normal cadence and is delivered regardless of the daily
    // chance roll (but still only when they're available, gated just above).
    const beatFlag = rel.flags['beat:pending'];
    if (beatFlag === 'rocks' || beatFlag === 'breakup' || beatFlag === 'reconcile' || beatFlag === 'orientation') {
      await deliverRelationshipBeat(worldId, day, character, rel, beatFlag, settings, playerName, rng);
      continue;
    }

    // A broken-up character goes cold — no normal daily texts until reconciled.
    if (isBrokenUp(rel)) continue;

    const lastSeen = rel.flags[LAST_SEEN_FLAG];
    const daysSinceSeen = typeof lastSeen === 'number' ? Math.max(0, day - lastSeen) : 0;
    const isForlorn = daysSinceSeen >= FORLORN_NEGLECT_DAYS;

    // CADENCE GATE: only a chance of a text on any given day (most days: none).
    const chance = isForlorn ? FORLORN_TEXT_CHANCE : DAILY_TEXT_CHANCE;
    if (rng(`text|${worldId}|${day}|${character.id}`) >= chance) continue;

    // Idempotency: never queue a second text for this character on this day,
    // even if generation is re-fired (dev route, re-run).
    const thread = getOrCreateThread(character.id, playerId);
    const alreadyTexted = textMessagesRepo
      .listAllByThread(thread.id)
      .some((m) => m.sender === 'character' && m.dayNumber === day);
    if (alreadyTexted) continue;

    // The SERVER picks the phase (morning/evening/night) — never afternoon.
    const phase =
      DAILY_TEXT_PHASES[Math.min(DAILY_TEXT_PHASES.length - 1, Math.floor(rng(`textphase|${worldId}|${day}|${character.id}`) * DAILY_TEXT_PHASES.length))]!;

    // A freshly-crossed relationship milestone colors today's text once.
    const pendingMilestone = rel.flags['milestone:pendingText'];
    // Don't deliver a glowing "we just grew closer" text on a strained day — leave it
    // pending until the strain resolves (reconcile clears state:onTheRocks). The daily-
    // text surface has no other access to the state:* flags the date prompt reads.
    const strained =
      rel.flags['state:onTheRocks'] === true || rel.flags['state:jealous'] === true || rel.flags['state:offended'] === true;
    const recentMilestone = typeof pendingMilestone === 'string' && pendingMilestone && !strained ? pendingMilestone : null;

    const result = await callStructuredLlm(
      DailyTextPlanSchema,
      buildDailyTextPlanMessages({
        character,
        relationship: rel,
        daysSinceSeen,
        giftable,
        playerName,
        playerGender: player.gender,
        recentTexts: getRecentTexts(character.id, 6, playerId),
        chronicle: chronicleForPrompt(character.id),
        recentMilestone,
        memories: topMemoriesFor(character.id),
        worldDay: day,
        npcPartnerNames: currentNpcPartners(character).map((p) => p.name),
      }),
      { settings, task: `Write ${character.name}'s text for the day.`, schemaName: 'DailyTextPlan' },
    );
    if (!result.ok) {
      recordEvent('daily_texts_failed', { characterId: character.id, error: result.error });
      continue; // keep the pending milestone so it can color a future day's text
    }
    // Consume the milestone now that it has shaped a successful text.
    if (recentMilestone) setRelationshipFlag(character.id, 'milestone:pendingText', '', { source: 'milestone' });

    const t = result.data.texts[0]!;

    // GIFT: a separate, much-rarer roll weighted by relationship warmth. The LLM
    // may SUGGEST an item, but the SERVER decides whether a gift is attached.
    const wantsGift = rng(`gift|${worldId}|${day}|${character.id}`) < giftChance(rel);
    const attachment =
      wantsGift && t.attachShopItemId && giftableIds.has(t.attachShopItemId)
        ? { shopItemId: t.attachShopItemId, name: shopItemsRepo.get(t.attachShopItemId)?.name ?? 'a gift', claimed: false }
        : null;

    // Re-check the idempotency guard AFTER the await: a concurrent pass (e.g. the
    // day-start hook overlapping the dev route) could have queued today's text
    // while we were waiting on the model. This re-check + the synchronous insert
    // below have no suspension point between them, so they can't interleave.
    const nowTexted = textMessagesRepo
      .listAllByThread(thread.id)
      .some((m) => m.sender === 'character' && m.dayNumber === day);
    if (nowTexted) continue;

    const now = Date.now();
    textMessagesRepo.insert(
      TextMessageSchema.parse({
        id: newId('txt'),
        threadId: thread.id,
        sender: 'character',
        body: t.body,
        status: 'queued',
        dayNumber: day,
        scheduledPhase: phase, // server-chosen; LLM's t.phase is ignored
        attachment,
        deliveredAt: null,
        createdAt: now,
      }),
    );
    recordEvent('daily_texts_generated', { characterId: character.id, day, phase, gift: !!attachment });
  }
}
