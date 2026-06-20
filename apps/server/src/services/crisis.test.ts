import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DESPAIR } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { getRelationship } from './relationship-service';
import { applyRelationshipChange, stampLastSeen } from './stat-service';
import { listMemories } from './memory-service';
import { updateLlmSettings } from './settings-service';
import { createSession } from './conversation-service';
import { sendPlayerText } from './text-message-service';
import {
  adjustDespair,
  getDespair,
  evaluateDespairArc,
  memorialize,
  isMemorialized,
  listMemorialCharacterIds,
} from './crisis-service';

const enable = () => updateLlmSettings({ tragicOutcomesEnabled: true, nsfwEnabled: true });
/** Raise warmth into the "close" band so the character is deeply attached (eligible). */
function makeAttached(characterId: string): void {
  applyRelationshipChange(
    characterId,
    { affection: 70, trust: 70, chemistry: 70, comfort: 70, respect: 70 },
    { source: 'test' },
  );
}

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('tragic-outcomes gating', () => {
  it('does NOTHING when the toggle is off, even under heavy abuse', () => {
    // toggle off by default
    const { character } = seedWorldAndCharacter();
    makeAttached(character.id);
    adjustDespair(character.id, 100, 'abuse', 1);
    evaluateDespairArc(character.id, { day: 1 });
    expect(getDespair(getRelationship(character.id))).toBe(0);
    expect(isMemorialized(getRelationship(character.id))).toBe(false);
  });

  it('only accrues for a deeply-attached character (not a shallow one)', () => {
    enable();
    const { character } = seedWorldAndCharacter(); // fresh, not attached
    adjustDespair(character.id, 100, 'abuse', 1);
    expect(getDespair(getRelationship(character.id))).toBe(0); // ineligible → no-op
    makeAttached(character.id);
    adjustDespair(character.id, 30, 'abuse', 1);
    expect(getDespair(getRelationship(character.id))).toBeGreaterThan(0);
  });
});

describe('the off-ramp', () => {
  it('heals back to zero once the player stops — never reaching the outcome', () => {
    enable();
    const { character } = seedWorldAndCharacter();
    makeAttached(character.id);
    adjustDespair(character.id, DESPAIR.crisis + 5, 'abuse', 1); // into crisis
    evaluateDespairArc(character.id, { day: 1 });
    // Player stops: just let days pass, no more harm.
    for (let day = 2; day <= 14; day += 1) evaluateDespairArc(character.id, { day });
    expect(getDespair(getRelationship(character.id))).toBe(0);
    expect(isMemorialized(getRelationship(character.id))).toBe(false);
    expect(getRelationship(character.id).flags['state:despairing']).toBe(false);
  });

  it('keeps healing even when the player has not seen them in many days — neglect alone never deepens despair or memorializes', () => {
    enable();
    const { character } = seedWorldAndCharacter();
    makeAttached(character.id);
    stampLastSeen(character.id, 1); // last seen long ago, and already deep in crisis…
    adjustDespair(character.id, DESPAIR.crisis + 5, 'abuse', 1);
    // …the player simply stays away. Despair must trend strictly DOWN every day —
    // passive neglect must NOT escalate it — and must never reach the memorial.
    let prev = getDespair(getRelationship(character.id));
    for (let day = 2; day <= 16; day += 1) {
      evaluateDespairArc(character.id, { day });
      const now = getDespair(getRelationship(character.id));
      expect(now).toBeLessThanOrEqual(prev);
      expect(isMemorialized(getRelationship(character.id))).toBe(false);
      prev = now;
    }
    expect(getDespair(getRelationship(character.id))).toBe(0);
  });
});

describe('the spiral stages', () => {
  it('withdrawn queues a quiet distress text; crisis opens a crisis episode', () => {
    enable();
    const { character } = seedWorldAndCharacter();
    makeAttached(character.id);

    adjustDespair(character.id, 50, 'abuse', 1); // → ~42 after decay = withdrawn
    evaluateDespairArc(character.id, { day: 1 });
    let rel = getRelationship(character.id);
    expect(rel.flags['state:despairing']).toBe(true);
    expect(rel.flags['harm:pending']).toBe('withdrawn');

    adjustDespair(character.id, 40, 'abuse', 2); // push into crisis
    evaluateDespairArc(character.id, { day: 2 });
    rel = getRelationship(character.id);
    expect(rel.flags['harm:pending']).toBe('crisis');
    expect(typeof rel.flags['harm:crisisSince']).toBe('number');
  });
});

describe('the terminal outcome', () => {
  it('only memorializes after a SUSTAINED crisis with continued harm', () => {
    enable();
    const { character } = seedWorldAndCharacter();
    makeAttached(character.id);

    let memorialDay = 0;
    for (let day = 1; day <= 6; day += 1) {
      adjustDespair(character.id, 100, 'abuse', day); // continued severe harm each day
      evaluateDespairArc(character.id, { day });
      if (isMemorialized(getRelationship(character.id))) {
        memorialDay = day;
        break;
      }
    }
    // Crisis opens day 1; terminal needs crisisDaysBeforeTerminal days of it.
    expect(memorialDay).toBe(1 + DESPAIR.crisisDaysBeforeTerminal);
  });

  it('memorialize sets the kept memorial state and blocks all interaction', async () => {
    enable();
    const { character } = seedWorldAndCharacter();
    makeAttached(character.id);
    memorialize(character.id, 5);

    const rel = getRelationship(character.id);
    expect(isMemorialized(rel)).toBe(true);
    expect(rel.flags['status']).toBe('none');
    expect(listMemories(character.id).some((m) => m.tags.includes('memorial'))).toBe(true);
    expect(listMemorialCharacterIds()).toContain(character.id);

    // No more dates or texts with someone who's gone.
    expect(() => createSession({ characterId: character.id, mode: 'date', locationId: null })).toThrow(/no longer with us/i);
    await expect(sendPlayerText(character.id, 'hey')).rejects.toThrow(/no longer with us/i);
  });
});
