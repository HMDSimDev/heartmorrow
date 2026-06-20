import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BREAKUP_SCAR_STEP,
  RECONCILE_COOLDOWN_DAYS,
  ROCKS_GRACE_DAYS,
  breakupThresholdFor,
  isBrokenUp,
  isOnTheRocks,
  neglectTuningFor,
} from '@dsim/shared';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { getRelationship } from './relationship-service';
import { applyRelationshipChange, setRelationshipFlag } from './stat-service';
import { evaluateRelationshipStrain } from './breakup-service';
import { addPlayerMessage, attemptPlayerBreakupIntent, confirmPlayerBreakup, createSession } from './conversation-service';
import { generateDailyTextsForDay } from './text-generation-service';
import { textMessagesRepo, threadsRepo } from '../db/repositories';

/** Fresh char starts at warmth 5; set every warmth stat to `target`. */
function setWarmth(characterId: string, target: number): void {
  applyRelationshipChange(
    characterId,
    { affection: target - 5, trust: target - 5, chemistry: target - 5, comfort: target - 5, respect: target - 5 },
    { source: 'test' },
  );
}

function commit(characterId: string, status: 'dating' | 'exclusive' | 'cohabiting'): void {
  setRelationshipFlag(characterId, 'status', status, { source: 'test' });
}

/** Make hasDated() true (a real date session with a player turn) without ending it. */
function markDated(characterId: string): void {
  const session = createSession({ characterId, mode: 'date', locationId: null });
  addPlayerMessage(session.id, 'hi');
}

