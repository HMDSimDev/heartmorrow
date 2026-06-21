import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { addPlayerMessage, attemptPlayerFarewell, createSession, getSessionWithMessages } from './conversation-service';

const reply = (o: object) => new ScriptedAdapter([JSON.stringify(o)]);

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('player-initiated farewell (natural end of date)', () => {
  it('a genuine goodbye yields a send-off + expression and leaves the session open to evaluate', async () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'This was lovely, but I should get going.');
    setAdapterOverride(reply({ ending: true, expression: 'tender', farewellLine: 'Get home safe — I had a great time.' }));

    const farewell = await attemptPlayerFarewell(session.id, 'This was lovely, but I should get going.');
    expect(farewell).toBeTruthy();
    expect(farewell!.expression).toBe('tender');
    expect(farewell!.message.text).toMatch(/great time/i);

    // The send-off is persisted, but the date is NOT ended here — the client runs
    // the normal end-and-evaluate flow so the date is scored in full.
    const after = getSessionWithMessages(session.id);
    expect(after.session.ended).toBe(false);
    expect(after.messages.at(-1)?.text).toMatch(/great time/i);
  });

  it('a message with no farewell wording short-circuits before any LLM call', async () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'Tell me more about your trip.');
    // No adapter override: if the regex did not short-circuit, the call would throw.
    const farewell = await attemptPlayerFarewell(session.id, 'Tell me more about your trip.');
    expect(farewell).toBeNull();
  });

  it('a false positive (stepping away, not leaving) falls through to a normal reply', async () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'Hang on, I need to go to the restroom.');
    setAdapterOverride(reply({ ending: false, expression: 'neutral', farewellLine: 'Sure, take your time.' }));

    const farewell = await attemptPlayerFarewell(session.id, 'Hang on, I need to go to the restroom.');
    expect(farewell).toBeNull();
  });

  it('never fires for plain chat (only dates can end this way)', async () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'chat', locationId: null });
    addPlayerMessage(session.id, 'I should get going.');
    const farewell = await attemptPlayerFarewell(session.id, 'I should get going.');
    expect(farewell).toBeNull();
  });
});
