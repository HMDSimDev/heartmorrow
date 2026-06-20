import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationSessionSchema, DEFAULT_STARTING_MONEY, MessageSchema } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { exportAll, importAll, resetProgress } from './data-service';
import { applyRelationshipChange } from './stat-service';
import { getRelationship } from './relationship-service';
import { ensureWorldState } from './world-clock-service';
import { addMoney, getOrCreatePlayer } from './player-service';
import { charactersRepo, messagesRepo, sessionsRepo, worldStatesRepo } from '../db/repositories';

beforeEach(() => resetDb());

describe('total reset', () => {
  it('wipes progress to Day 1 + starting money but keeps characters', () => {
    const { world, character } = seedWorldAndCharacter();
    applyRelationshipChange(character.id, { affection: 40 }, { source: 'test' });
    addMoney(500);
    const s = ensureWorldState(world.id);
    worldStatesRepo.update({ ...s, day: 5, stamina: 0 });

    resetProgress();

    expect(getRelationship(character.id).affection).toBe(5); // relationship recreated at default
    expect(ensureWorldState(world.id).day).toBe(1); // clock recreated at Day 1
    expect(ensureWorldState(world.id).stamina).toBe(ensureWorldState(world.id).staminaMax);
    expect(getOrCreatePlayer().money).toBe(DEFAULT_STARTING_MONEY);
    expect(charactersRepo.list().length).toBe(1); // authored content kept
  });
});

describe('export/import round-trip', () => {
  it('preserves conversation sessions and their messages', () => {
    const { character } = seedWorldAndCharacter();
    const session = sessionsRepo.insert(
      ConversationSessionSchema.parse({
        id: 'sess-1',
        characterId: character.id,
        mode: 'date',
        summary: 'A first date by the pier.',
        ended: true,
        createdAt: 1000,
        updatedAt: 2000,
      }),
    );
    messagesRepo.insert(
      MessageSchema.parse({ id: 'msg-1', sessionId: session.id, role: 'player', text: 'Hi there', createdAt: 1001 }),
    );
    messagesRepo.insert(
      MessageSchema.parse({ id: 'msg-2', sessionId: session.id, role: 'character', text: 'Lovely to see you', createdAt: 1002 }),
    );

    // A full export/import cycle clears everything then restores from the bundle.
    importAll(exportAll());

    expect(sessionsRepo.get('sess-1')?.summary).toBe('A first date by the pier.');
    const msgs = messagesRepo.listBySession('sess-1');
    expect(msgs.map((m) => m.text)).toEqual(['Hi there', 'Lovely to see you']);
  });
});
