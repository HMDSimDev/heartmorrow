import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationSessionSchema, MessageSchema, NpcKnowledgeSchema, DEFAULT_PLAYER_ID } from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { createWorld } from './world-service';
import { createCharacter } from './character-service';
import { ensureWorldState } from './world-clock-service';
import { generateKnowledgeGossipForDay } from './gossip-service';
import { generateFeedForDay } from './feed-service';
import { sessionsRepo, messagesRepo, npcKnowledgeRepo, threadsRepo, textMessagesRepo, feedPostsRepo } from '../db/repositories';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

/** Make a character count as "dated" (a date session the player actually spoke in —
 *  a real date needs a player turn, which is also what gates `hasDated`). */
function markDated(charId: string): void {
  const s = sessionsRepo.insert(
    ConversationSessionSchema.parse({ id: `sess-${charId}`, characterId: charId, mode: 'date', createdAt: 1, updatedAt: 1 }),
  );
  messagesRepo.insert(MessageSchema.parse({ id: `m-${charId}`, sessionId: s.id, role: 'player', text: 'hi', createdAt: 2 }));
}

function giveKnowledge(worldId: string, knowerId: string, subjectId: string, claim: string, fidelity = 100): void {
  npcKnowledgeRepo.insert(
    NpcKnowledgeSchema.parse({ id: `k-${knowerId}-${subjectId}`, worldId, knowerId, subjectId, topic: 'job', claim, fidelity, hops: 0, day: 1, createdAt: 1 }),
  );
}

function characterTexts() {
  return threadsRepo
    .listByPlayer(DEFAULT_PLAYER_ID)
    .flatMap((t) => textMessagesRepo.listAllByThread(t.id))
    .filter((m) => m.sender === 'character');
}

describe('knowledge-driven gossip (Phase 6 follow-up)', () => {
  it('a dated character texts the player neighborhood gossip from their knowledge', async () => {
    const world = createWorld({ name: 'T' });
    ensureWorldState(world.id);
    const bo = createCharacter({ worldId: world.id, name: 'Bo', age: 27 });
    const ava = createCharacter({ worldId: world.id, name: 'Ava', age: 27 });
    markDated(bo.id);
    giveKnowledge(world.id, bo.id, ava.id, 'Ava works as a Botanist at The Glasshouse');
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ body: 'omg did you hear Ava got that botanist gig?? 🌿' })]));

    await generateKnowledgeGossipForDay(world.id, 2, undefined, () => 0);

    const texts = characterTexts();
    expect(texts.length).toBe(1);
    expect(texts[0]?.body).toContain('Ava');
  });

  it('does not re-text the same gossip when day-start re-fires', async () => {
    const world = createWorld({ name: 'T' });
    ensureWorldState(world.id);
    const bo = createCharacter({ worldId: world.id, name: 'Bo', age: 27 });
    const ava = createCharacter({ worldId: world.id, name: 'Ava', age: 27 });
    markDated(bo.id);
    giveKnowledge(world.id, bo.id, ava.id, 'Ava plays violin');
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ body: 'heard Ava plays violin now!' })]));

    await generateKnowledgeGossipForDay(world.id, 2, undefined, () => 0);
    await generateKnowledgeGossipForDay(world.id, 2, undefined, () => 0); // re-run

    expect(characterTexts().length).toBe(1); // idempotent per (gossiper, knowledge)
  });

  it('a character the player has not dated never gossips (cannot text you)', async () => {
    const world = createWorld({ name: 'T' });
    ensureWorldState(world.id);
    const bo = createCharacter({ worldId: world.id, name: 'Bo', age: 27 });
    const ava = createCharacter({ worldId: world.id, name: 'Ava', age: 27 });
    // Bo is NOT marked dated.
    giveKnowledge(world.id, bo.id, ava.id, 'Ava works at the café');
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ body: 'should never send' })]));

    await generateKnowledgeGossipForDay(world.id, 2, undefined, () => 0);

    expect(characterTexts().length).toBe(0);
  });

  it('an engaged character posts neighborhood news to the Faces feed', async () => {
    const world = createWorld({ name: 'T' });
    ensureWorldState(world.id);
    const bo = createCharacter({ worldId: world.id, name: 'Bo', age: 27 });
    const ava = createCharacter({ worldId: world.id, name: 'Ava', age: 27 });
    markDated(bo.id);
    giveKnowledge(world.id, bo.id, ava.id, 'Ava plays violin');
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ body: 'ran into Ava — turns out she plays violin!', mood: 'cheerful' })]));

    // Fail the ambient gate (section 2) but pass the knowledge gate (section 3) so the
    // post under test is the knowledge one, not an ordinary ambient "life" post.
    const rng = (seed: string) => (seed.includes('ambient') ? 1 : 0);
    await generateFeedForDay(world.id, 2, undefined, rng);

    const posts = feedPostsRepo.listByWorld(world.id);
    expect(posts.some((p) => p.kind === 'life' && p.authorId === bo.id && p.body.includes('Ava'))).toBe(true);
  });
});
