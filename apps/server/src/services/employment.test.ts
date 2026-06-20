import { describe, it, expect, beforeEach } from 'vitest';
import { EmploymentSchema } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { createCharacter, updateCharacter } from './character-service';
import { exportAll, importAll } from './data-service';
import { charactersRepo } from '../db/repositories';
import { getDb } from '../db/index';

beforeEach(() => resetDb());

const JOB = { title: 'Barista', place: 'Café Lumen', workdays: [0, 1, 2, 3, 4], shiftPhase: 'morning' as const };

describe('character employment (Phase 1)', () => {
  it('persists an authored job and round-trips through export/import', () => {
    const { world } = seedWorldAndCharacter();
    const c = createCharacter({ worldId: world.id, name: 'Bo', age: 26, employment: JOB });

    expect(charactersRepo.get(c.id)?.employment).toEqual(JOB);

    // A full export → wipe → import cycle must preserve the job byte-for-byte.
    importAll(exportAll());
    expect(charactersRepo.get(c.id)?.employment).toEqual(JOB);
  });

  it('defaults to unemployed (null) when no job is authored', () => {
    const { character } = seedWorldAndCharacter();
    expect(character.employment).toBeNull();
    expect(charactersRepo.get(character.id)?.employment).toBeNull();
  });

  it('can be set and cleared via updateCharacter', () => {
    const { character } = seedWorldAndCharacter();
    updateCharacter(character.id, { employment: JOB });
    expect(charactersRepo.get(character.id)?.employment?.place).toBe('Café Lumen');
    updateCharacter(character.id, { employment: null });
    expect(charactersRepo.get(character.id)?.employment).toBeNull();
  });

  it('decodes a legacy row whose employment column is the JSON literal null without throwing', () => {
    const { character } = seedWorldAndCharacter();
    // Mirrors what the idempotent ALTER backfills onto pre-migration rows.
    getDb().run("UPDATE characters SET employment = 'null' WHERE id = ?", character.id);
    expect(() => charactersRepo.get(character.id)).not.toThrow();
    expect(charactersRepo.get(character.id)?.employment).toBeNull();
  });

  it('rejects an empty object — why the column DEFAULT is the JSON literal null, not {}', () => {
    // A DEFAULT of '{}' would decode to {}, fail the required title/place, and throw
    // in rowToCharacter for every legacy row. The 'null' default avoids that.
    expect(EmploymentSchema.safeParse({}).success).toBe(false);
    expect(EmploymentSchema.safeParse(JOB).success).toBe(true);
  });
});
