import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { DEFAULT_DATING_STATS, FeedPostSchema, NpcKnowledgeSchema } from '@dsim/shared';
import { composeConstellation, composeDossier, createCharacter, updateCharacter } from './character-service';
import { applyRelationshipChange, stampLastSeen } from './stat-service';
import { cloneWorld, createWorld, onDiscoveryGloballyEnabled } from './world-service';
import { updateLlmSettings } from './settings-service';
import { migrateDiscoveryBackfill } from '../db/migrate-discovery-backfill';
import { createSession } from './conversation-service';
import { getFeedView } from './feed-service';
import { pickGossipKnowledge } from './gossip-service';
import { recordDay } from './day-record-service';
import { dayRecordsRepo, feedPostsRepo, npcKnowledgeRepo } from '../db/repositories';
import { newId } from '../lib/ids';
import {
  assertMet,
  getAcquaintanceStage,
  getDiscoveryState,
  isDiscovered,
  listDiscoveredCharacterIds,
  stampGlimpsed,
  stampMet,
} from './discovery-service';

beforeEach(() => resetDb());

/**
 * Phase 0 (world-map discovery) — relationship-keying consolidation.
 *
 * Discovery makes "met" gate content, so the read-model the player sees MUST reflect the
 * relationship row the stat stack writes to. Every relationship write goes to
 * DEFAULT_PLAYER_ID; world isolation comes from characterId (see migrate-player-identity).
 * composeDossier used to read `player:${worldId}` — a key nothing writes — so its
 * `hasMet`/`standing` were computed from an empty phantom row.
 */
describe('discovery keying: composeDossier reads the relationship row writes land on', () => {
  it('reflects stats + last-seen written via stat-service (regression for the per-world phantom read)', () => {
    const { character } = seedWorldAndCharacter();

    applyRelationshipChange(
      character.id,
      { affection: 30, trust: 20, chemistry: 20, comfort: 20, respect: 20 },
      { source: 'test' },
    );
    stampLastSeen(character.id, 1); // a real "the player has interacted with them" signal

    const dossier = composeDossier(character.id);

    expect(dossier.hasMet).toBe(true);
    expect(dossier.standing).not.toBeNull();
    expect(dossier.standing!.warmthBand).toBeTruthy();
  });
});

describe('discovery acquaintance state (stored on the relationship flags)', () => {
  it('stampMet flips an unknown character to acquaintance + records where/when', () => {
    const { character } = seedWorldAndCharacter();
    expect(getAcquaintanceStage(character.id)).toBe('unknown');
    expect(isDiscovered(character.id)).toBe(false);

    stampMet(character.id, 3, 'loc-glasshouse');

    expect(getAcquaintanceStage(character.id)).toBe('acquaintance');
    expect(isDiscovered(character.id)).toBe(true);
    expect(getDiscoveryState(character.id)).toMatchObject({
      stage: 'acquaintance',
      metDay: 3,
      metAtLocationId: 'loc-glasshouse',
    });
  });

  it('stampGlimpsed leaves a lead but is not "met", and never downgrades an acquaintance', () => {
    const { character } = seedWorldAndCharacter();

    stampGlimpsed(character.id, 'loc-bar');
    expect(getAcquaintanceStage(character.id)).toBe('glimpsed');
    expect(isDiscovered(character.id)).toBe(false);

    stampMet(character.id, 1, null);
    stampGlimpsed(character.id, 'loc-bar'); // a later sighting must not undo the meet
    expect(getAcquaintanceStage(character.id)).toBe('acquaintance');
  });
});

