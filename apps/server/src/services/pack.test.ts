import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb } from '../test/helpers';
import { createWorld, createWorldNote } from './world-service';
import { createCharacter, updateCharacter } from './character-service';
import { createProperty } from './property-service';
import { createCompany } from './market-service';
import { saveUploadedAsset, listAssets, deleteAsset, readAssetFile } from './asset-service';
import {
  charactersRepo,
  worldsRepo,
  worldNotesRepo,
  propertiesRepo,
  companiesRepo,
} from '../db/repositories';
import { zipSync, unzipSync } from '../lib/zip';
import { exportCharacterPack, exportWorldPack, exportBundlePack, importPack, inspectPack } from './pack-service';

const STATS = { charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 };

/** A buffer that begins with the real PNG magic bytes (so the import sniff accepts
 *  it), with a unique tail so two portraits never collide byte-for-byte. */
function pngBytes(tag: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`png-${tag}`)]);
}

function portrait(tag: string): string {
  return saveUploadedAsset({
    buffer: pngBytes(tag),
    originalFilename: `${tag}.png`,
    mimeType: 'image/png',
    type: 'portrait',
  }).id;
}

const linkPairs = (c: { links: Array<{ targetId: string; kind: string }> }) =>
  c.links.map((l) => ({ targetId: l.targetId, kind: l.kind }));

beforeEach(() => resetDb());
// Each saved asset writes a real file; clean every file this test created. (resetDb
// only wipes the in-memory DB, so we delete via the asset rows still present.)
afterEach(() => {
  for (const a of listAssets()) deleteAsset(a.id);
});

describe('character share files (.hmchr)', () => {
  it('round-trips a character and its portrait bytes as fresh ids', () => {
    const w = createWorld({ name: 'Alpha' });
    const pid = portrait('mira');
    const mira = createCharacter({ worldId: w.id, name: 'Mira', age: 27, datingStats: STATS, portraitAssetId: pid });
    const original = readAssetFile(pid).buffer;

    const buf = exportCharacterPack([mira.id]);
    const res = importPack(buf, {}); // no target world → world-less

    expect(res.kind).toBe('character');
    expect(res.characters).toBe(1);
    expect(res.assets).toBe(1);
    const imported = charactersRepo.get(res.characterIds[0]!)!;
    expect(imported.id).not.toBe(mira.id);
    expect(imported.worldId).toBeNull();
    expect(imported.name).toBe('Mira');
    expect(imported.portraitAssetId).toBeTruthy();
    expect(imported.portraitAssetId).not.toBe(pid);
    // The bytes survived the round-trip intact.
    expect(readAssetFile(imported.portraitAssetId!).buffer.equals(original)).toBe(true);
  });

  it('imports loose characters into a chosen target world', () => {
    const src = createWorld({ name: 'Src' });
    const dst = createWorld({ name: 'Dst' });
    const a = createCharacter({ worldId: src.id, name: 'Ada', age: 30, datingStats: STATS });
    const res = importPack(exportCharacterPack([a.id]), { targetWorldId: dst.id });
    expect(charactersRepo.get(res.characterIds[0]!)!.worldId).toBe(dst.id);
  });

  it('remaps links within the exported set and drops links to outsiders', () => {
    const w = createWorld({ name: 'W' });
    const mira = createCharacter({ worldId: w.id, name: 'Mira', age: 27, datingStats: STATS });
    const dorian = createCharacter({ worldId: w.id, name: 'Dorian', age: 31, datingStats: STATS });
    const outsider = createCharacter({ worldId: w.id, name: 'Outsider', age: 40, datingStats: STATS });
    updateCharacter(mira.id, {
      links: [
        { targetId: dorian.id, kind: 'ex' },
        { targetId: outsider.id, kind: 'rival' },
      ],
    });

    const res = importPack(exportCharacterPack([mira.id, dorian.id]), { targetWorldId: w.id });
    const imported = res.characterIds.map((id) => charactersRepo.get(id)!);
    const im = imported.find((c) => c.name === 'Mira')!;
    const id = imported.find((c) => c.name === 'Dorian')!;
    // The ex-link is remapped to the imported Dorian; the rival → outsider is dropped.
    expect(linkPairs(im)).toEqual([{ targetId: id.id, kind: 'ex' }]);
  });
});

