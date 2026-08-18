import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { sessionsRepo } from '../db/repositories';
import { getRelationship } from './relationship-service';
import { listMemories } from './memory-service';
import { hasDated } from './text-message-service';
import { attemptDtr } from './dtr-service';
import { giveGiftOnDate } from './gift-service';
import { getWorldState } from './world-clock-service';
import { buildEvaluatorMessages } from '../prompt/prompt-builder';
import {
  addPlayerMessage,
  attemptPlayerFarewell,
  attemptWalkout,
  buildPromptContextForSession,
  createSession,
  endSession,
  getActiveDateForWorld,
  judgeTurn,
  maybeLeaveForLostInterest,
  previewSessionPrompt,
} from './conversation-service';

const evalReply = (deltas: object, memories: object[] = []) =>
  new ScriptedAdapter([
    JSON.stringify({
      mood: 'easy',
      expression: 'smiling',
      relationshipDeltas: deltas,
      memoryCandidates: memories,
      summaryLine: 'A quiet afternoon.',
    }),
  ]);

/** A hangout with one player turn, ready to be ended. */
function startHangout() {
  const { world, character } = seedWorldAndCharacter();
  const session = createSession({ characterId: character.id, mode: 'hangout', locationId: null });
  addPlayerMessage(session.id, 'Thanks for coming out, this was nice.');
  return { world, character, session };
}

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('hangouts: no date machinery', () => {
  it('never judges a turn, never walks out, and never says a scripted goodnight', async () => {
    const { session } = startHangout();
    // A scripted response is queued for each — if any of them actually called the
    // model, these would return a verdict instead of null.
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ engagement: -3, expression: 'angry', note: 'brutal' })]));

    expect(await judgeTurn(session.id)).toBeNull();
    expect(await attemptWalkout(session.id, 'you are boring me')).toBeNull();
    expect(await attemptPlayerFarewell(session.id, 'I should get going')).toBeNull();
    expect(await maybeLeaveForLostInterest(session.id)).toBeNull();
  });

  it('has no rapport or vibe on the resumed session (there is nothing judging it)', () => {
    const { world, session } = startHangout();
    const active = getActiveDateForWorld(world.id);
    expect(active?.sessionId).toBe(session.id);
    expect(active?.mode).toBe('hangout');
    expect(active?.rapport).toBeNull();
    expect(active?.vibe).toBeNull();
  });

  it('refuses date-only relationship actions such as DTR and in-scene gifts', async () => {
    const { session } = startHangout();
    setAdapterOverride(new ScriptedAdapter([JSON.stringify({ decision: 'accept', line: 'Yes!', reason: 'ready' })]));
    await expect(attemptDtr(session.id)).rejects.toThrow(/real date, not a hangout/i);
    await expect(giveGiftOnDate(session.id, 'missing-item')).rejects.toThrow(/real date, not a hangout/i);
  });

  it('holds the world lock: you cannot stack a date on top of a hangout', () => {
    const { character } = startHangout();
    expect(() => createSession({ characterId: character.id, mode: 'date', locationId: null })).toThrow(
      /hanging out with/i,
    );
  });
});

describe('hangouts: what they DO cost and change', () => {
  it('spends the day action at the end (but no money) and stamps the meeting', async () => {
    const { world, session } = startHangout();
    const before = getWorldState(world.id)!.stamina;
    setAdapterOverride(evalReply({ comfort: 2 }));

    const res = await endSession(session.id);
    expect(res.evaluated).toBe(true);
    expect(getWorldState(world.id)!.stamina).toBeLessThan(before);
  });

  it('applies the evaluator deltas — being an asshole raises tension and lowers the rest', async () => {
    const { character, session } = startHangout();
    const before = getRelationship(character.id);
    setAdapterOverride(evalReply({ tension: 8, affection: -4, comfort: -5, trust: -3 }));

    await endSession(session.id);
    const after = getRelationship(character.id);
    expect(after.tension).toBeGreaterThan(before.tension);
    expect(after.affection).toBeLessThan(before.affection);
    expect(after.comfort).toBeLessThan(before.comfort);
    expect(after.trust).toBeLessThan(before.trust);
  });

  it('writes memories stamped as coming from a hangout', async () => {
    const { character, session } = startHangout();
    setAdapterOverride(evalReply({ comfort: 2 }, [{ text: 'We sat on the wall and split a bag of chips.', importance: 3, tags: [] }]));

    const res = await endSession(session.id);
    expect(res.memoriesWritten).toBe(1);
    const memory = listMemories(character.id)[0]!;
    expect(memory.sourceMode).toBe('hangout');
    expect(memory.sourceEventId).not.toBeNull();
  });

  it('counts as having met them, so texting unlocks', async () => {
    const { character, session } = startHangout();
    setAdapterOverride(evalReply({}));
    await endSession(session.id);
    expect(hasDated(character.id)).toBe(true);
  });

  it('an unspoken hangout is discarded entirely, exactly like an unspoken date', async () => {
    const { world, character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'hangout', locationId: null });
    const before = getWorldState(world.id)!.stamina;

    const res = await endSession(session.id);
    expect(res.evaluated).toBe(false);
    expect(res.evalError).toMatch(/hangout doesn't count/i);
    expect(sessionsRepo.get(session.id)).toBeUndefined();
    expect(getWorldState(world.id)!.stamina).toBe(before); // nothing spent
    expect(hasDated(character.id)).toBe(false);
  });
});

describe('hangouts: prompt framing', () => {
  it('tells the character this is not a date, and drops the date-only reads', () => {
    const { session } = startHangout();
    const { system } = previewSessionPrompt(session.id);
    expect(system).toContain('THIS IS A HANGOUT, NOT A DATE');
    expect(system).toContain('Mode: hangout');
    // The hidden "what they want tonight" read is a date mechanic.
    expect(system).not.toContain('WHAT YOU WANT TONIGHT');
  });

  it('evaluates with the hangout guardrails, not the date ones', () => {
    const { session } = startHangout();
    const ctx = buildPromptContextForSession(sessionsRepo.get(session.id)!, []);
    const system = String(buildEvaluatorMessages(ctx)[0]!.content);
    expect(system).toContain('evaluating a dating-sim HANGOUT');
    // The date evaluator defers flow to the live rapport; the hangout one must not,
    // because no rapport ran.
    expect(system).not.toContain('ALREADY scored separately by the live rapport');
  });
});