describe('discovery gating (Phase 1): you can only interact with people you have met', () => {
  const DS = DEFAULT_DATING_STATS;
  beforeEach(() => updateLlmSettings({ discoveryMode: true }));

  it('blocks conversing with an unknown character, allows it once met', () => {
    const w = createWorld({ name: 'Town' });
    const c = createCharacter({ worldId: w.id, name: 'Stranger', age: 27, datingStats: DS });

    expect(() => createSession({ characterId: c.id, mode: 'chat', locationId: null })).toThrow(/met/i);

    stampMet(c.id, 1, null);
    expect(createSession({ characterId: c.id, mode: 'chat', locationId: null }).id).toBeTruthy();
  });

  it('a met fixture (dateable:false) can be chatted with but never dated', () => {
    const w = createWorld({ name: 'Town' });
    const fix = createCharacter({ worldId: w.id, name: 'Barkeep', age: 40, datingStats: DS, dateable: false });
    stampMet(fix.id, 1, null);

    expect(createSession({ characterId: fix.id, mode: 'chat', locationId: null }).id).toBeTruthy();
    expect(() => createSession({ characterId: fix.id, mode: 'date', locationId: null })).toThrow(/date/i);
  });

  it('"met" follows acquaintance state, not the legacy signal, in a discovery world', () => {
    const w = createWorld({ name: 'Town' });
    const c = createCharacter({ worldId: w.id, name: 'Nadia', age: 29, datingStats: DS });
    stampLastSeen(c.id, 1); // a legacy "seen" signal — must NOT count as met under discovery

    expect(composeDossier(c.id).hasMet).toBe(false);
    expect(composeConstellation(w.id).edges.find((e) => e.characterId === c.id)).toBeUndefined();

    stampMet(c.id, 1, null);
    expect(composeDossier(c.id).hasMet).toBe(true);
    expect(composeConstellation(w.id).edges.find((e) => e.characterId === c.id)).toBeTruthy();
  });
});

describe('discovery enable is non-destructive (backfill + cold-start seed)', () => {
  const DS = DEFAULT_DATING_STATS;

  it('backfills already-known people when discovery is turned on', () => {
    const w = createWorld({ name: 'Town' }); // discovery OFF
    const known = createCharacter({ worldId: w.id, name: 'Old Flame', age: 31, datingStats: DS });
    stampLastSeen(known.id, 2); // interacted with before discovery existed

    updateLlmSettings({ discoveryMode: true });
    onDiscoveryGloballyEnabled(); // what the settings route runs when the toggle flips on

    expect(getAcquaintanceStage(known.id)).toBe('acquaintance');
  });

  it('starts you knowing NO ONE (startKnownCount defaults to 0) when nobody was known before', () => {
    const w = createWorld({ name: 'Town' }); // discovery OFF
    const a = createCharacter({ worldId: w.id, name: 'A', age: 25, datingStats: DS });
    const b = createCharacter({ worldId: w.id, name: 'B', age: 26, datingStats: DS });

    updateLlmSettings({ discoveryMode: true });
    onDiscoveryGloballyEnabled();

    const known = [a, b].filter((c) => getAcquaintanceStage(c.id) === 'acquaintance');
    expect(known.length).toBe(0);
  });

  it('honors a world author opting into a starting acquaintance via discoveryConfig', () => {
    const w = createWorld({ name: 'Town', discoveryConfig: { startKnownCount: 1 } });
    const a = createCharacter({ worldId: w.id, name: 'A', age: 25, datingStats: DS });
    const b = createCharacter({ worldId: w.id, name: 'B', age: 26, datingStats: DS });

    updateLlmSettings({ discoveryMode: true });
    onDiscoveryGloballyEnabled();

    const known = [a, b].filter((c) => getAcquaintanceStage(c.id) === 'acquaintance');
    expect(known.length).toBe(1);
  });
});

