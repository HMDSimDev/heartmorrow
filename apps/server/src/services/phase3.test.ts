import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_DATING_STATS, LAST_SEEN_FLAG } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { createCharacter, getCharacter } from './character-service';
import { getRelationship } from './relationship-service';
import { applyRelationshipChange, setRelationshipFlag, stampLastSeen } from './stat-service';
import { ensureWorldState, getWorldState } from './world-clock-service';
import { updateLlmSettings } from './settings-service';
import { addPlayerMessage, attemptWalkout, createSession, endSession, maybeRollJealousy } from './conversation-service';
import { listMemories } from './memory-service';

/** Bump a relationship into the intimacy-permissible band (warmth >= 65, low tension). */
function makeIntimate(characterId: string): void {
  applyRelationshipChange(
    characterId,
    { affection: 70, trust: 70, chemistry: 70, comfort: 70, respect: 70 },
    { source: 'test' },
  );
}

/** Bump a relationship past the jealousy floor (warmth >= 45, the "getting close" band). */
function makeClose(characterId: string): void {
  applyRelationshipChange(
    characterId,
    { affection: 45, trust: 45, chemistry: 45, comfort: 45, respect: 45 },
    { source: 'test' },
  );
}

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('walkout', () => {
  it('voices the farewell and penalizes when the model confirms (egregious message)', async () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    const before = getRelationship(character.id).affection;
    setAdapterOverride(
      new ScriptedAdapter([JSON.stringify({ walkout: true, reason: 'insulted', farewellLine: "We're done here." })]),
    );
    const out = await attemptWalkout(session.id, "fuck you, you're pathetic");
    expect(out).not.toBeNull();
    expect(out!.message.text).toBe("We're done here.");
    expect(getRelationship(character.id).affection).toBeLessThan(before);
    expect(getRelationship(character.id).flags['state:offended']).toBe(true);
  });

  it('does not even call the model for a benign message', async () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    const adapter = new ScriptedAdapter([JSON.stringify({ walkout: true, reason: 'x', farewellLine: 'bye' })]);
    setAdapterOverride(adapter);
    const out = await attemptWalkout(session.id, 'this has been a really lovely evening');
    expect(out).toBeNull();
    expect(adapter.calls).toBe(0); // cheap pre-screen rejected it without an LLM call
  });

  it('with NSFW on + an intimate relationship, a proposition is welcome (no walkout, no LLM call)', async () => {
    const { character } = seedWorldAndCharacter();
    makeIntimate(character.id);
    updateLlmSettings({ nsfwEnabled: true });
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    const adapter = new ScriptedAdapter([JSON.stringify({ walkout: true, reason: 'x', farewellLine: 'bye' })]);
    setAdapterOverride(adapter);
    const out = await attemptWalkout(session.id, 'want to come over to my place tonight?');
    expect(out).toBeNull();
    expect(adapter.calls).toBe(0); // intimacy permissible → pre-screen passes without an LLM call
  });

  it('with NSFW on but only strangers, propositioning still walks out', async () => {
    const { character } = seedWorldAndCharacter(); // default cold relationship
    updateLlmSettings({ nsfwEnabled: true });
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    setAdapterOverride(
      new ScriptedAdapter([JSON.stringify({ walkout: true, reason: 'too forward', farewellLine: 'This is too much, goodbye.' })]),
    );
    const out = await attemptWalkout(session.id, 'come over and hook up with me');
    expect(out).not.toBeNull();
    expect(getRelationship(character.id).flags['state:offended']).toBe(true);
  });

  it('hostility always walks out, even with NSFW on + an intimate relationship', async () => {
    const { character } = seedWorldAndCharacter();
    makeIntimate(character.id);
    updateLlmSettings({ nsfwEnabled: true });
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    const adapter = new ScriptedAdapter([JSON.stringify({ walkout: true, reason: 'insulted', farewellLine: "We're done." })]);
    setAdapterOverride(adapter);
    const out = await attemptWalkout(session.id, "shut up, you're pathetic");
    expect(out).not.toBeNull();
    expect(adapter.calls).toBe(1); // HOSTILE is never gated by NSFW/closeness
  });

  it('a walkout, once finalized, spends the daily action and stamps last-seen like any real date', async () => {
    const { world, character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    const before = getWorldState(world.id); // createSession ensured the clock; stamina full
    // attemptWalkout voices the farewell; the CLIENT then runs the normal end-and-
    // evaluate flow (here: endSession), which is what spends the cost — so script
    // both the walkout decision and the session-evaluation responses.
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({ walkout: true, reason: 'insulted', farewellLine: "We're done." }),
        JSON.stringify({ mood: 'upset', expression: 'neutral', relationshipDeltas: {}, memoryCandidates: [], summaryLine: 'It ended badly.' }),
      ]),
    );
    // The route persists the player's turn before screening for a walkout; do the
    // same so the finalizing eval counts this as a real (if blown-up) date.
    addPlayerMessage(session.id, "you're pathetic and stupid");
    await attemptWalkout(session.id, "you're pathetic and stupid");
    expect(getWorldState(world.id).stamina).toBe(before.stamina); // not spent yet — date still open
    await endSession(session.id);

    const after = getWorldState(world.id);
    expect(after.stamina).toBe(before.stamina - 1); // a blown-up date is not free
    expect(after.actionsToday).toBe(before.actionsToday + 1);
    expect(getRelationship(character.id).flags[LAST_SEEN_FLAG]).toBe(after.day);
    // The grievance survives its own eval — a walkout isn't "aired out" by that date.
    expect(getRelationship(character.id).flags['state:offended']).toBe(true);
  });

  it('records a durable memory + tags it as conflict so it surfaces next time', async () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    setAdapterOverride(
      new ScriptedAdapter([
        JSON.stringify({
          walkout: true,
          reason: 'insulted',
          farewellLine: "We're done here.",
          memory: 'He called me pathetic to my face, so I got up and left.',
          summaryLine: 'The date turned cruel and she walked out.',
        }),
      ]),
    );
    await attemptWalkout(session.id, "fuck you, you're pathetic");
    const memories = listMemories(character.id);
    expect(memories.some((m) => m.text.includes('pathetic'))).toBe(true);
    expect(memories.some((m) => m.tags.includes('conflict'))).toBe(true);
  });

  it('still remembers the walkout when the model omits the memory field (fallback to reason)', async () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    setAdapterOverride(
      new ScriptedAdapter([JSON.stringify({ walkout: true, reason: 'crossed a stated boundary', farewellLine: 'Goodbye.' })]),
    );
    await attemptWalkout(session.id, "you're disgusting and pathetic");
    const memories = listMemories(character.id);
    expect(memories.some((m) => m.text.includes('crossed a stated boundary'))).toBe(true);
  });
});

