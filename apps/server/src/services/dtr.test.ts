import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, seedWorldAndCharacter, ScriptedAdapter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { getRelationship } from './relationship-service';
import { applyRelationshipChange } from './stat-service';
import { listMemories } from './memory-service';
import { addPlayerMessage, createSession } from './conversation-service';
import { attemptDtr } from './dtr-service';

/** Raise warmth to the given per-stat value (e.g. 50 → "getting close"). */
function makeWarm(characterId: string, to: number): void {
  applyRelationshipChange(
    characterId,
    { affection: to - 5, trust: to - 5, chemistry: to - 5, comfort: to - 5, respect: to - 5 },
    { source: 'test' },
  );
}

const reply = (o: object) => new ScriptedAdapter([JSON.stringify(o)]);

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('define-the-relationship', () => {
  it('accept advances the status flag and writes a milestone memory', async () => {
    const { character } = seedWorldAndCharacter();
    makeWarm(character.id, 50); // getting-close → "Ask them out" unlocked
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'I want to ask you something.');
    setAdapterOverride(reply({ decision: 'accept', line: "Yes — let's be a thing.", reason: 'ready' }));

    const res = await attemptDtr(session.id);
    expect(res.decision).toBe('accept');
    expect(res.status).toBe('dating');
    expect(getRelationship(character.id).flags['status']).toBe('dating');
    expect(listMemories(character.id).some((m) => m.tags.includes('milestone'))).toBe(true);
  });

  it('deflect leaves status unchanged but sets a cooldown that blocks re-asking', async () => {
    const { character } = seedWorldAndCharacter();
    makeWarm(character.id, 50);
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'Where is this going?');

    setAdapterOverride(reply({ decision: 'deflect', line: 'Maybe soon.', reason: 'unsure' }));
    const res = await attemptDtr(session.id);
    expect(res.decision).toBe('deflect');
    expect(res.status).toBe('none');
    expect(getRelationship(character.id).flags['status']).toBeUndefined();
    expect(getRelationship(character.id).flags['dtr:lastAttemptDay']).toBe(1);

    // Same in-world day → cooldown rejects another attempt.
    setAdapterOverride(reply({ decision: 'accept', line: 'ok', reason: '' }));
    await expect(attemptDtr(session.id)).rejects.toThrow(/time/i);
  });

  it('backfire raises tension and ends the date', async () => {
    const { character } = seedWorldAndCharacter();
    makeWarm(character.id, 50);
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'Be mine?');
    const before = getRelationship(character.id).tension;
    setAdapterOverride(reply({ decision: 'backfire', line: 'Whoa, way too soon.', reason: 'pushed' }));

    const res = await attemptDtr(session.id);
    expect(res.decision).toBe('backfire');
    expect(res.ended).toBe(true);
    expect(getRelationship(character.id).tension).toBeGreaterThan(before);
  });

  it('rejects an attempt when warmth has not unlocked the next rung', async () => {
    const { character } = seedWorldAndCharacter(); // cold (warmth ~5)
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'Will you be my partner?');
    setAdapterOverride(reply({ decision: 'accept', line: 'sure', reason: '' }));
    await expect(attemptDtr(session.id)).rejects.toThrow(/too soon|closer/i);
  });

  it('a concurrent second DTR is rejected so the accept commits exactly once', async () => {
    // Regression: cooldown + rung were read from the pre-await snapshot, so two
    // overlapping attempts both ran the accept branch (double deltas, two milestone
    // memories, double social vouch). The per-session in-flight lock rejects the
    // second.
    const { character } = seedWorldAndCharacter();
    makeWarm(character.id, 50);
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    addPlayerMessage(session.id, 'I want to ask you something.');
    const a0 = getRelationship(character.id).affection;
    setAdapterOverride(reply({ decision: 'accept', line: "Yes — let's.", reason: 'ready' }));

    const results = await Promise.allSettled([attemptDtr(session.id), attemptDtr(session.id)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    // accept applied once: +5 affection, status dating, a single milestone memory.
    expect(getRelationship(character.id).affection).toBe(a0 + 5);
    expect(getRelationship(character.id).flags['status']).toBe('dating');
    expect(listMemories(character.id).filter((m) => m.tags.includes('milestone'))).toHaveLength(1);
  });
});
