import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationSessionSchema, MessageSchema } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { sessionsRepo, messagesRepo } from '../db/repositories';
import { newId } from '../lib/ids';
import { addPlayerMessage, createSession, openConversation, previewSessionPrompt } from './conversation-service';
import { hasDated } from './text-message-service';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

/** Insert a prior, real date (a session the player actually spoke in) so the NEXT
 *  date is no longer a first meeting — without going through the date gates. */
function priorDate(characterId: string): void {
  const s = sessionsRepo.insert(
    ConversationSessionSchema.parse({ id: newId('sess'), characterId, mode: 'date', summary: '', ended: true, createdAt: 1, updatedAt: 1 }),
  );
  messagesRepo.insert(MessageSchema.parse({ id: newId('msg'), sessionId: s.id, role: 'player', text: 'hey', metadata: {}, createdAt: 2 }));
}

describe('first date: strangers meeting (the character does not know the player yet)', () => {
  it('frames the very first date as a first meeting and withholds the player name', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });

    const { system } = previewSessionPrompt(session.id);
    expect(system).toContain('MEETING FOR THE FIRST TIME');
    expect(system).toContain("you don't know their name yet");
    // The default player is named "Player" — the SCENE block must NOT reveal it.
    expect(system).not.toContain('The player is: Player');
  });

  it('drops the first-meeting framing (and reveals the name) once a real date has happened', () => {
    const { character } = seedWorldAndCharacter();
    priorDate(character.id);
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });

    const { system } = previewSessionPrompt(session.id);
    expect(system).not.toContain('MEETING FOR THE FIRST TIME');
    expect(system).toContain('The player is: Player');
  });

  it('treats a plain chat as not a first meeting', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'chat', locationId: null });
    const { system } = previewSessionPrompt(session.id);
    expect(system).not.toContain('MEETING FOR THE FIRST TIME');
  });
});

describe('first date: the character takes the first turn', () => {
  it('opens a first date with a persisted character greeting', async () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    setAdapterOverride(new ScriptedAdapter(["Oh — hi! I'm Test Character. You must be my date for tonight?"]));

    const opener = await openConversation(session.id);
    expect(opener).not.toBeNull();
    expect(opener!.role).toBe('character');
    expect(opener!.metadata.opener).toBe(true);
    expect(messagesRepo.listBySession(session.id)).toHaveLength(1);

    // An opener alone is NOT a real date — the player never spoke — so it must not
    // flip `hasDated` (which would wrongly enable texting/gossip).
    expect(hasDated(character.id)).toBe(false);
  });

  it('does not open when the player has already spoken', async () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'hi there');
    setAdapterOverride(new ScriptedAdapter(['(should not be used)']));

    expect(await openConversation(session.id)).toBeNull();
    expect(messagesRepo.listBySession(session.id)).toHaveLength(1); // still just the player turn
  });

  it('does not open a repeat date, nor a plain chat', async () => {
    const { character } = seedWorldAndCharacter();
    priorDate(character.id);
    setAdapterOverride(new ScriptedAdapter(['(should not be used)']));

    const repeat = createSession({ characterId: character.id, mode: 'date', locationId: null });
    expect(await openConversation(repeat.id)).toBeNull();

    const chat = createSession({ characterId: character.id, mode: 'chat', locationId: null });
    expect(await openConversation(chat.id)).toBeNull();
  });
});
