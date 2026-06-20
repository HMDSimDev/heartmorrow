import { describe, it, expect, beforeEach } from 'vitest';
import type { WarmthStats } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { getRelationship } from './relationship-service';
import { applyRelationshipChange } from './stat-service';
import { listMemories } from './memory-service';
import { detectMilestoneCrossing } from './milestone-service';

const cold: WarmthStats = { affection: 5, trust: 5, chemistry: 5, comfort: 5, respect: 5, tension: 0 };

beforeEach(() => resetDb());

describe('milestone crossings', () => {
  it('fires once on an upward crossing into a milestone band, writing a memory + flag', () => {
    const { character } = seedWorldAndCharacter();
    // Default warmth is ~5 (near-strangers); bump each stat to 55 → warmth 55 ("getting close").
    const after = applyRelationshipChange(
      character.id,
      { affection: 50, trust: 50, chemistry: 50, comfort: 50, respect: 50 },
      { source: 'test' },
    );

    const m = detectMilestoneCrossing(character.id, cold, after, { day: 1, mode: 'date' });
    expect(m).not.toBeNull();
    expect(m!.band).toBe('getting-close');
    expect(getRelationship(character.id).flags['milestone:getting-close']).toBe(true);
    expect(getRelationship(character.id).flags['milestone:pendingText']).toBe('getting-close');
    expect(listMemories(character.id).some((mm) => mm.tags.includes('milestone'))).toBe(true);

    // Idempotent: the same band does not fire a second time.
    expect(detectMilestoneCrossing(character.id, cold, getRelationship(character.id), { day: 1, mode: 'date' })).toBeNull();
  });

  it('does not fire for a non-milestone band or a downward move', () => {
    const { character } = seedWorldAndCharacter();
    // Bump to warmth 30 ("warming up") — a real band change, but not a celebrated one.
    const warmingUp = applyRelationshipChange(
      character.id,
      { affection: 25, trust: 25, chemistry: 25, comfort: 25, respect: 25 },
      { source: 'test' },
    );
    expect(detectMilestoneCrossing(character.id, cold, warmingUp, { day: 1, mode: 'date' })).toBeNull();

    // Downward move (close → getting-close) never fires.
    const closeWarm: WarmthStats = { affection: 70, trust: 70, chemistry: 70, comfort: 70, respect: 70, tension: 0 };
    expect(detectMilestoneCrossing(character.id, closeWarm, warmingUp, { day: 1, mode: 'date' })).toBeNull();
  });

  it('surfaces only the highest band on a big jump but marks the skipped ones', () => {
    const { character } = seedWorldAndCharacter();
    // Jump straight to warmth 85 ("sweethearts"), skipping getting-close + close.
    const after = applyRelationshipChange(
      character.id,
      { affection: 80, trust: 80, chemistry: 80, comfort: 80, respect: 80 },
      { source: 'test' },
    );
    const m = detectMilestoneCrossing(character.id, cold, after, { day: 2, mode: 'date' });
    expect(m!.band).toBe('sweethearts');
    const flags = getRelationship(character.id).flags;
    // Skipped intermediate milestones are marked so they can't re-fire later.
    expect(flags['milestone:getting-close']).toBe(true);
    expect(flags['milestone:close']).toBe(true);
    expect(flags['milestone:sweethearts']).toBe(true);
  });
});
