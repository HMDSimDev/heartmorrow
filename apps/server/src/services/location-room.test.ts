import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_DATING_STATS, ConversationSessionSchema } from '@dsim/shared';
import { resetDb, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { createWorld } from './world-service';
import { createCharacter, updateCharacter } from './character-service';
import { enterRoom, roomSay, getActiveRoom, leaveRoom } from './room-service';
import { createSession } from './conversation-service';
import { isDiscovered, stampMet } from './discovery-service';
import { updatePlayer } from './player-service';
import { setRelationshipFlag } from './stat-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { composeLocationScene } from './placement-service';
import { ensureWorldState } from './world-clock-service';
import { sessionsRepo } from '../db/repositories';
import { playerIdForWorld } from '../lib/ids';
import type { ChatAdapter, ChatRequest, ChatResult, LlmModelInfo } from '../llm/types';

/** Adapter that records the prompt sent to it (to assert what the room tells the model). */
class CapturingAdapter implements ChatAdapter {
  readonly name = 'capturing';
  last = '';
  constructor(private readonly reply: string) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.last = JSON.stringify(req.messages);
    return { content: this.reply };
  }
  async streamChat(req: ChatRequest, onDelta: (t: string) => void): Promise<ChatResult> {
    const r = await this.chat(req);
    onDelta(r.content);
    return r;
  }
  async listModels(): Promise<LlmModelInfo[]> {
    return [];
  }
}

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));
const DS = DEFAULT_DATING_STATS;

/** One scripted room turn (RoomTurn JSON). The adapter repeats its LAST response, so
 *  pass one entry per LLM call you expect (enter = 1 opener, each roomSay = 1). */
const turn = (reply: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ reply, introduced: [], playerIntroduced: false, ...extra });
const scriptRoom = (...turns: string[]) => setAdapterOverride(new ScriptedAdapter(turns));

/** A discovery world whose named regulars work the cafe on the MORNING shift, so the
 *  default (morning) block deterministically places them at 'cafe' — and the AFTERNOON
 *  block does not (they're off shift). */
function worldWithRegulars(names: string[]) {
  const w = createWorld({
    name: 'Town',
    featureFlags: { discovery: true },
    locations: [{ id: 'cafe', name: 'The Glasshouse', kind: 'cafe' }],
  });
  const chars = names.map((n) => createCharacter({ worldId: w.id, name: n, age: 28, datingStats: DS }));
  for (const c of chars) {
    updateCharacter(c.id, {
      employment: { title: 'Regular', place: 'cafe', locationId: 'cafe', shiftPhases: ['morning'], workdays: [0, 1, 2, 3, 4, 5, 6] },
    });
  }
  return { w, chars };
}