const reply = (o: object) => new ScriptedAdapter([JSON.stringify(o)]);

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('endgame: strain, on-the-rocks & breakups', () => {
  it('an uncommitted relationship never breaks up (only cools off)', () => {
    const { character } = seedWorldAndCharacter(); // status none, warmth ~5
    const outcome = evaluateRelationshipStrain(character.id, { day: 1, trigger: 'date' });
    expect(outcome.kind).toBe('none');
    expect(isOnTheRocks(getRelationship(character.id))).toBe(false);
  });

  it('a bad date on a committed relationship goes on the rocks first (warning, not breakup)', () => {
    const { character } = seedWorldAndCharacter();
    commit(character.id, 'cohabiting'); // floor 46
    setWarmth(character.id, 40); // below floor, but not catastrophic (floor-12 = 34)

    const outcome = evaluateRelationshipStrain(character.id, { day: 2, trigger: 'date' });
    expect(outcome.kind).toBe('on_the_rocks');
    const rel = getRelationship(character.id);
    expect(isOnTheRocks(rel)).toBe(true);
    expect(isBrokenUp(rel)).toBe(false);
    expect(rel.flags['beat:pending']).toBe('rocks'); // a "we need to talk" text is queued
  });

  it('an on-the-rocks relationship breaks up once the grace window elapses', () => {
    const { character } = seedWorldAndCharacter();
    commit(character.id, 'cohabiting');
    setWarmth(character.id, 40);
    evaluateRelationshipStrain(character.id, { day: 2, trigger: 'date' }); // → on the rocks (since day 2)

    // Still in trouble after the grace window → breakup.
    const outcome = evaluateRelationshipStrain(character.id, { day: 2 + ROCKS_GRACE_DAYS, trigger: 'neglect' });
    expect(outcome.kind).toBe('broke_up');
    expect(outcome.fromStatus).toBe('cohabiting');
    const rel = getRelationship(character.id);
    expect(isBrokenUp(rel)).toBe(true);
    expect(rel.flags['status']).toBe('none'); // ladder reset
    expect(rel.flags['breakup:count']).toBe(1);
    expect(rel.flags['beat:pending']).toBe('breakup');
  });

  it('a catastrophic date breaks up immediately, with no warning', () => {
    const { character } = seedWorldAndCharacter();
    commit(character.id, 'cohabiting'); // floor 46, hard line 34
    setWarmth(character.id, 20); // well below the hard line → catastrophic

    const outcome = evaluateRelationshipStrain(character.id, { day: 3, trigger: 'date' });
    expect(outcome.kind).toBe('broke_up');
    expect(isBrokenUp(getRelationship(character.id))).toBe(true);
  });

  it('a dating relationship can also break up (scope: dating and up)', () => {
    const { character } = seedWorldAndCharacter();
    commit(character.id, 'dating'); // lenient floor 22, hard line 10
    setWarmth(character.id, 5); // below the hard line

    const outcome = evaluateRelationshipStrain(character.id, { day: 1, trigger: 'date' });
    expect(outcome.kind).toBe('broke_up');
  });

  it('warming back up before the grace elapses steadies the relationship', () => {
    const { character } = seedWorldAndCharacter();
    commit(character.id, 'exclusive'); // floor 34
    setWarmth(character.id, 28);
    evaluateRelationshipStrain(character.id, { day: 1, trigger: 'date' }); // on the rocks
    expect(isOnTheRocks(getRelationship(character.id))).toBe(true);

    setWarmth(character.id, 70); // patched things up
    const outcome = evaluateRelationshipStrain(character.id, { day: 2, trigger: 'date' });
    expect(outcome.kind).toBe('steadied');
    expect(isOnTheRocks(getRelationship(character.id))).toBe(false);
  });

  it('a broken-up character stays cold until the cooldown, then reconciles once warm again', () => {
    const { character } = seedWorldAndCharacter();
    // Hand-set a broken-up state on day 1.
    setRelationshipFlag(character.id, 'state:brokenUp', true, { source: 'test' });
    setRelationshipFlag(character.id, 'breakup:day', 1, { source: 'test' });
    setRelationshipFlag(character.id, 'breakup:count', 1, { source: 'test' });
    setWarmth(character.id, 60); // player kept reaching out — warmth recovered

    // Within the cooldown: still cold, no reconciliation.
    expect(evaluateRelationshipStrain(character.id, { day: 1 + RECONCILE_COOLDOWN_DAYS - 1, trigger: 'date' }).kind).toBe('none');
    expect(isBrokenUp(getRelationship(character.id))).toBe(true);

    // After the cooldown, warm enough → back together (at the base rung).
    const outcome = evaluateRelationshipStrain(character.id, { day: 1 + RECONCILE_COOLDOWN_DAYS, trigger: 'date' });
    expect(outcome.kind).toBe('reconciled');
    const rel = getRelationship(character.id);
    expect(isBrokenUp(rel)).toBe(false);
    expect(rel.flags['status']).toBe('dating');
    expect(rel.flags['breakup:count']).toBe(1); // scar persists
  });

  it('NEVER auto-reconciles on the neglect pass — only a deliberate date can (regression)', () => {
    const { character } = seedWorldAndCharacter();
    setRelationshipFlag(character.id, 'state:brokenUp', true, { source: 'test' });
    setRelationshipFlag(character.id, 'breakup:day', 1, { source: 'test' });
    setWarmth(character.id, 70); // residual warmth from the old relationship (didn't decay)

    // Day rollover well past the cooldown, but the player did NOTHING — must stay broken up.
    const neglect = evaluateRelationshipStrain(character.id, { day: 1 + RECONCILE_COOLDOWN_DAYS + 5, trigger: 'neglect' });
    expect(neglect.kind).toBe('none');
    expect(isBrokenUp(getRelationship(character.id))).toBe(true);

    // Actually going on a date (after the cooldown) is what wins them back.
    const onDate = evaluateRelationshipStrain(character.id, { day: 1 + RECONCILE_COOLDOWN_DAYS + 5, trigger: 'date' });
    expect(onDate.kind).toBe('reconciled');
  });

  it('each breakup scars the bond (thresholds stiffen)', () => {
    const first = breakupThresholdFor('exclusive', 0)!;
    const scarred = breakupThresholdFor('exclusive', 2)!;
    expect(scarred.warmthFloor).toBe(first.warmthFloor + 2 * BREAKUP_SCAR_STEP);
    expect(scarred.tensionCeil).toBeLessThan(first.tensionCeil);
    expect(breakupThresholdFor('none', 0)).toBeNull();
  });

  it('commitment scales neglect: a live-in partner drifts sooner and faster', () => {
    expect(neglectTuningFor('cohabiting').graceDays).toBeLessThan(neglectTuningFor('dating').graceDays);
    expect(neglectTuningFor('cohabiting').decayMult).toBeGreaterThan(neglectTuningFor('none').decayMult);
  });

  it('a broken-up partner cannot be dated during the cooldown', () => {
    const { character } = seedWorldAndCharacter();
    setRelationshipFlag(character.id, 'state:brokenUp', true, { source: 'test' });
    setRelationshipFlag(character.id, 'breakup:day', 1, { source: 'test' }); // day is 1 → within cooldown
    expect(() => createSession({ characterId: character.id, mode: 'date', locationId: null })).toThrow(/space/i);
  });

  it('player-initiated breakup: intent is detected but does NOT mutate until confirmed', async () => {
    const { character } = seedWorldAndCharacter();
    commit(character.id, 'exclusive');
    setWarmth(character.id, 70);
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'I think we should break up.');
    setAdapterOverride(reply({ genuine: true, reaction: 'plead', line: "Wait — please don't do this." }));

    const intent = await attemptPlayerBreakupIntent(session.id, 'I think we should break up.');
    expect(intent).toBeTruthy();
    expect(intent!.reaction).toBe('plead');
    // The reaction is shown, but nothing is applied yet — still exclusive.
    expect(isBrokenUp(getRelationship(character.id))).toBe(false);
    expect(getRelationship(character.id).flags['status']).toBe('exclusive');

    // Confirming applies the breakup (no character breakup TEXT — it was face to face).
    const res = confirmPlayerBreakup(session.id);
    expect(res.fromStatus).toBe('exclusive');
    const rel = getRelationship(character.id);
    expect(isBrokenUp(rel)).toBe(true);
    expect(rel.flags['status']).toBe('none');
    expect(rel.flags['beat:pending']).toBeUndefined();
  });

  it('player-initiated breakup: a non-genuine message (the opposite) is ignored', async () => {
    const { character } = seedWorldAndCharacter();
    commit(character.id, 'exclusive');
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, "I'd never break up with you.");
    setAdapterOverride(reply({ genuine: false, reaction: 'hurt', line: 'That means a lot to me.' }));

    const intent = await attemptPlayerBreakupIntent(session.id, "I'd never break up with you.");
    expect(intent).toBeNull(); // falls through to a normal reply
  });

  it('player-initiated breakup: cannot break up with someone you were never together with', () => {
    const { character } = seedWorldAndCharacter(); // status 'none', not broken up
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, "we're done");
    expect(() => confirmPlayerBreakup(session.id)).toThrow(/aren't together|nothing to break/i);
    expect(isBrokenUp(getRelationship(character.id))).toBe(false);
  });

  it('player-initiated breakup: cannot re-break-up during the win-them-back phase (no double-scar)', async () => {
    const { character } = seedWorldAndCharacter();
    // Already broken up once (the "try to win them back" state). breakup:day is
    // left unset so this exercises the guard in isolation — the createSession
    // cooldown gate is covered by its own test above.
    setRelationshipFlag(character.id, 'state:brokenUp', true, { source: 'test' });
    setRelationshipFlag(character.id, 'breakup:count', 1, { source: 'test' });
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, "we're done");

    // The intent step short-circuits before any LLM call — no confirm is surfaced.
    const intent = await attemptPlayerBreakupIntent(session.id, "we're done");
    expect(intent).toBeNull();

    // And confirming directly is rejected — the scar count is NOT bumped again.
    expect(() => confirmPlayerBreakup(session.id)).toThrow(/already broken up/i);
    expect(getRelationship(character.id).flags['breakup:count']).toBe(1);
  });

  it('a queued breakup text is delivered regardless of the daily cadence', async () => {
    const { world, character } = seedWorldAndCharacter();
    markDated(character.id); // so the character is contactable
    setRelationshipFlag(character.id, 'beat:pending', 'breakup', { source: 'test' });
    setAdapterOverride(reply({ body: "I've thought about this a lot, and I think we should end things." }));

    // rng forced to 0.99 so the normal cadence roll would NOT fire a text — only the beat should.
    await generateDailyTextsForDay(world.id, 1, undefined, () => 0.99);

    const thread = threadsRepo.getByCharacter(character.id, 'player-default');
    expect(thread).toBeTruthy();
    const queued = textMessagesRepo.listAllByThread(thread!.id).filter((m) => m.sender === 'character');
    expect(queued.length).toBe(1);
    expect(getRelationship(character.id).flags['beat:pending']).toBe(''); // consumed
  });
});