describe('jealousy', () => {
  it('a monogamous character can find out about other recent dates', () => {
    const { world, character } = seedWorldAndCharacter(); // monogamous by default
    const other = createCharacter({ worldId: world.id, name: 'Someone Else', age: 27, datingStats: DEFAULT_DATING_STATS });
    ensureWorldState(world.id); // day 1
    stampLastSeen(other.id, 1); // you saw the other person recently
    makeClose(character.id); // there must be a real bond for them to feel betrayed
    const before = getRelationship(character.id).affection;

    const outcome = maybeRollJealousy(getCharacter(character.id), () => 0); // rng 0 → always under threshold
    expect(outcome?.triggered).toBe(true);
    expect(getRelationship(character.id).affection).toBeLessThan(before);
    expect(getRelationship(character.id).flags['state:jealous']).toBe(true);
  });

  it('an acquaintance with no real bond does not get jealous', () => {
    const { world, character } = seedWorldAndCharacter(); // default warmth ~5, an acquaintance at most
    const other = createCharacter({ worldId: world.id, name: 'Someone Else', age: 27, datingStats: DEFAULT_DATING_STATS });
    ensureWorldState(world.id);
    stampLastSeen(other.id, 1); // you saw the other person recently
    // rng 0 would otherwise force a trigger — the closeness floor is what blocks it.
    expect(maybeRollJealousy(getCharacter(character.id), () => 0)).toBeNull();
  });

  it('polyamorous characters never get jealous', () => {
    const { world } = seedWorldAndCharacter();
    const poly = createCharacter({ worldId: world.id, name: 'Open Book', age: 29, relationshipStyle: 'polyamorous', datingStats: DEFAULT_DATING_STATS });
    const other = createCharacter({ worldId: world.id, name: 'Third', age: 25, datingStats: DEFAULT_DATING_STATS });
    ensureWorldState(world.id);
    stampLastSeen(other.id, 1);
    expect(maybeRollJealousy(getCharacter(poly.id), () => 0)).toBeNull();
  });

  it('no jealousy when you have not seen anyone else', () => {
    const { character } = seedWorldAndCharacter();
    ensureWorldState(character.worldId!);
    expect(maybeRollJealousy(getCharacter(character.id), () => 0)).toBeNull();
  });

  it('an exclusive partner catches on where a casual one would not, and is hurt more', () => {
    const { world, character } = seedWorldAndCharacter();
    const other = createCharacter({ worldId: world.id, name: 'Another', age: 26, datingStats: DEFAULT_DATING_STATS });
    ensureWorldState(world.id);
    stampLastSeen(other.id, 1);
    makeClose(character.id); // warmth past the jealousy floor; affection 50, room to fall
    setRelationshipFlag(character.id, 'status', 'exclusive', { source: 'test' });
    const before = getRelationship(character.id).affection;

    // rng 0.5: UNDER the committed probability (~0.9) but OVER the casual one (~0.35),
    // so this only triggers because commitment raises the stakes.
    const outcome = maybeRollJealousy(getCharacter(character.id), () => 0.5);
    expect(outcome?.triggered).toBe(true);
    expect(getRelationship(character.id).affection).toBe(before - 12); // committed penalty, not the -6 default
    expect(getRelationship(character.id).flags['state:jealous']).toBe(true);
  });
});
