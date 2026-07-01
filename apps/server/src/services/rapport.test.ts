import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RAPPORT_START, startingRapport, turnRapportDelta, rapportLabel, GUARDEDNESS_DEFAULT } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { sessionsRepo } from '../db/repositories';
import { getRelationship } from './relationship-service';
import { applyRelationshipChange } from './stat-service';
import { updateLlmSettings } from './settings-service';
import {
  addPlayerMessage,
  createSession,
  endSession,
  judgeTurn,
  maybeLeaveForLostInterest,
} from './conversation-service';
import {
  getRapport,
  applyTurnEngagement,
  rapportEndEffect,
  hasLostInterest,
} from './rapport-service';

/** Scripted single-response adapter (last response repeats for retries). */
const reply = (o: object) => new ScriptedAdapter([JSON.stringify(o)]);

/** A date with one player turn, ready to be judged. */
function startDate() {
  const { world, character } = seedWorldAndCharacter();
  const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
  addPlayerMessage(session.id, 'So, tell me about your week.');
  return { world, character, session };
}

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

// Seeded characters get the default guardedness; the judge feeds it into the math.
const G = GUARDEDNESS_DEFAULT;
const START = startingRapport(G);

describe('per-turn rapport judge', () => {
  it('a good turn raises rapport (guardedness-scaled) and reports the vibe + expression + delta', async () => {
    const { session } = startDate();
    setAdapterOverride(reply({ engagement: 3, expression: 'smiling', note: 'really landed' }));

    const readout = await judgeTurn(session.id);
    expect(readout).not.toBeNull();
    const expected = START + turnRapportDelta(3, { guardedness: G });
    expect(readout!.rapport).toBe(expected);
    expect(readout!.rapport).toBeGreaterThan(START); // it warmed
    expect(readout!.delta).toBe(turnRapportDelta(3, { guardedness: G }));
    expect(readout!.engagement).toBe(3);
    expect(readout!.label).toBe(rapportLabel(expected));
    expect(readout!.expression).toBe('smiling');
    expect(getRapport(session.id)).toBe(expected);
  });

  it('a bad turn lowers rapport and cools the vibe', async () => {
    const { session } = startDate();
    setAdapterOverride(reply({ engagement: -3, expression: 'bored', note: 'dull and self-absorbed' }));

    const readout = await judgeTurn(session.id);
    const expected = START + turnRapportDelta(-3, { guardedness: G });
    expect(readout!.rapport).toBe(expected);
    expect(readout!.rapport).toBeLessThan(START);
    expect(readout!.label).toBe(rapportLabel(expected));
  });

  it('a forgettable turn builds nothing (a guarded default character slips slightly)', async () => {
    const { session } = startDate();
    setAdapterOverride(reply({ engagement: 0, expression: 'neutral', note: 'pure filler' }));

    const readout = await judgeTurn(session.id);
    // Default guardedness is >0, so an empty turn costs a small idle drift; an OPEN
    // character (guardedness 0) would hold steady instead (see date-dynamics).
    expect(readout!.delta).toBeLessThan(0);
    expect(readout!.rapport).toBeLessThan(START);
  });

  it('fails safe: a malformed judge response applies no engagement (rests at the seeded start)', async () => {
    const { session } = startDate();
    setAdapterOverride(new ScriptedAdapter(['not json at all']));

    const readout = await judgeTurn(session.id);
    expect(readout).toBeNull();
    // The date is seeded to the character's guarded opening before judging, but a
    // failed judge applies no engagement delta on top of it.
    expect(getRapport(session.id)).toBe(START);
  });

  it('does not judge plain chat sessions', async () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'chat', locationId: null });
    addPlayerMessage(session.id, 'hey');
    setAdapterOverride(reply({ engagement: 3, expression: 'happy' }));

    expect(await judgeTurn(session.id)).toBeNull();
  });

  it("'periodic' cadence skips a short odd turn but judges the next", async () => {
    updateLlmSettings({ rapportCadence: 'periodic' });
    const { session } = startDate(); // 1 player turn (odd, short) → skipped
    setAdapterOverride(reply({ engagement: 2, expression: 'smiling' }));
    expect(await judgeTurn(session.id)).toBeNull();
    expect(getRapport(session.id)).toBe(RAPPORT_START);

    addPlayerMessage(session.id, 'That sounds rough — what happened with your sister?'); // 2nd → even → judged
    const readout = await judgeTurn(session.id);
    expect(readout).not.toBeNull();
    expect(getRapport(session.id)).toBe(START + turnRapportDelta(2, { guardedness: G }));
  });
});

describe('rapportEndEffect (end-of-date stakes)', () => {
  it('rewards a great date and punishes a bad one', () => {
    expect(rapportEndEffect(90).affection ?? 0).toBeGreaterThan(0);
    expect(rapportEndEffect(50)).toEqual({}); // narrow neutral band around the midpoint
    const bad = rapportEndEffect(15);
    expect(bad.affection ?? 0).toBeLessThan(0);
    expect(bad.tension ?? 0).toBeGreaterThan(0);
  });

  it('a flat/awkward date now nets a small negative (no wide dead zone)', () => {
    const flat = rapportEndEffect(40); // below the neutral band
    expect(flat.comfort ?? 0).toBeLessThan(0);
  });
});

describe('losing interest ends the date early', () => {
  it('a cratered rapport makes the character call it a night, with a real cost', async () => {
    const { character, session } = startDate();
    // Drive rapport to the floor (open-char start 50 → 26 → 2 → 0).
    applyTurnEngagement(session.id, -3);
    applyTurnEngagement(session.id, -3);
    applyTurnEngagement(session.id, -3);
    expect(hasLostInterest(session.id)).toBe(true);

    const beforeTension = getRelationship(character.id).tension;
    setAdapterOverride(new ScriptedAdapter(["I've had a long week — I think I'll head home. Take care."]));

    const outcome = await maybeLeaveForLostInterest(session.id);
    expect(outcome).not.toBeNull();
    expect(outcome!.reason).toBe('lost_interest');
    expect(outcome!.message.metadata).toMatchObject({ left: true });
    // The leave applies its penalty but leaves the session OPEN: the client runs the
    // normal end-and-evaluate flow next, which is what spends stamina + scores the date.
    expect(sessionsRepo.get(session.id)?.ended).toBe(false);
    expect(getRelationship(character.id).tension).toBeGreaterThan(beforeTension);
  });

  it('does not leave while rapport is healthy', async () => {
    const { session } = startDate();
    expect(hasLostInterest(session.id)).toBe(false);
    expect(await maybeLeaveForLostInterest(session.id)).toBeNull();
  });
});

describe('endSession applies the rapport consequence', () => {
  it('a low-rapport date nets negative even when the evaluator proposes nothing', async () => {
    const { character, session } = startDate();
    // A warm baseline so the penalty is visible (not clamped at 0).
    applyRelationshipChange(character.id, { affection: 50, comfort: 50, tension: 5 }, { source: 'test' });
    // Tank the date's rapport into the bad band (50 → 26 → 2).
    applyTurnEngagement(session.id, -3);
    applyTurnEngagement(session.id, -3);

    const before = getRelationship(character.id);
    setAdapterOverride(
      reply({ mood: 'flat', expression: 'neutral', relationshipDeltas: {}, memoryCandidates: [], summaryLine: 'A quiet, awkward evening.' }),
    );

    const res = await endSession(session.id);
    expect(res.evaluated).toBe(true);
    const after = getRelationship(character.id);
    expect(after.affection).toBeLessThan(before.affection);
    expect(after.tension).toBeGreaterThan(before.tension);
  });
});
