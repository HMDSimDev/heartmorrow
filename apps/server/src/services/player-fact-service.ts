import {
  PlayerFactExtractionSchema,
  NpcKnowledgeSchema,
  PLAYER_GOSSIP,
  currentStatus,
  warmthBand,
  bandIndex,
  type Character,
  type Message,
  type ConversationSession,
  type Relationship,
} from '@dsim/shared';
import { npcKnowledgeRepo, eventsRepo } from '../db/repositories';
import { getRelationship } from './relationship-service';
import { getOrCreatePlayer } from './player-service';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import { buildPlayerFactMessages } from '../prompt/prompt-builder';
import { recordEvent } from './event-service';
import { newId, playerIdForWorldOrDefault } from '../lib/ids';

/**
 * Player-fact capture: when you're actually seeing someone, the concrete things YOU
 * said about yourself on a date become that partner's FIRST-HAND knowledge of you
 * (player-subject `npc_knowledge`, `sourceKnowerId: null`). From there the world-sim's
 * gossip propagation carries it across their social web ("Mara's seeing someone — a
 * chef, apparently"), so a friend you later meet can recognize you. Written to the
 * DERIVED knowledge table, never the authored player row; wiped by reset.
 *
 * Unlike ex-canonization the SOURCE is the PLAYER's own lines — you describing
 * yourself is not an injection risk — but `sourceQuote` is still verified verbatim,
 * categories are a fixed low-sensitivity set, and a denylist + caps bound it.
 */
export const PLAYER_FACT = { llmTimeoutMs: 20000 } as const;

// Model-INDEPENDENT safety backstop, mirroring ex-canon: never store anything
// touching crime/violence/medical/sexual/demeaning content, whatever the model returned.
const DENYLIST =
  /\b(kill|killed|murder|assault|rape|abus|stalk|stole|steal|theft|fraud|arrest|prison|jail|cancer|hiv|aids|std|sti|overdose|suicid|self[- ]?harm|diagnos|disorder|depress|anorexi|bulimi|addict|slut|whore|retard)\w*/i;

/** Only capture once you're actually involved — dating+ OR into the romantic bands —
 *  so a single awkward first chat doesn't seed gossip about you. */
function isInvolved(rel: Relationship): boolean {
  if (currentStatus(rel) !== 'none') return true;
  return bandIndex(warmthBand(rel)) >= bandIndex('getting-close');
}

/**
 * Extraction hook (called from endSession, alongside ex-canon). Gated so it usually
 * does zero LLM: only on a date/event, only once you're involved, idempotent per
 * session, and only when the partner isn't already holding their fact quota about you.
 */
export async function maybeExtractPlayerFacts(
  session: ConversationSession,
  messages: Message[],
  partner: Character,
  day: number,
): Promise<void> {
  if (!partner.worldId) return;
  if (session.mode !== 'date' && session.mode !== 'event') return;

  const rel = getRelationship(partner.id);
  if (!isInvolved(rel)) return;

  // Idempotent per session.
  const already = eventsRepo
    .listByCharacter(partner.id, 100)
    .some((e) => e.type === 'player_facts_extracted' && (e.payload as Record<string, unknown>).sessionId === session.id);
  if (already) return;

  // Source = the PLAYER's own lines (describing themselves is legitimate, not injection).
  const playerLines = messages.filter((m) => m.role === 'player').map((m) => m.text);
  if (playerLines.length === 0) return;

  const playerId = playerIdForWorldOrDefault(partner.worldId);
  const firstHand = npcKnowledgeRepo
    .listByKnower(partner.id)
    .filter((k) => k.subjectId === playerId && k.sourceKnowerId == null);

  // Seed the "you two are seeing each other" fact once dating — deterministic, no LLM,
  // so it can travel even on a date where nothing quotable about yourself came up.
  seedSeeingFact(partner, playerId, day);

  // Lifetime cap of first-hand facts: stop extracting, but still record idempotency
  // below would be skipped — so just return (a future date can still seed once room frees).
  if (firstHand.length >= PLAYER_GOSSIP.maxFactsPerPartner) return;

  const player = getOrCreatePlayer(playerId);
  const result = await callStructuredLlm(PlayerFactExtractionSchema, buildPlayerFactMessages(player.name, playerLines), {
    settings: getLlmSettings(),
    task: 'Extract concrete facts the PLAYER stated about themselves (conservative).',
    schemaName: 'PlayerFactExtraction',
    maxRetries: 1,
    signal: AbortSignal.timeout(PLAYER_FACT.llmTimeoutMs),
  });
  recordEvent('player_facts_extracted', { sessionId: session.id, characterId: partner.id, ok: result.ok });
  if (!result.ok) return;

  const held = new Set(firstHand.map((k) => `${k.topic}|${k.claim}`));
  let written = 0;
  for (const fact of result.data.facts) {
    if (written >= PLAYER_GOSSIP.maxFactsPerDate) break;
    if (firstHand.length + written >= PLAYER_GOSSIP.maxFactsPerPartner) break;

    // The quote MUST be a verbatim substring of a real PLAYER-spoken line.
    const quote = fact.sourceQuote.trim();
    if (!quote || !playerLines.some((line) => line.includes(quote))) {
      recordEvent('player_fact_quote_unverified', { characterId: partner.id });
      continue;
    }
    if (DENYLIST.test(fact.value)) {
      recordEvent('player_fact_denied', { characterId: partner.id, category: fact.category });
      continue;
    }
    const claim = `${player.name} ${fact.value}`.replace(/\s+/g, ' ').trim().slice(0, 160);
    const key = `${fact.category}|${claim}`;
    if (held.has(key)) continue;
    held.add(key);

    npcKnowledgeRepo.insert(
      NpcKnowledgeSchema.parse({
        id: newId('know'),
        worldId: partner.worldId,
        knowerId: partner.id,
        subjectId: playerId,
        topic: fact.category,
        claim,
        fidelity: 100,
        hops: 0,
        sourceKnowerId: null, // first-hand: learned straight from the player
        day,
        createdAt: Date.now(),
      }),
    );
    recordEvent('player_fact_learned', { characterId: partner.id, category: fact.category, day });
    written += 1;
  }
}

/** Seed "you and the partner have been seeing each other" once you're at least dating,
 *  so word that you're taken can spread even with nothing else quotable. Deduped by the
 *  knowledge UNIQUE constraint; subject is the player, attribution first-hand. */
function seedSeeingFact(partner: Character, playerId: string, day: number): void {
  if (!partner.worldId) return;
  const rel = getRelationship(partner.id);
  if (currentStatus(rel) === 'none') return;
  const player = getOrCreatePlayer(playerId);
  const claim = `${player.name} and ${partner.name} have been seeing each other`;
  const exists = npcKnowledgeRepo
    .listByKnower(partner.id)
    .some((k) => k.subjectId === playerId && k.topic === 'seeing' && k.claim === claim);
  if (exists) return;
  npcKnowledgeRepo.insert(
    NpcKnowledgeSchema.parse({
      id: newId('know'),
      worldId: partner.worldId,
      knowerId: partner.id,
      subjectId: playerId,
      topic: 'seeing',
      claim,
      fidelity: 100,
      hops: 0,
      sourceKnowerId: null,
      day,
      createdAt: Date.now(),
    }),
  );
}