describe('world share files (.hmwrld)', () => {
  it('round-trips a world with cast, notes, property, company, and images', () => {
    const locImg = portrait('loc');
    const w = createWorld({
      name: 'Lumen',
      summary: 'sunlit',
      tone: 'cozy',
      locations: [{ id: 'loc1', name: 'Cafe', imageAssetId: locImg }],
    });
    createWorldNote(w.id, { title: 'Lore', body: 'tides', tags: ['e'], scope: 'lore', importance: 4 });
    const miraPortrait = portrait('mira');
    const mira = createCharacter({ worldId: w.id, name: 'Mira', age: 27, datingStats: STATS, portraitAssetId: miraPortrait });
    const dorian = createCharacter({ worldId: w.id, name: 'Dorian', age: 31, datingStats: STATS });
    updateCharacter(mira.id, { links: [{ targetId: dorian.id, kind: 'ex' }] });
    const propImg = portrait('prop');
    createProperty({ worldId: w.id, name: 'Loft', assetId: propImg });
    const compImg = portrait('comp');
    createCompany({ worldId: w.id, name: 'Acme', ticker: 'ACME', linkedCharacterId: mira.id, assetId: compImg });

    const res = importPack(exportWorldPack(w.id), {});

    expect(res.kind).toBe('world');
    expect(res.worlds).toBe(1);
    expect(res.assets).toBe(4); // loc + mira portrait + prop + company, all distinct

    const nw = worldsRepo.get(res.worldIds[0]!)!;
    expect(nw.id).not.toBe(w.id);
    expect(nw.name).toBe('Lumen');
    expect(nw.locations[0]!.imageAssetId).toBeTruthy();
    expect(nw.locations[0]!.imageAssetId).not.toBe(locImg);
    expect(worldNotesRepo.listByWorld(nw.id)).toHaveLength(1);

    const cast = charactersRepo.listByWorld(nw.id);
    expect(cast).toHaveLength(2);
    const nm = cast.find((c) => c.name === 'Mira')!;
    const nd = cast.find((c) => c.name === 'Dorian')!;
    expect(linkPairs(nm)).toEqual([{ targetId: nd.id, kind: 'ex' }]);
    expect(nm.portraitAssetId).toBeTruthy();
    expect(nm.portraitAssetId).not.toBe(miraPortrait);

    const props = propertiesRepo.listByWorld(nw.id);
    expect(props).toHaveLength(1);
    expect(props[0]!.assetId).not.toBe(propImg);

    const comps = companiesRepo.listByWorld(nw.id);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.linkedCharacterId).toBe(nm.id); // linked character remapped
    expect(comps[0]!.assetId).not.toBe(compImg);

    // The source world is untouched.
    expect(charactersRepo.listByWorld(w.id)).toHaveLength(2);
  });
});

describe('world share files: the characters toggle', () => {
  it('omits the cast (and their portraits) when exported with includeCharacters=false', () => {
    const w = createWorld({ name: 'Solo' });
    createCharacter({ worldId: w.id, name: 'Mira', age: 27, datingStats: STATS, portraitAssetId: portrait('mira') });
    createProperty({ worldId: w.id, name: 'Loft', assetId: portrait('prop') });

    const res = importPack(exportWorldPack(w.id, { includeCharacters: false }), {});

    expect(res.worlds).toBe(1);
    expect(res.characters).toBe(0);
    const nw = worldsRepo.get(res.worldIds[0]!)!;
    expect(charactersRepo.listByWorld(nw.id)).toHaveLength(0);
    expect(propertiesRepo.listByWorld(nw.id)).toHaveLength(1);
    expect(res.assets).toBe(1); // only the property image travelled, not Mira's portrait
  });

  it('imports just the world when includeCharacters=false at import time', () => {
    const w = createWorld({ name: 'Full' });
    createCharacter({ worldId: w.id, name: 'Mira', age: 27, datingStats: STATS, portraitAssetId: portrait('mira') });
    createProperty({ worldId: w.id, name: 'Loft', assetId: portrait('prop') });

    const res = importPack(exportWorldPack(w.id), { includeCharacters: false }); // full file, partial import

    expect(res.worlds).toBe(1);
    expect(res.characters).toBe(0);
    const nw = worldsRepo.get(res.worldIds[0]!)!;
    expect(charactersRepo.listByWorld(nw.id)).toHaveLength(0);
    expect(propertiesRepo.listByWorld(nw.id)).toHaveLength(1);
    expect(res.assets).toBe(1); // the cast portrait in the file was NOT materialized
  });

  it("nulls a company's linkedCharacterId when the cast is excluded", () => {
    const w = createWorld({ name: 'Mkt' });
    const mira = createCharacter({ worldId: w.id, name: 'Mira', age: 27, datingStats: STATS });
    createCompany({ worldId: w.id, name: 'Acme', ticker: 'ACME', linkedCharacterId: mira.id });

    const res = importPack(exportWorldPack(w.id, { includeCharacters: false }), {});
    const nw = worldsRepo.get(res.worldIds[0]!)!;
    const comps = companiesRepo.listByWorld(nw.id);
    expect(comps).toHaveLength(1);
    expect(comps[0]!.linkedCharacterId).toBeNull();
    expect(charactersRepo.listByWorld(nw.id)).toHaveLength(0);
  });
});

