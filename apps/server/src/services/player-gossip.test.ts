import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationSessionSchema, MessageSchema, NpcKnowledgeSchema } from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { createWorld } from './world-service';
import { createCharacter } from './character-service';
import { ensureWorldState } from './world-clock-service';
import { setRelationshipFlag, applyRelationshipChange } from './stat-service';
import { buildPromptContextForSession } from './conversation-service';
import { buildSystemPrompt } from '../prompt/prompt-builder';
import { maybeExtractPlayerFacts } from './player-fact-service';
import { npcKnowledgeRepo, sessionsRepo } from '../db/repositories';
import { playerIdForWorldOrDefault } from '../lib/ids';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('player-fact extraction (first-hand knowledge of you)', () => {
  it('captures verifiable self-facts from YOUR lines onto the partner, and seeds "seeing each other"', async () => {
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({
          facts: [
            { category: 'job', value: 'is a chef', sourceQuote: 'I am a chef' }, // quote IS in the line → kept
            { category: 'hobby', value: 'runs marathons', sourceQuote: 'I run marathons' }, // quote NOT present → dropped
          ],
        }),
      ]),
    );
    const world = createWorld({ name: 'T' });
    ensureWorldState(world.id);
    const partner = createCharacter({ worldId: world.id, name: 'Partner', age: 28 });
    setRelationshipFlag(partner.id, 'status', 'dating', { source: 'test' }); // you're actually involved

    const session = sessionsRepo.insert(
      ConversationSessionSchema.parse({ id: 's1', characterId: partner.id, mode: 'date', createdAt: 1, updatedAt: 1 }),
    );
    const messages = [
      MessageSchema.parse({
        id: 'm1',
        sessionId: 's1',
        role: 'player',
        text: 'Honestly, I am a chef at the harbor, and I sprint triathlons on weekends.',
        createdAt: 1,
      }),
    ];

    await maybeExtractPlayerFacts(session, messages, partner, 5);

    const playerId = playerIdForWorldOrDefault(world.id);
    const aboutPlayer = npcKnowledgeRepo.listByKnower(partner.id).filter((k) => k.subjectId === playerId);

    const job = aboutPlayer.find((k) => k.topic === 'job');
    expect(job?.claim).toBe('Player is a chef');
    expect(job?.sourceKnowerId).toBeNull(); // first-hand
    expect(job?.fidelity).toBe(100);
    // The unverifiable "marathons" fact was dropped (quote not in the player's line).
    expect(aboutPlayer.some((k) => /marathon/.test(k.claim))).toBe(false);
    // Dating seeds the "they're seeing each other" fact so word can spread you're taken.
    expect(aboutPlayer.some((k) => k.topic === 'seeing' && k.claim === 'Player and Partner have been seeing each other')).toBe(true);
  });

  it('does nothing when you are not yet involved (a first chat seeds no gossip)', async () => {
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ facts: [{ category: 'job', value: 'is a chef', sourceQuote: 'I am a chef' }] })]));
    const world = createWorld({ name: 'T' });
    ensureWorldState(world.id);
    const stranger = createCharacter({ worldId: world.id, name: 'Stranger', age: 30 }); // near-strangers, no status

    const session = sessionsRepo.insert(
      ConversationSessionSchema.parse({ id: 's2', characterId: stranger.id, mode: 'date', createdAt: 1, updatedAt: 1 }),
    );
    const messages = [MessageSchema.parse({ id: 'm1', sessionId: 's2', role: 'player', text: 'I am a chef.', createdAt: 1 })];

    await maybeExtractPlayerFacts(session, messages, stranger, 5);

    const playerId = playerIdForWorldOrDefault(world.id);
    expect(npcKnowledgeRepo.listByKnower(stranger.id).filter((k) => k.subjectId === playerId).length).toBe(0);
  });
});

describe('recognition surface ("wait — you\'re the one Mara mentioned?")', () => {
  function seedHeardAbout() {
    const world = createWorld({ name: 'T' });
    ensureWorldState(world.id);
    const mara = createCharacter({ worldId: world.id, name: 'Mara', age: 27 });
    const nia = createCharacter({ worldId: world.id, name: 'Nia', age: 26 });
    const playerId = playerIdForWorldOrDefault(world.id);
    // Nia heard about the player SECONDHAND through Mara…
    npcKnowledgeRepo.insert(
      NpcKnowledgeSchema.parse({
        id: 'k1', worldId: world.id, knowerId: nia.id, subjectId: playerId,
        topic: 'job', claim: 'Player is a chef', fidelity: 78, hops: 1, sourceKnowerId: mara.id, day: 2, createdAt: 1,
      }),
    );
    // …plus a FIRST-HAND fact (no teller) that must NOT surface as "word that got around".
    npcKnowledgeRepo.insert(
      NpcKnowledgeSchema.parse({
        id: 'k2', worldId: world.id, knowerId: nia.id, subjectId: playerId,
        topic: 'hobby', claim: 'Player likes jazz', fidelity: 100, hops: 0, sourceKnowerId: null, day: 2, createdAt: 1,
      }),
    );
    return { world, mara, nia };
  }

  it('surfaces secondhand word about the player (with attribution) while they barely know you', () => {
    const { nia } = seedHeardAbout();
    const session = sessionsRepo.insert(
      ConversationSessionSchema.parse({ id: 's1', characterId: nia.id, mode: 'date', createdAt: 1, updatedAt: 1 }),
    );
    const ctx = buildPromptContextForSession(session, []);

    expect(ctx.playerHeardAbout).toHaveLength(1);
    expect(ctx.playerHeardAbout[0]).toMatchObject({ tellerName: 'Mara', claim: 'Player is a chef', fidelity: 78 });
    expect(ctx.playerHeardAbout.some((h) => /jazz/.test(h.claim))).toBe(false); // first-hand excluded

    const prompt = buildSystemPrompt(ctx, '');
    expect(prompt).toContain('WORD ABOUT Player HAS REACHED YOU');
    expect(prompt).toContain('you heard this from Mara');
  });

  it('stops surfacing it once they have actually grown close to the player', () => {
    const { nia } = seedHeardAbout();
    // Push warmth into the romantic bands — they know the player directly now.
    applyRelationshipChange(nia.id, { affection: 45, trust: 45, chemistry: 45, comfort: 45, respect: 45 }, { source: 'test' });
    const session = sessionsRepo.insert(
      ConversationSessionSchema.parse({ id: 's1', characterId: nia.id, mode: 'date', createdAt: 1, updatedAt: 1 }),
    );
    const ctx = buildPromptContextForSession(session, []);
    expect(ctx.playerHeardAbout).toHaveLength(0);
  });
});
