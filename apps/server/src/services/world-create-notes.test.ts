import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../test/helpers';
import { createWorld, listWorldNotes } from './world-service';

beforeEach(() => resetDb());

describe('createWorld persists structured notes alongside the world', () => {
  it('inserts each provided note onto the new world', () => {
    const world = createWorld({
      name: 'Lumen Quarter',
      summary: 'A lamplit arts district.',
      notes: [
        { title: 'The Lamplighters Guild', body: 'They keep the brass lamps burning.', scope: 'faction', importance: 4 },
        { title: 'Festival of Embers', body: 'An autumn rite of small flames.', tags: ['autumn', 'rite'] },
      ],
    });

    const notes = listWorldNotes(world.id);
    expect(notes).toHaveLength(2);
    const guild = notes.find((n) => n.title === 'The Lamplighters Guild');
    expect(guild?.scope).toBe('faction');
    expect(guild?.importance).toBe(4);
    const festival = notes.find((n) => n.title === 'Festival of Embers');
    expect(festival?.tags).toEqual(['autumn', 'rite']);
    expect(festival?.scope).toBe('global'); // schema default applied
  });

  it('creates the world with no notes when none are provided', () => {
    const world = createWorld({ name: 'Quiet World' });
    expect(listWorldNotes(world.id)).toHaveLength(0);
  });
});