describe('discovery redaction (Phase 1): the Phone does not leak unmet identities', () => {
  const DS = DEFAULT_DATING_STATS;
  beforeEach(() => updateLlmSettings({ discoveryMode: true }));

  it('composeDossier returns ??? for an undiscovered character, real once met', () => {
    const w = createWorld({ name: 'Town' });
    const c = createCharacter({ worldId: w.id, name: 'Mystery', age: 30, datingStats: DS });

    const hidden = composeDossier(c.id);
    expect(hidden.name).toBe('???');
    expect(hidden.hasMet).toBe(false);
    expect(hidden.ties).toEqual([]);
    expect(hidden.portraitAssetId).toBeNull();

    stampMet(c.id, 1, null);
    expect(composeDossier(c.id).name).toBe('Mystery');
  });

  it('hides feed posts by undiscovered characters, shows them once met', () => {
    const w = createWorld({ name: 'Town' });
    const c = createCharacter({ worldId: w.id, name: 'Poster', age: 28, datingStats: DS });
    feedPostsRepo.insert(
      FeedPostSchema.parse({
        id: newId('post'),
        worldId: w.id,
        authorType: 'character',
        authorId: c.id,
        body: 'lovely morning',
        kind: 'life',
        createdAt: Date.now(),
      }),
    );

    expect(getFeedView(w.id).posts.some((p) => p.authorId === c.id)).toBe(false);

    stampMet(c.id, 1, null);
    expect(getFeedView(w.id).posts.some((p) => p.authorId === c.id)).toBe(true);
  });

  it('listDiscoveredCharacterIds returns only met characters', () => {
    const w = createWorld({ name: 'Town' });
    const met = createCharacter({ worldId: w.id, name: 'Known', age: 25, datingStats: DS });
    const unmet = createCharacter({ worldId: w.id, name: 'Unknown', age: 26, datingStats: DS });
    stampMet(met.id, 1, null);

    const known = listDiscoveredCharacterIds(w.id);
    expect(known).toContain(met.id);
    expect(known).not.toContain(unmet.id);
  });
});

describe('discovery redaction: gossip + recap do not name unmet people', () => {
  const DS = DEFAULT_DATING_STATS;
  beforeEach(() => updateLlmSettings({ discoveryMode: true }));

  it('pickGossipKnowledge withholds gossip about an undiscovered subject', () => {
    const w = createWorld({ name: 'Town' });
    const knower = createCharacter({ worldId: w.id, name: 'Knower', age: 30, datingStats: DS });
    const subject = createCharacter({ worldId: w.id, name: 'Subject', age: 28, datingStats: DS });
    npcKnowledgeRepo.insert(
      NpcKnowledgeSchema.parse({
        id: newId('know'),
        worldId: w.id,
        knowerId: knower.id,
        subjectId: subject.id,
        topic: 'job',
        claim: 'Subject works at the bar',
        fidelity: 100,
        day: 1,
        createdAt: Date.now(),
      }),
    );

    expect(pickGossipKnowledge(knower.id, w.id)).toBeNull(); // subject unmet → withheld
    stampMet(subject.id, 1, null);
    expect(pickGossipKnowledge(knower.id, w.id)?.subjectId).toBe(subject.id);
  });

  it('suppresses around-town NPC beats from the day record under discovery', () => {
    const w = createWorld({ name: 'Town' });
    recordDay(w.id, 1, {
      recap: null,
      worldSim: { day: 1, beats: [{ kind: 'met', summary: 'Mara and Bo caught up at the cafe.' }], newLinks: [] },
      income: 0,
      events: [],
    });
    expect(dayRecordsRepo.get(w.id, 1)?.beats.some((b) => b.text.includes('Mara'))).toBe(false);
  });

  it('keeps around-town beats when discovery is off', () => {
    updateLlmSettings({ discoveryMode: false });
    const w = createWorld({ name: 'Town' });
    recordDay(w.id, 1, {
      recap: null,
      worldSim: { day: 1, beats: [{ kind: 'met', summary: 'Mara and Bo caught up.' }], newLinks: [] },
      income: 0,
      events: [],
    });
    expect(dayRecordsRepo.get(w.id, 1)?.beats.some((b) => b.text.includes('Mara'))).toBe(true);
  });
});

