import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, seedWorldAndCharacter, seedGroupWorld } from '../test/helpers';
import { setAdapterOverride } from '../llm/provider';
import { createSession } from './conversation-service';
import { requireFeature, featureEnabled } from './world-feature-service';
import { createWorld } from './world-service';
import { sessionParticipantsRepo, sessionsRepo } from '../db/repositories';

beforeEach(() => resetDb());
afterEach(() => setAdapterOverride(null));

describe('group-date data spine (Phase 0)', () => {
  it('seeds a single seat-0 host participant row for a new date session', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });

    const rows = sessionParticipantsRepo.listBySession(session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: session.id,
      characterId: character.id,
      seat: 0,
      role: 'romance',
      state: 'present',
      rapport: null, // unseeded until the first judged turn
    });
  });

  it('seeds the roster for a plain chat session too (additive, mode-agnostic)', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'chat', locationId: null });
    expect(sessionParticipantsRepo.listBySession(session.id)).toHaveLength(1);
  });

  it('cascade-deletes participant rows when the session is removed', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'chat', locationId: null });
    expect(sessionParticipantsRepo.listBySession(session.id)).toHaveLength(1);

    sessionsRepo.delete(session.id);
    expect(sessionParticipantsRepo.listBySession(session.id)).toHaveLength(0);
  });

  it('setRapport auto-creates a seat-0 row for a session that has none (legacy fallback)', () => {
    const { character } = seedWorldAndCharacter();
    const session = createSession({ characterId: character.id, mode: 'date', locationId: null });
    sessionParticipantsRepo.deleteBySession(session.id); // simulate a pre-Phase-0 session

    sessionParticipantsRepo.setRapport(session.id, character.id, 73, Date.now());
    const row = sessionParticipantsRepo.get(session.id, character.id);
    expect(row).toMatchObject({ seat: 0, role: 'romance', state: 'present', rapport: 73 });
  });
});

describe('groupDates feature flag (Phase 0)', () => {
  it('defaults to false on a freshly created world', () => {
    const world = createWorld({ name: 'Plain' });
    expect(world.featureFlags.groupDates).toBe(false);
    expect(featureEnabled(world.id, 'groupDates')).toBe(false);
  });

  it('requireFeature throws 403 when off and passes when on', () => {
    const off = createWorld({ name: 'Off' });
    expect(() => requireFeature(off.id, 'groupDates')).toThrow(/group dates are not enabled/i);

    const { world } = seedGroupWorld();
    expect(featureEnabled(world.id, 'groupDates')).toBe(true);
    expect(() => requireFeature(world.id, 'groupDates')).not.toThrow();
  });
});
