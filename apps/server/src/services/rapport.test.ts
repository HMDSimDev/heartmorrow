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
  getActiveDateForWorld,
  judgeTurn,
  maybeLeaveForLostInterest,
  recordTurnReaction,
} from './conversation-service';
import {
  getRapport,
  applyTurnEngagement,
  ensureRapportSeeded,
  hasJudgedTurn,
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

describe('resume: getActiveDateForWorld carries the live rapport + mood', () => {
  it('returns the judged rapport, vibe, and expression so a resumed date restores them', async () => {
    const { world, session } = startDate();
    setAdapterOverride(reply({ engagement: 3, expression: 'smiling', note: 'really landed' }));
    await judgeTurn(session.id);

    const active = getActiveDateForWorld(world.id);
    expect(active).not.toBeNull();
    expect(active!.sessionId).toBe(session.id);
    const expected = START + turnRapportDelta(3, { guardedness: G });
    expect(active!.rapport).toBe(expected); // the bar survives (not the empty seam)
    expect(active!.vibe).toBe(rapportLabel(expected));
    expect(active!.expression).toBe('smiling'); // the mood survives — restored on resume
  });

  it('before any judged turn there is no live read (empty bar + no mood is honest)', () => {
    const { world } = startDate();
    const active = getActiveDateForWorld(world.id);
    expect(active).not.toBeNull();
    expect(active!.rapport).toBeNull();
    expect(active!.vibe).toBeNull();
    expect(active!.expression).toBeNull();
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

  it('difficulty shifts how the same final rapport GRADES — one ladder, read kinder or meaner', () => {
    expect(rapportEndEffect(44, 'gentle')).toEqual({}); // 44 grades flat on normal, neutral on gentle
    expect(rapportEndEffect(44).comfort ?? 0).toBeLessThan(0);
    expect(rapportEndEffect(80, 'gentle').affection).toBeGreaterThan(rapportEndEffect(80).affection ?? 0);
    expect(rapportEndEffect(50, 'harsh').comfort ?? 0).toBeLessThan(0); // a mid date reads a shade flat on harsh
    expect(rapportEndEffect(50, 'gentle')).toEqual({}); // …but gentle never inflates the neutral midpoint into a win
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

  it('difficulty moves the lose-interest floor: harsh patience runs out sooner, gentle later', () => {
    const { session } = startDate();
    // Drive an open-char rapport to 18 (50 → 26 → 18): between the harsh (20) and normal (14) floors.
    applyTurnEngagement(session.id, -3);
    applyTurnEngagement(session.id, -1);
    expect(getRapport(session.id)).toBe(18);
    expect(hasLostInterest(session.id)).toBe(false);
    expect(hasLostInterest(session.id, 'harsh')).toBe(true);
    expect(hasLostInterest(session.id, 'gentle')).toBe(false);

    applyTurnEngagement(session.id, -1); // 10: below normal (14), still above gentle (8)
    expect(hasLostInterest(session.id)).toBe(true);
    expect(hasLostInterest(session.id, 'gentle')).toBe(false);

    applyTurnEngagement(session.id, -1); // 2: even gentle patience is spent
    expect(hasLostInterest(session.id, 'gentle')).toBe(true);
  });
});

describe('difficulty threads through the live judge and the end-of-sitting evaluation', () => {
  it('the per-turn judge moves rapport by the difficulty-scaled step', async () => {
    updateLlmSettings({ difficulty: 'harsh' });
    const { session } = startDate();
    setAdapterOverride(reply({ engagement: 2, expression: 'smiling', note: 'landed' }));

    const readout = await judgeTurn(session.id);
    const expected = turnRapportDelta(2, { guardedness: G, difficulty: 'harsh' });
    expect(readout!.delta).toBe(expected);
    expect(expected).toBeLessThanOrEqual(turnRapportDelta(2, { guardedness: G }));
    expect(getRapport(session.id)).toBe(START + expected);
  });

  it("an UNJUDGED date's rapport consequence ignores difficulty (harsh can't drag a neutral 50 into a penalty)", async () => {
    updateLlmSettings({ difficulty: 'harsh' });
    const { character, session } = startDate();
    applyRelationshipChange(character.id, { comfort: 50 }, { source: 'test' });

    const before = getRelationship(character.id);
    setAdapterOverride(
      reply({ mood: 'fine', expression: 'neutral', relationshipDeltas: {}, memoryCandidates: [], summaryLine: 'A quiet evening.' }),
    );
    const res = await endSession(session.id);
    expect(res.evaluated).toBe(true);
    // No turn was ever judged → the default 50 grades on the NORMAL ladder → neutral band → no change.
    expect(getRelationship(character.id).comfort).toBe(before.comfort);
  });

  it('a JUDGED date at the midpoint grades a shade flat on harsh', async () => {
    updateLlmSettings({ difficulty: 'harsh' });
    const { character, session } = startDate();
    applyRelationshipChange(character.id, { comfort: 50, tension: 5 }, { source: 'test' });
    // A judged turn that holds the open-char midpoint exactly (engagement 0 → delta 0).
    applyTurnEngagement(session.id, 0);
    expect(getRapport(session.id)).toBe(50);

    const before = getRelationship(character.id);
    setAdapterOverride(
      reply({ mood: 'flat', expression: 'neutral', relationshipDeltas: {}, memoryCandidates: [], summaryLine: 'A flat evening.' }),
    );
    await endSession(session.id);
    const after = getRelationship(character.id);
    expect(after.comfort).toBeLessThan(before.comfort); // 50 − 4 grades in the flat band
    expect(after.tension).toBeGreaterThan(before.tension);
  });

  it("gentle scales the evaluator's applied deltas harm-aware (a hangout, where no other effect interferes)", async () => {
    updateLlmSettings({ difficulty: 'gentle' });
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'hangout', locationId: null });
    addPlayerMessage(session.id, 'Rough afternoon, honestly.');
    applyRelationshipChange(character.id, { affection: 50, tension: 5 }, { source: 'test' });
    const before = getRelationship(character.id);

    setAdapterOverride(
      reply({
        mood: 'stung',
        expression: 'sad',
        relationshipDeltas: { affection: -2, tension: 3 },
        memoryCandidates: [],
        summaryLine: 'An afternoon that went sideways.',
      }),
    );
    const res = await endSession(session.id);
    expect(res.evaluated).toBe(true);
    const after = getRelationship(character.id);
    expect(after.affection).toBe(before.affection - 1); // −2 softened to −1
    expect(after.tension).toBe(before.tension + 2); // a tension RISE is harm → 3 softened to +2, never amplified
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

describe('line of the night', () => {
  it('the recap carries the best judged line, clipped verbatim when long', async () => {
    const { session } = startDate();
    const dull = addPlayerMessage(session.id, 'ok.');
    const longText =
      'I kept thinking about the way the light hits the harbor when you laugh. '.repeat(6).trim();
    const star = addPlayerMessage(session.id, longText);
    recordTurnReaction(dull.id, 0);
    recordTurnReaction(star.id, 3);

    setAdapterOverride(
      reply({ mood: 'warm', expression: 'smiling', relationshipDeltas: {}, memoryCandidates: [], summaryLine: 'A good night.' }),
    );
    const res = await endSession(session.id);

    expect(res.evaluated).toBe(true);
    expect(res.bestLine).not.toBeNull();
    expect(res.bestLine!.engagement).toBe(3);
    // >240 chars: excerpted (the scripted adapter can't produce a valid excerpt,
    // so the deterministic sentence clip kicks in — always the player's words).
    expect(res.bestLine!.excerpted).toBe(true);
    expect(res.bestLine!.text.length).toBeLessThanOrEqual(241);
    expect(longText.startsWith(res.bestLine!.text.replace(/…$/, ''))).toBe(true);
  });

  it('no judged lines -> no keepsake (never invents a reaction)', async () => {
    const { session } = startDate();
    setAdapterOverride(
      reply({ mood: 'flat', expression: 'neutral', relationshipDeltas: {}, memoryCandidates: [], summaryLine: 'Quiet.' }),
    );
    const res = await endSession(session.id);
    expect(res.evaluated).toBe(true);
    expect(res.bestLine).toBeNull();
  });
});

describe('vibe gating (seed vs judged)', () => {
  it('a seeded-but-unjudged date exposes no vibe; the first judged turn reveals it', () => {
    const { world, session } = startDate();

    // Seeding alone — exactly what a failed first reply leaves behind — must not
    // surface the guarded opening temperature as a verdict on the date: the
    // active-date read reports NO rapport and NO vibe until a turn is judged.
    ensureRapportSeeded(session.id, G);
    expect(hasJudgedTurn(session.id)).toBe(false);
    let ad = getActiveDateForWorld(world.id)!;
    expect(ad.sessionId).toBe(session.id);
    expect(ad.rapport).toBeNull();
    expect(ad.vibe).toBeNull();

    // One judged turn flips it on.
    applyTurnEngagement(session.id, 2, G);
    expect(hasJudgedTurn(session.id)).toBe(true);
    ad = getActiveDateForWorld(world.id)!;
    expect(ad.rapport).toBe(getRapport(session.id));
    expect(ad.vibe).toBe(rapportLabel(getRapport(session.id)));
  });
});