describe('location room chat (discovery)', () => {
  it('entering a location costs one action, reports who is present, and persists', async () => {
    const { w, chars } = worldWithRegulars(['Mara']);
    scriptRoom(turn('You step into the cafe.'));
    const before = ensureWorldState(w.id).stamina;
    const room = await enterRoom(w.id, 'cafe');
    expect(room.occupants.some((o) => o.characterId === chars[0]!.id)).toBe(true);
    expect(room.messages[0]?.role).toBe('room');
    expect(ensureWorldState(w.id).stamina).toBe(before - 1);
    // …and it's the world's live, resumable room now.
    expect(getActiveRoom(w.id)?.sessionId).toBe(room.sessionId);
  });

  it('resumes the same room (no re-charge) on re-entry, and leaving clears it', async () => {
    const { w } = worldWithRegulars(['Mara']);
    scriptRoom(turn('You step in.'));
    const first = await enterRoom(w.id, 'cafe');
    const stamina = ensureWorldState(w.id).stamina;

    const again = await enterRoom(w.id, 'cafe'); // resume — must NOT spend another action
    expect(again.sessionId).toBe(first.sessionId);
    expect(ensureWorldState(w.id).stamina).toBe(stamina);

    leaveRoom(w.id);
    expect(getActiveRoom(w.id)).toBeNull();
  });

  it('PINS the room to the block you entered on, even though entering advances the clock', async () => {
    const { w, chars } = worldWithRegulars(['Mara']); // Mara is a morning regular only
    scriptRoom(turn('You step in.'));
    expect(ensureWorldState(w.id).phase).toBe('morning');

    const room = await enterRoom(w.id, 'cafe');
    expect(room.phase).toBe('morning'); // pinned to the moment you walked in
    expect(room.occupants.some((o) => o.characterId === chars[0]!.id)).toBe(true); // Mara is here
    expect(ensureWorldState(w.id).phase).not.toBe('morning'); // the action advanced the clock
  });

  it('roomSay is server-truth (no client history) and persists the turn', async () => {
    const { w } = worldWithRegulars(['Mara']);
    scriptRoom(turn('You arrive.'), turn('The room hums along.'));
    await enterRoom(w.id, 'cafe');
    const after = await roomSay(w.id, 'I look around.');
    const texts = after.messages.map((m) => m.text);
    expect(texts).toContain('I look around.'); // the player turn was stored
    expect(texts).toContain('The room hums along.'); // the room's reply was stored
    expect(getActiveRoom(w.id)?.messages.length).toBe(after.messages.length); // persisted
  });

  it('unlocks a character the model flags as introduced, surfaces a meet bubble, and remembers it', async () => {
    const { w, chars } = worldWithRegulars(['Mara']);
    const mara = chars[0]!;
    scriptRoom(turn('You arrive.'), turn('She looks up. "Oh — I\'m Mara."', { introduced: [mara.id] }));
    await enterRoom(w.id, 'cafe');

    const after = await roomSay(w.id, "Hi, I'm Sam — mind if I join you?");
    expect(isDiscovered(mara.id)).toBe(true);
    expect(after.messages.some((m) => m.role === 'meet' && m.text.includes('Mara'))).toBe(true);
  });

  it("scrubs an unmet character's name from the room prose (never leak identity)", async () => {
    const { w, chars } = worldWithRegulars(['Mara']);
    const mara = chars[0]!;
    scriptRoom(turn('You arrive.'), turn('Mara keeps reading, not looking up.'));
    await enterRoom(w.id, 'cafe');

    const after = await roomSay(w.id, 'who is that by the window?');
    expect(after.messages.at(-1)?.text).not.toContain('Mara');
    expect(isDiscovered(mara.id)).toBe(false);
  });

  it('ignores introduced ids for people who are not actually present', async () => {
    const { w } = worldWithRegulars(['Mara']);
    scriptRoom(turn('You arrive.'), turn('No one by that name is here.', { introduced: ['ghost-id'] }));
    await enterRoom(w.id, 'cafe');

    const after = await roomSay(w.id, 'is Devi here?');
    expect(after.messages.some((m) => m.role === 'meet')).toBe(false);
  });

  it("withholds the PLAYER's name until they introduce themselves, then allows it", async () => {
    const { w } = worldWithRegulars(['Mara']);
    updatePlayer({ name: 'Sam' }, playerIdForWorld(w.id));
    scriptRoom(
      turn('You step in.'),
      turn('"Nice to meet you, Sam."'), // playerIntroduced:false → must be scrubbed
      turn('"Tell me more, Sam."', { playerIntroduced: true }), // player gave name → kept
    );
    await enterRoom(w.id, 'cafe');

    const before = await roomSay(w.id, 'hello there');
    expect(before.messages.at(-1)?.text).not.toContain('Sam');

    const afterName = await roomSay(w.id, "I'm Sam, by the way.");
    expect(afterName.messages.at(-1)?.text).toContain('Sam');
  });

  it("blocks starting a date while you're out at a room", async () => {
    const { w, chars } = worldWithRegulars(['Mara']);
    const mara = chars[0]!;
    stampMet(mara.id, 1, 'cafe'); // so the discovery gate lets a date even be attempted
    scriptRoom(turn('You step in.'));
    await enterRoom(w.id, 'cafe');

    expect(() => createSession({ characterId: mara.id, mode: 'date', locationId: 'cafe' })).toThrow(/around town/i);
  });

  it('instructs the opener to name people the player has already met', async () => {
    const { w, chars } = worldWithRegulars(['Mara']);
    stampMet(chars[0]!.id, 1, 'cafe'); // already known to the player
    const cap = new CapturingAdapter(turn('Mara glances up.'));
    setAdapterOverride(cap);
    await enterRoom(w.id, 'cafe');
    expect(cap.last).toContain('already met'); // roster marks them met
    expect(cap.last.toLowerCase()).toContain('met by name'); // opener tells the model to name them
  });

  it("grounds the scene: setting, time of day, and each person's role (staff vs patron)", async () => {
    const { w } = worldWithRegulars(['Mara']); // Mara works the cafe → staff, not a patron
    const cap = new CapturingAdapter(turn('You step in.'));
    setAdapterOverride(cap);
    await enterRoom(w.id, 'cafe');
    expect(cap.last).toContain('Setting:');
    expect(cap.last).toContain('Time: morning');
    expect(cap.last).toContain('working here (staff/on shift)');
  });

  it('tells the model the standing of someone the player has already met', async () => {
    const { w, chars } = worldWithRegulars(['Mara']);
    stampMet(chars[0]!.id, 1, 'cafe');
    const cap = new CapturingAdapter(turn('Mara waves.'));
    setAdapterOverride(cap);
    await enterRoom(w.id, 'cafe');
    expect(cap.last).toContain('you two are '); // warmth standing surfaced for the met person
  });

  it("surfaces an already-met person's commitment status, not just warmth", async () => {
    const { w, chars } = worldWithRegulars(['Mara']);
    const mara = chars[0]!;
    stampMet(mara.id, 1, 'cafe');
    setRelationshipFlag(mara.id, 'status', 'dating', { source: 'test' });
    const cap = new CapturingAdapter(turn('Mara smiles.'));
    setAdapterOverride(cap);
    await enterRoom(w.id, 'cafe');
    expect(cap.last).toContain("you're dating");
  });

  it('surfaces a recent memory for someone the player has already met', async () => {
    const { w, chars } = worldWithRegulars(['Mara']);
    const mara = chars[0]!;
    stampMet(mara.id, 1, 'cafe');
    addMemoriesFromEvaluation(mara.id, [{ text: 'Shared a quiet coffee by the window.', importance: 4, tags: [] }], null);
    const cap = new CapturingAdapter(turn('Mara waves.'));
    setAdapterOverride(cap);
    await enterRoom(w.id, 'cafe');
    expect(cap.last).toContain('recently: Shared a quiet coffee');
  });

  it("lets an already-met person use the player's name without a re-introduction", async () => {
    const { w, chars } = worldWithRegulars(['Mara']);
    stampMet(chars[0]!.id, 1, 'cafe'); // already met → she knows the player from before
    updatePlayer({ name: 'Sam' }, playerIdForWorld(w.id));
    scriptRoom(turn('"Hey Sam, good to see you."'));
    const room = await enterRoom(w.id, 'cafe');
    expect(room.messages[0]?.text).toContain('Sam'); // not scrubbed — a met person knows your name
  });

  it('surfaces "here together" in the prompt exactly when the scene clusters tied people', async () => {
    const { w, chars } = worldWithRegulars(['Mara', 'Devi']);
    updateCharacter(chars[0]!.id, { links: [{ targetId: chars[1]!.id, kind: 'friend' }] });
    const st = ensureWorldState(w.id);
    const clustered = composeLocationScene(w.id, st.day, st.phase, 'cafe').clusters.some((c) => c.memberIds.length >= 2);
    const cap = new CapturingAdapter(turn('You step in.'));
    setAdapterOverride(cap);
    await enterRoom(w.id, 'cafe');
    // The bracketed group list ("[id:… + id:…]") appears ONLY in the data line, so it's a
    // clean signal the cluster was passed (the phrase "Here TOGETHER" is also in the rules).
    expect(cap.last.includes('[id:')).toBe(clustered);
  });

  it('tells the model to keep the spotlight on whoever the player addresses (no pile-on)', async () => {
    const { w } = worldWithRegulars(['Mara', 'Devi']);
    const cap = new CapturingAdapter(turn('You step in.'));
    setAdapterOverride(cap);
    await enterRoom(w.id, 'cafe');
    expect(cap.last).toContain('FOCUS');
    expect(cap.last).toContain('do NOT interject');
  });

  it('tells the model that co-present people with no social tie are strangers', async () => {
    const { w } = worldWithRegulars(['Mara', 'Devi']); // both at the cafe, no tie between them
    const cap = new CapturingAdapter(turn('You step in.'));
    setAdapterOverride(cap);
    await enterRoom(w.id, 'cafe');
    expect(cap.last).toContain('stranger to the others present');
    expect(cap.last).not.toContain('knows here: id:'); // no tie listed on any roster line
  });

  it('passes the social connection (kind) so the model can color a tie', async () => {
    const { w, chars } = worldWithRegulars(['Mara', 'Devi']);
    const [mara, devi] = chars;
    updateCharacter(mara!.id, { links: [{ targetId: devi!.id, kind: 'friend' }] });
    const cap = new CapturingAdapter(turn('You step in.'));
    setAdapterOverride(cap);
    await enterRoom(w.id, 'cafe');
    expect(cap.last).toContain(`knows here: id:${devi!.id} (friend)`);
    expect(cap.last).toContain(`knows here: id:${mara!.id} (friend)`); // surfaced symmetrically
  });

  it('blocks entering a room while a date is underway', async () => {
    const { w, chars } = worldWithRegulars(['Mara']);
    const now = Date.now();
    sessionsRepo.insert(
      ConversationSessionSchema.parse({
        id: 'sess-date',
        characterId: chars[0]!.id,
        locationId: 'cafe',
        mode: 'date',
        summary: '',
        ended: false,
        createdAt: now,
        updatedAt: now,
      }),
    );
    scriptRoom(turn('You step in.'));
    await expect(enterRoom(w.id, 'cafe')).rejects.toThrow(/date/i);
  });
});