describe('discovery redaction: a met character does not leak their unmet peers', () => {
  const DS = DEFAULT_DATING_STATS;
  beforeEach(() => updateLlmSettings({ discoveryMode: true }));

  it("drops a met character's ties to unmet peers, reveals them once met", () => {
    const w = createWorld({ name: 'Town' });
    const a = createCharacter({ worldId: w.id, name: 'Ana', age: 30, datingStats: DS });
    const b = createCharacter({ worldId: w.id, name: 'Bo', age: 31, datingStats: DS });
    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'friend' }] });
    stampMet(a.id, 1, null); // met Ana, not Bo

    expect(composeDossier(a.id).ties.some((t) => t.targetId === b.id)).toBe(false);

    stampMet(b.id, 1, null);
    expect(composeDossier(a.id).ties.some((t) => t.targetId === b.id)).toBe(true);
  });

  it('flag off: dossier ties are not redacted', () => {
    updateLlmSettings({ discoveryMode: false });
    const w = createWorld({ name: 'Town' }); // discovery off
    const a = createCharacter({ worldId: w.id, name: 'Ana', age: 30, datingStats: DS });
    const b = createCharacter({ worldId: w.id, name: 'Bo', age: 31, datingStats: DS });
    updateCharacter(a.id, { links: [{ targetId: b.id, kind: 'friend' }] });

    expect(composeDossier(a.id).ties.some((t) => t.targetId === b.id)).toBe(true);
  });
});

describe('discovery interaction gates + lifecycle', () => {
  const DS = DEFAULT_DATING_STATS;
  beforeEach(() => updateLlmSettings({ discoveryMode: true }));

  it('assertMet gates non-conversation interactions (together / minigames) on having met them', () => {
    const w = createWorld({ name: 'Town' });
    const c = createCharacter({ worldId: w.id, name: 'Quinn', age: 27, datingStats: DS });
    expect(() => assertMet(c)).toThrow(/met/i);
    stampMet(c.id, 1, null);
    expect(() => assertMet(c)).not.toThrow();
  });

  it('cloning a world starts the new save knowing no one (a fresh, clean discovery slate)', () => {
    const w = createWorld({ name: 'Town' });
    createCharacter({ worldId: w.id, name: 'One', age: 25, datingStats: DS });
    createCharacter({ worldId: w.id, name: 'Two', age: 26, datingStats: DS });

    const copy = cloneWorld(w.id, 'Town Copy');
    expect(listDiscoveredCharacterIds(copy.id).length).toBe(0);
  });
});

describe('discovery default-on backfill migration (existing saves keep already-met people)', () => {
  const DS = DEFAULT_DATING_STATS;

  it('marks already-interacted people as acquaintances, leaving never-met people ???', () => {
    updateLlmSettings({ discoveryMode: true });
    const w = createWorld({ name: 'Town' });
    const known = createCharacter({ worldId: w.id, name: 'Old Flame', age: 31, datingStats: DS });
    const stranger = createCharacter({ worldId: w.id, name: 'Newcomer', age: 27, datingStats: DS });
    stampLastSeen(known.id, 3); // a classic-game interaction signal, no acquaintance flag yet

    migrateDiscoveryBackfill();

    expect(getAcquaintanceStage(known.id)).toBe('acquaintance');
    expect(getAcquaintanceStage(stranger.id)).toBe('unknown');
  });

  it('runs only once — a later interaction is not retroactively backfilled', () => {
    updateLlmSettings({ discoveryMode: true });
    const w = createWorld({ name: 'Town' });
    migrateDiscoveryBackfill(); // sets the marker (no one met yet)

    const c = createCharacter({ worldId: w.id, name: 'Later', age: 29, datingStats: DS });
    stampLastSeen(c.id, 5);
    migrateDiscoveryBackfill(); // no-op: marker already set

    expect(getAcquaintanceStage(c.id)).toBe('unknown');
  });

  it('does nothing when the player has discovery turned off', () => {
    updateLlmSettings({ discoveryMode: false });
    const w = createWorld({ name: 'Town' });
    const known = createCharacter({ worldId: w.id, name: 'Known', age: 30, datingStats: DS });
    stampLastSeen(known.id, 2);

    migrateDiscoveryBackfill();

    expect(getAcquaintanceStage(known.id)).toBe('unknown');
  });
});
