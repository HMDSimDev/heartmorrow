import {
  GossipTextSchema,
  TextMessageSchema,
  CHARACTER_LINK_LABELS,
  DEFAULT_PLAYER_ID,
  KNOWLEDGE_GOSSIP_CHANCE,
  KNOWLEDGE_GOSSIP_MIN_FIDELITY,
  KNOWLEDGE_GOSSIP_MAX_PER_DAY,
  linkTo,
} from '@dsim/shared';
import { charactersRepo, eventsRepo, npcKnowledgeRepo, textMessagesRepo } from '../db/repositories';
import { getOrCreateThread, hasDated } from './text-message-service';
import { getOrCreatePlayer } from './player-service';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import { buildGossipTextMessages, buildKnowledgeGossipMessages } from '../prompt/prompt-builder';
import { newId, playerIdForWorldOrDefault } from '../lib/ids';
import { hashFloat, type SeededRandom } from '../lib/seeded-random';
import { recordEvent } from './event-service';

/** Which notable events become gossip-worthy "news", and how a gossiper frames it. */
const GOSSIP_NEWS: Record<string, string> = {
  milestone_reached: 'have been getting closer',
  dtr_accepted: 'made things official',
};

/**
 * At day start, characters in the social web text the player about NOTABLE news
 * from yesterday (a milestone or a new commitment with someone they're linked to).
 * The gossiper must be someone the player has actually dated (so they can text),
 * and must have a graph link to the subject. Sentiment is shaped by the link kind
 * (friend = happy, ex = bitter, rival = catty …). One gossip text per (gossiper,
 * source event); idempotent so re-firing day-start never duplicates. Queued like
 * a daily text and delivered by the normal phase sweep.
 */
export async function generateGossipForDay(
  worldId: string,
  day: number,
  playerId: string = DEFAULT_PLAYER_ID,
): Promise<void> {
  const yesterday = day - 1;
  const notable = eventsRepo
    .list(300)
    .filter((e) => GOSSIP_NEWS[e.type] != null && (e.payload as Record<string, unknown>).day === yesterday);
  if (notable.length === 0) return;

  const settings = getLlmSettings();
  const playerName = getOrCreatePlayer(playerIdForWorldOrDefault(worldId)).name;
  const worldChars = charactersRepo.listByWorld(worldId);

  for (const event of notable) {
    const subjectId = String((event.payload as Record<string, unknown>).characterId ?? '');
    const subject = charactersRepo.get(subjectId);
    if (!subject || subject.worldId !== worldId) continue;

    // Gossipers: characters the player has dated who are linked to the subject.
    const gossipers = worldChars.filter(
      (g) => g.id !== subjectId && hasDated(g.id) && linkTo(g.links, subjectId) != null,
    );
    if (gossipers.length === 0) continue;

    // One gossiper per piece of news keeps the chatter low-key.
    const gossiper = gossipers[0]!;
    const link = linkTo(gossiper.links, subjectId)!;

    // Idempotency: never gossip twice about the same event from the same gossiper.
    const dup = eventsRepo
      .listByCharacter(gossiper.id, 100)
      .some((ev) => ev.type === 'gossip_text' && (ev.payload as Record<string, unknown>).sourceEventId === event.id);
    if (dup) continue;

    // "Heard about your day" lands in the evening — decided here, told to the model.
    const deliveryPhase = 'evening' as const;
    const result = await callStructuredLlm(
      GossipTextSchema,
      buildGossipTextMessages({
        gossiper,
        subjectName: subject.name,
        linkKind: CHARACTER_LINK_LABELS[link.kind].toLowerCase(),
        news: GOSSIP_NEWS[event.type]!,
        playerName,
        deliveryPhase,
      }),
      { settings, task: `Write ${gossiper.name}'s gossip text.`, schemaName: 'GossipText' },
    );
    if (!result.ok) {
      recordEvent('gossip_failed', { characterId: gossiper.id, error: result.error });
      continue;
    }

    const thread = getOrCreateThread(gossiper.id, playerId);
    const now = Date.now();
    textMessagesRepo.insert(
      TextMessageSchema.parse({
        id: newId('txt'),
        threadId: thread.id,
        sender: 'character',
        body: result.data.body,
        status: 'queued',
        dayNumber: day,
        scheduledPhase: deliveryPhase,
        attachment: null,
        deliveredAt: null,
        createdAt: now,
      }),
    );
    recordEvent('gossip_text', { characterId: gossiper.id, subjectId, link: link.kind, sourceEventId: event.id, day });
  }
}

