import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../test/helpers';
import { createWorld } from './world-service';
import { createCharacter, updateCharacter, getCharacter } from './character-service';

beforeEach(() => resetDb());

function person(worldId: string | null, name: string) {
  return createCharacter({
    worldId,
    name,
    age: 25,
    datingStats: { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 },
  });
}

/** The kind of B's link back to A, or null if B has no link to A. */
function backLink(bId: string, aId: string): string | null {
  return getCharacter(bId).links.find((l) => l.targetId === aId)?.kind ?? null;
}

describe('reciprocal connections', () => {
  it('mirrors a non-rival connection onto the other character', () => {
    const world = createWorld({ name: 'W' });
    const a = person(world.id, 'A');
    const b = person(world.id, 'B');

    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'friend' }] });
    expect(backLink(b.id, a.id)).toBe('friend');
  });

  it('keeps rival one-sided', () => {
    const world = createWorld({ name: 'W' });
    const a = person(world.id, 'A');
    const b = person(world.id, 'B');

    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'rival' }] });
    expect(backLink(b.id, a.id)).toBeNull();
  });

  it('updates the reciprocal when the kind changes', () => {
    const world = createWorld({ name: 'W' });
    const a = person(world.id, 'A');
    const b = person(world.id, 'B');

    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'friend' }] });
    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'partner' }] });
    expect(backLink(b.id, a.id)).toBe('partner');
  });

  it('removes the reciprocal when the connection is removed', () => {
    const world = createWorld({ name: 'W' });
    const a = person(world.id, 'A');
    const b = person(world.id, 'B');

    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'friend' }] });
    expect(backLink(b.id, a.id)).toBe('friend');
    updateCharacter(a.id, { links: [] });
    expect(backLink(b.id, a.id)).toBeNull();
  });

  it('drops the reciprocal when a connection is switched to rival', () => {
    const world = createWorld({ name: 'W' });
    const a = person(world.id, 'A');
    const b = person(world.id, 'B');

    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'friend' }] });
    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'rival' }] });
    expect(backLink(b.id, a.id)).toBeNull();
  });

  it('mirrors connections authored at creation time', () => {
    const world = createWorld({ name: 'W' });
    const a = person(world.id, 'A');
    const b = createCharacter({
      worldId: world.id,
      name: 'B',
      age: 25,
      links: [{ targetId: a.id, kind: 'family' }],
      datingStats: { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 },
    });
    expect(backLink(a.id, b.id)).toBe('family');
  });

  it('mirrors mentor as mentee on the other side (not mentor↔mentor)', () => {
    const world = createWorld({ name: 'W' });
    const a = person(world.id, 'A');
    const b = person(world.id, 'B');

    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'mentor' }] });
    expect(backLink(b.id, a.id)).toBe('mentee');
    // And the inverse: authoring a mentee mirrors back as mentor.
    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'mentee' }] });
    expect(backLink(b.id, a.id)).toBe('mentor');
  });

  it('removes the mentee mirror when the mentor link is removed', () => {
    const world = createWorld({ name: 'W' });
    const a = person(world.id, 'A');
    const b = person(world.id, 'B');

    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'mentor' }] });
    expect(backLink(b.id, a.id)).toBe('mentee');
    updateCharacter(a.id, { links: [] });
    expect(backLink(b.id, a.id)).toBeNull();
  });

  it('never mirrors across worlds', () => {
    const w1 = createWorld({ name: 'W1' });
    const w2 = createWorld({ name: 'W2' });
    const a = person(w1.id, 'A');
    const b = person(w2.id, 'B');

    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'friend' }] });
    expect(backLink(b.id, a.id)).toBeNull(); // different world → no mirror
  });
});
