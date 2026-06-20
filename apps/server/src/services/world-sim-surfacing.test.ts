import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationSessionSchema } from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { createWorld } from './world-service';
import { createCharacter } from './character-service';
import { simulateWorldDay } from './world-sim-service';
import { ensureWorldState } from './world-clock-service';
import { listMemories, addManualMemory, addLifeMemory, selectTopMemories } from './memory-service';
import { buildPromptContextForSession } from './conversation-service';
import { buildSystemPrompt } from '../prompt/prompt-builder';
import { sessionsRepo } from '../db/repositories';

const cafe = { title: 'Barista', place: 'Café Lumen', workdays: [0, 1, 2, 3, 4], shiftPhase: 'morning' as const };

beforeEach(() => {
  resetDb();
  setAdapterOverride(new ScriptedAdapter([JSON.stringify({ lines: [] })])); // color call → templated, hermetic
});
afterEach(() => setAdapterOverride(null));

describe('world-sim surfacing (Phase 6)', () => {
  it('writes an npc_life memory for each party when NPCs meet', async () => {
    const world = createWorld({ name: 'T' });
    ensureWorldState(world.id);
    const ava = createCharacter({ worldId: world.id, name: 'Ava', age: 27, employment: cafe });
    const bo = createCharacter({ worldId: world.id, name: 'Bo', age: 27, employment: cafe });

    await simulateWorldDay(world.id, 3, () => 0); // Ava ↔ Bo (coworkers) meet

    expect(listMemories(ava.id).some((m) => m.tags.includes('npc_life') && m.text.includes('Caught up with Bo'))).toBe(true);
    expect(listMemories(bo.id).some((m) => m.tags.includes('npc_life') && m.text.includes('Caught up with Ava'))).toBe(true);
    // The two parties' memories of the encounter cross-reference each other.
    expect(listMemories(ava.id).find((m) => m.text.includes('Caught up with Bo'))?.relatedCharacterId).toBe(bo.id);
    expect(listMemories(bo.id).find((m) => m.text.includes('Caught up with Ava'))?.relatedCharacterId).toBe(ava.id);
  });

  it('caps npc_life memories so they never crowd out the real history', () => {
    const world = createWorld({ name: 'T' });
    const c = createCharacter({ worldId: world.id, name: 'Cy', age: 25 });
    addManualMemory(c.id, { text: 'You two danced in the rain.', importance: 5, tags: [] });
    for (let i = 0; i < 5; i += 1) addLifeMemory(c.id, `Ran into person ${i}.`, 1);

    const top = selectTopMemories(c.id, 10);
    expect(top.filter((m) => m.tags.includes('npc_life')).length).toBe(2); // capped at 2
    expect(top.some((m) => m.text.includes('danced in the rain'))).toBe(true); // real memory survives
  });

  it('surfaces propagated news as a "what you\'ve heard lately" block in the dated character\'s prompt', async () => {
    const world = createWorld({ name: 'T' });
    ensureWorldState(world.id);
    const ava = createCharacter({ worldId: world.id, name: 'Ava', age: 27, employment: cafe });
    const bo = createCharacter({ worldId: world.id, name: 'Bo', age: 27, employment: cafe });
    const cy = createCharacter({ worldId: world.id, name: 'Cy', age: 25, links: [{ targetId: bo.id, kind: 'friend' }] });

    await simulateWorldDay(world.id, 3, () => 0); // Bo learns Ava's job (firsthand)
    await simulateWorldDay(world.id, 4, () => 0); // Cy hears about Ava from Bo (secondhand)

    const session = sessionsRepo.insert(
      ConversationSessionSchema.parse({ id: 's1', characterId: cy.id, mode: 'date', createdAt: 1, updatedAt: 1 }),
    );
    const ctx = buildPromptContextForSession(session, []);

    const aboutAva = ctx.npcKnowledge.find((k) => k.subjectName === 'Ava');
    expect(aboutAva).toBeTruthy();
    expect(aboutAva?.fidelity).toBe(75); // one hop of decay

    const prompt = buildSystemPrompt(ctx, '');
    expect(prompt).toContain("WHAT YOU'VE HEARD LATELY");
    expect(prompt).toContain('Ava');
  });
});
