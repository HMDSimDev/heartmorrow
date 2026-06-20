import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../test/helpers';
import { createWorld, createWorldNote, cloneWorld } from './world-service';
import { createCharacter, updateCharacter, cloneCharactersToWorld } from './character-service';
import { getRelationship } from './relationship-service';
import { charactersRepo, worldNotesRepo } from '../db/repositories';

beforeEach(() => resetDb());

const STATS = { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 };

function pair(worldId: string) {
  const a = createCharacter({ worldId, name: 'Mira', age: 27, datingStats: STATS });
  const b = createCharacter({ worldId, name: 'Dorian', age: 31, datingStats: STATS });
  updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'ex' }] });
  updateCharacter(b.id, { links: [{ targetId: a.id, kind: 'ex' }] });
  return { a, b };
}

const linkPairs = (c: { links: Array<{ targetId: string; kind: string }> }) =>
  c.links.map((l) => ({ targetId: l.targetId, kind: l.kind }));

describe('importing characters from other worlds', () => {
  it('copies definitions as fresh characters with links remapped within the set', () => {
    const a = createWorld({ name: 'Alpha' });
    const { a: mira, b: dorian } = pair(a.id);
    const b = createWorld({ name: 'Beta' });

    const imported = cloneCharactersToWorld([mira.id, dorian.id], b.id);

    expect(imported).toHaveLength(2);
    expect(imported.every((c) => c.worldId === b.id)).toBe(true);
    expect(imported.every((c) => c.id !== mira.id && c.id !== dorian.id)).toBe(true);

    const bMira = imported.find((c) => c.name === 'Mira')!;
    const bDorian = imported.find((c) => c.name === 'Dorian')!;
    // The ex-link now points at the COPY in world B, not the original in world A.
    expect(linkPairs(bMira)).toEqual([{ targetId: bDorian.id, kind: 'ex' }]);
    expect(linkPairs(bDorian)).toEqual([{ targetId: bMira.id, kind: 'ex' }]);

    // A fresh, independent relationship exists for the copy (a new story).
    expect(getRelationship(bMira.id).affection).toBe(getRelationship(mira.id).affection);
    expect(getRelationship(bMira.id).characterId).toBe(bMira.id);

    // The originals in world A are untouched.
    expect(charactersRepo.listByWorld(a.id).map((c) => c.id).sort()).toEqual([mira.id, dorian.id].sort());
  });

  it('drops links to characters that were not imported', () => {
    const a = createWorld({ name: 'Alpha' });
    const { a: mira } = pair(a.id); // Mira is linked to Dorian, who we will NOT import
    const b = createWorld({ name: 'Beta' });

    const imported = cloneCharactersToWorld([mira.id], b.id);
    expect(imported).toHaveLength(1);
    expect(imported[0]!.links).toEqual([]); // the dangling ex-link is dropped
  });
});

describe('cloning a whole world (start from another save)', () => {
  it('copies the world definition, its notes, and its cast', () => {
    const src = createWorld({ name: 'Source', summary: 'a sunlit quarter', tone: 'cozy' });
    createWorldNote(src.id, { title: 'Lore', body: 'the lantern tide', tags: ['event'], scope: 'lore', importance: 4 });
    const { a: mira, b: dorian } = pair(src.id);

    const clone = cloneWorld(src.id, 'My New Save');

    expect(clone.id).not.toBe(src.id);
    expect(clone.name).toBe('My New Save');
    expect(clone.summary).toBe('a sunlit quarter');
    expect(clone.tone).toBe('cozy');
    expect(worldNotesRepo.listByWorld(clone.id)).toHaveLength(1);

    const cast = charactersRepo.listByWorld(clone.id);
    expect(cast).toHaveLength(2);
    expect(cast.every((c) => c.id !== mira.id && c.id !== dorian.id)).toBe(true);
    // Intra-cast links survive the clone, remapped to the new ids.
    const cMira = cast.find((c) => c.name === 'Mira')!;
    const cDorian = cast.find((c) => c.name === 'Dorian')!;
    expect(linkPairs(cMira)).toEqual([{ targetId: cDorian.id, kind: 'ex' }]);

    // Source world + cast are untouched.
    expect(charactersRepo.listByWorld(src.id)).toHaveLength(2);
  });
});