describe('bundle share files (.hmpack)', () => {
  it('round-trips multiple worlds and loose characters', () => {
    const w1 = createWorld({ name: 'One' });
    createCharacter({ worldId: w1.id, name: 'Aria', age: 20, datingStats: STATS });
    const w2 = createWorld({ name: 'Two' });
    const loose = createCharacter({ worldId: w2.id, name: 'Loose', age: 22, datingStats: STATS });

    const buf = exportBundlePack({ worldIds: [w1.id], characterIds: [loose.id] });

    const preview = inspectPack(buf);
    expect(preview.kind).toBe('pack');
    expect(preview.worlds.map((w) => w.name)).toContain('One');
    expect(preview.characters.map((c) => c.name)).toEqual(expect.arrayContaining(['Aria', 'Loose']));

    const res = importPack(buf, { targetWorldId: w2.id });
    expect(res.kind).toBe('pack');
    expect(res.worlds).toBe(1); // 'One' re-created
    expect(res.characters).toBe(2); // 'Aria' in the new world + 'Loose' into w2
  });
});

describe('inspect preview (the metadata step)', () => {
  it('returns rich world + character details and the exporter title/note', () => {
    const w = createWorld({
      name: 'Lumen',
      summary: 'sunlit',
      tone: 'cozy',
      locations: [
        { id: 'l1', name: 'Cafe' },
        { id: 'l2', name: 'Pier' },
      ],
    });
    createCharacter({
      worldId: w.id,
      name: 'Mira',
      age: 27,
      pronouns: 'she/her',
      shortDescription: 'a careful florist',
      datingStats: STATS,
      portraitAssetId: portrait('mira'),
    });
    createProperty({ worldId: w.id, name: 'Loft' });

    const preview = inspectPack(exportWorldPack(w.id, { title: 'My Lumen', note: 'enjoy!' }));

    expect(preview.title).toBe('My Lumen');
    expect(preview.note).toBe('enjoy!');
    expect(preview.worlds).toHaveLength(1);
    const wp = preview.worlds[0]!;
    expect(wp.name).toBe('Lumen');
    expect(wp.tone).toBe('cozy');
    expect(wp.locations).toEqual(['Cafe', 'Pier']);
    expect(wp.characterCount).toBe(1);
    expect(wp.propertyCount).toBe(1);

    expect(preview.characters).toHaveLength(1);
    const cp = preview.characters[0]!;
    expect(cp.name).toBe('Mira');
    expect(cp.age).toBe(27);
    expect(cp.pronouns).toBe('she/her');
    expect(cp.shortDescription).toBe('a careful florist');
    expect(cp.hasPortrait).toBe(true);
    expect(cp.world).toBe('Lumen');
  });
});

describe('compatibility (the format must survive schema drift)', () => {
  it('ignores unknown future fields and fills in missing ones with defaults', () => {
    const w = createWorld({ name: 'W' });
    const c = createCharacter({ worldId: w.id, name: 'Mira', age: 27, datingStats: STATS, quirks: ['hums'] });

    const map = unzipSync(exportCharacterPack([c.id]));
    const payload = JSON.parse(map.get('character.json')!.toString('utf8'));
    payload.characters[0].futureFieldFromTomorrow = { nested: true }; // unknown (forward-compat)
    delete payload.characters[0].quirks; // missing (backward-compat)
    const rebuilt = zipSync([
      { name: 'manifest.json', data: map.get('manifest.json')! },
      { name: 'character.json', data: Buffer.from(JSON.stringify(payload)) },
    ]);

    const res = importPack(rebuilt, { targetWorldId: w.id });
    const imported = charactersRepo.get(res.characterIds[0]!)!;
    expect(imported.name).toBe('Mira');
    expect(imported.quirks).toEqual([]); // default filled in
    expect('futureFieldFromTomorrow' in (imported as Record<string, unknown>)).toBe(false); // unknown stripped
  });
});

describe('rejecting bad input', () => {
  it('rejects a non-archive', () => {
    expect(() => importPack(Buffer.from('totally not a zip'), {})).toThrow();
  });
  it('rejects a zip without a Heartmorrow manifest', () => {
    const buf = zipSync([{ name: 'random.json', data: Buffer.from('{}') }]);
    expect(() => importPack(buf, {})).toThrow(/manifest|Heartmorrow/i);
  });
  it('rejects importing loose characters into a non-existent world', () => {
    const w = createWorld({ name: 'W' });
    const c = createCharacter({ worldId: w.id, name: 'X', age: 25, datingStats: STATS });
    const buf = exportCharacterPack([c.id]);
    expect(() => importPack(buf, { targetWorldId: 'world_does_not_exist' })).toThrow();
  });
});