/**
 * Pick a gossip-worthy piece of knowledge a character is carrying about ANOTHER
 * character (not the player, not themselves), fresh enough to pass on. Shared by
 * the gossip-text path here and the Faces feed. Returns null if they have nothing.
 */
export function pickGossipKnowledge(
  characterId: string,
  worldId: string,
): { subjectId: string; subjectName: string; claim: string; fidelity: number; knowledgeId: string } | null {
  for (const k of npcKnowledgeRepo.listByKnower(characterId, 16)) {
    if (!k.subjectId || k.subjectId === DEFAULT_PLAYER_ID || k.subjectId === characterId) continue;
    if (k.fidelity < KNOWLEDGE_GOSSIP_MIN_FIDELITY) continue;
    const subject = charactersRepo.get(k.subjectId);
    if (!subject || subject.worldId !== worldId) continue;
    return { subjectId: subject.id, subjectName: subject.name, claim: k.claim, fidelity: k.fidelity, knowledgeId: k.id };
  }
  return null;
}

/**
 * The phone echo of the dialogue "what you've heard lately" surface: at day start,
 * a character the player has DATED may text them a bit of neighborhood gossip drawn
 * from the world-sim knowledge graph. Cadence-gated per gossiper, capped to
 * KNOWLEDGE_GOSSIP_MAX_PER_DAY per world-day, and idempotent per (gossiper, claim)
 * so re-firing day-start never duplicates. `rng` injectable for tests.
 */
export async function generateKnowledgeGossipForDay(
  worldId: string,
  day: number,
  playerId: string = DEFAULT_PLAYER_ID,
  rng: SeededRandom = hashFloat,
): Promise<void> {
  const settings = getLlmSettings();
  const playerName = getOrCreatePlayer(playerIdForWorldOrDefault(worldId)).name;
  let queued = 0;

  const seen = (g: string, knowledgeId: string) =>
    eventsRepo
      .listByCharacter(g, 100)
      .some((e) => e.type === 'knowledge_gossip' && (e.payload as Record<string, unknown>).knowledgeId === knowledgeId);

  for (const gossiper of charactersRepo.listByWorld(worldId)) {
    if (queued >= KNOWLEDGE_GOSSIP_MAX_PER_DAY) break;
    if (!hasDated(gossiper.id)) continue; // only people you've dated can text you
    if (rng(`kgossip|${worldId}|${day}|${gossiper.id}`) >= KNOWLEDGE_GOSSIP_CHANCE) continue;

    const pick = pickGossipKnowledge(gossiper.id, worldId);
    if (!pick || seen(gossiper.id, pick.knowledgeId)) continue; // nothing new to pass along

    // Neighborhood chatter lands in the afternoon — decided here, told to the model.
    const deliveryPhase = 'afternoon' as const;
    const result = await callStructuredLlm(
      GossipTextSchema,
      buildKnowledgeGossipMessages({
        gossiper,
        subjectName: pick.subjectName,
        claim: pick.claim,
        confident: pick.fidelity >= 80,
        playerName,
        deliveryPhase,
      }),
      { settings, task: `Write ${gossiper.name}'s neighborhood-gossip text.`, schemaName: 'GossipText' },
    );
    if (!result.ok) {
      recordEvent('knowledge_gossip_failed', { characterId: gossiper.id, error: result.error });
      continue;
    }
    if (seen(gossiper.id, pick.knowledgeId)) continue; // re-check after the await (TOCTOU)

    const thread = getOrCreateThread(gossiper.id, playerId);
    textMessagesRepo.insert(
      TextMessageSchema.parse({
        id: newId('txt'),
        threadId: thread.id,
        sender: 'character',
        body: result.data.body,
        status: 'queued',
        dayNumber: day,
        scheduledPhase: deliveryPhase,
        attachment: null,
        deliveredAt: null,
        createdAt: Date.now(),
      }),
    );
    recordEvent('knowledge_gossip', {
      characterId: gossiper.id,
      subjectId: pick.subjectId,
      knowledgeId: pick.knowledgeId,
      day,
    });
    queued += 1;
  }
}
