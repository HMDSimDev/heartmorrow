import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DraftEnvelope,
  draftEqual,
  draftKey,
  isNewCharScope,
  keyForEnvelope,
  listDrafts,
  loadDraft,
  NEW_CHAR_SCOPE,
  pruneDrafts,
  relativeTime,
  removeDraft,
  saveDraft,
} from './drafts';

// Minimal in-memory localStorage so the storage helpers can be exercised in the
// Node test env (the web package has no jsdom). Insertion order is preserved so
// key(i) iteration matches a real Storage.
class MemStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return Array.from(this.m.keys())[i] ?? null;
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = new MemStorage() as unknown as Storage;
});
afterEach(() => {
  delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
});

const env = (over: Partial<DraftEnvelope> = {}): DraftEnvelope => ({
  v: 1,
  kind: 'character',
  scopeId: 'c_1',
  worldId: 'w_1',
  isNew: false,
  label: 'Ada',
  updatedAt: Date.now(),
  data: { name: 'Ada' },
  ...over,
});

describe('draftEqual (dirty detection)', () => {
  it('is insensitive to object key order', () => {
    expect(draftEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(draftEqual({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toBe(true);
  });

  it('is sensitive to array order and to values', () => {
    expect(draftEqual([1, 2, 3], [1, 3, 2])).toBe(false);
    expect(draftEqual({ likes: ['a', 'b'] }, { likes: ['a', 'b'] })).toBe(true);
    expect(draftEqual({ age: 20 }, { age: 21 })).toBe(false);
  });

  it('treats null distinctly from a string and handles nested null', () => {
    expect(draftEqual({ worldId: null }, { worldId: null })).toBe(true);
    expect(draftEqual({ worldId: null }, { worldId: 'w' })).toBe(false);
  });

  it('matches a realistic untouched character form against itself', () => {
    const form = {
      name: '',
      age: 18,
      worldId: 'w_1',
      likes: [] as string[],
      datingStats: { charm: 50, wit: 50 },
      expressionRows: [
        { name: 'happy', assetId: null },
        { name: 'sad', assetId: null },
      ],
      employment: null,
    };
    expect(draftEqual(form, { ...form })).toBe(true);
    expect(draftEqual(form, { ...form, name: 'A' })).toBe(false);
    expect(
      draftEqual(form, { ...form, expressionRows: [{ name: 'happy', assetId: 'x' }, { name: 'sad', assetId: null }] }),
    ).toBe(false);
  });
});

describe('keys', () => {
  it('builds namespaced keys and identifies new-character scopes', () => {
    expect(draftKey.character('c_1')).toBe('dsim.draft.v1.character.c_1');
    expect(draftKey.world('w_1')).toBe('dsim.draft.v1.world.w_1');
    expect(draftKey.worldOnboarding()).toBe('dsim.draft.v1.worldOnboarding.singleton');
    expect(NEW_CHAR_SCOPE('w_1')).toBe('new__w_1');
    expect(NEW_CHAR_SCOPE(null)).toBe('new__none');
    expect(isNewCharScope('new__w_1')).toBe(true);
    expect(isNewCharScope('c_1')).toBe(false);
  });

  it('keyForEnvelope round-trips for every kind', () => {
    expect(keyForEnvelope(env({ kind: 'character', scopeId: 'c_9' }))).toBe('dsim.draft.v1.character.c_9');
    expect(keyForEnvelope(env({ kind: 'world', scopeId: 'w_9' }))).toBe('dsim.draft.v1.world.w_9');
    expect(keyForEnvelope(env({ kind: 'worldOnboarding', scopeId: 'singleton' }))).toBe(
      'dsim.draft.v1.worldOnboarding.singleton',
    );
  });
});

describe('save/load/remove', () => {
  it('round-trips an envelope and rejects a wrong-version blob', () => {
    const k = draftKey.character('c_1');
    expect(saveDraft(k, env())).toBe(true);
    expect(loadDraft(k)?.label).toBe('Ada');
    localStorage.setItem(k, JSON.stringify({ ...env(), v: 99 }));
    expect(loadDraft(k)).toBeNull();
    removeDraft(k);
    expect(loadDraft(k)).toBeNull();
  });
});

describe('listDrafts', () => {
  it('filters by kind/world/isNew and sorts newest first', () => {
    saveDraft(draftKey.character('c_1'), env({ scopeId: 'c_1', worldId: 'w_1', updatedAt: 100 }));
    saveDraft(draftKey.character(NEW_CHAR_SCOPE('w_1')), env({ scopeId: NEW_CHAR_SCOPE('w_1'), worldId: 'w_1', isNew: true, updatedAt: 300 }));
    saveDraft(draftKey.character('c_2'), env({ scopeId: 'c_2', worldId: 'w_2', updatedAt: 200 }));
    saveDraft(draftKey.world('w_1'), env({ kind: 'world', scopeId: 'w_1', worldId: 'w_1', updatedAt: 50 }));

    const charW1 = listDrafts({ kind: 'character', worldId: 'w_1' });
    expect(charW1.map((d) => d.scopeId)).toEqual([NEW_CHAR_SCOPE('w_1'), 'c_1']); // newest first

    expect(listDrafts({ kind: 'character', isNew: true }).map((d) => d.scopeId)).toEqual([NEW_CHAR_SCOPE('w_1')]);
    expect(listDrafts({ kind: 'world' }).map((d) => d.scopeId)).toEqual(['w_1']);
  });
});

describe('pruneDrafts — safety', () => {
  it('deletes NOTHING when no live-id sets are provided (the "do not nuke everything" guard)', () => {
    saveDraft(draftKey.character('c_1'), env({ scopeId: 'c_1', worldId: 'w_gone' }));
    saveDraft(draftKey.world('w_1'), env({ kind: 'world', scopeId: 'w_1', worldId: 'w_1' }));
    saveDraft(draftKey.worldOnboarding(), env({ kind: 'worldOnboarding', scopeId: 'singleton', worldId: null, isNew: true }));
    const pruned = pruneDrafts({}); // no liveWorldIds / liveCharacterIds, no maxAge
    expect(pruned).toBe(0);
    expect(listDrafts()).toHaveLength(3);
  });

  it('prunes a draft whose world is gone, but keeps live-world and worldId:null drafts', () => {
    saveDraft(draftKey.character('c_live'), env({ scopeId: 'c_live', worldId: 'w_live' }));
    saveDraft(draftKey.character(NEW_CHAR_SCOPE('w_dead')), env({ scopeId: NEW_CHAR_SCOPE('w_dead'), worldId: 'w_dead', isNew: true }));
    saveDraft(draftKey.worldOnboarding(), env({ kind: 'worldOnboarding', scopeId: 'singleton', worldId: null, isNew: true }));

    const pruned = pruneDrafts({ liveWorldIds: new Set(['w_live']), liveCharacterIds: new Set(['c_live']) });
    expect(pruned).toBe(1); // only the w_dead new-char draft
    const left = listDrafts().map((d) => d.scopeId).sort();
    expect(left).toEqual(['c_live', 'singleton']); // onboarding singleton (worldId null) survives
  });

  it('prunes an EDIT character draft whose record is gone, keeps a new-char draft regardless', () => {
    saveDraft(draftKey.character('c_deleted'), env({ scopeId: 'c_deleted', worldId: 'w_1' }));
    saveDraft(draftKey.character(NEW_CHAR_SCOPE('w_1')), env({ scopeId: NEW_CHAR_SCOPE('w_1'), worldId: 'w_1', isNew: true }));

    const pruned = pruneDrafts({ liveWorldIds: new Set(['w_1']), liveCharacterIds: new Set(['c_other']) });
    expect(pruned).toBe(1);
    expect(listDrafts().map((d) => d.scopeId)).toEqual([NEW_CHAR_SCOPE('w_1')]); // new-char never checked against char ids
  });

  it('prunes by age and removes corrupt blobs', () => {
    saveDraft(draftKey.character('c_old'), env({ scopeId: 'c_old', updatedAt: Date.now() - 60 * 24 * 3600 * 1000 }));
    saveDraft(draftKey.character('c_new'), env({ scopeId: 'c_new', updatedAt: Date.now() }));
    localStorage.setItem('dsim.draft.v1.character.c_bad', '{not json');

    const pruned = pruneDrafts({ maxAgeMs: 30 * 24 * 3600 * 1000 });
    expect(pruned).toBe(2); // old + corrupt
    expect(listDrafts().map((d) => d.scopeId)).toEqual(['c_new']);
  });
});

describe('relativeTime', () => {
  it('renders human deltas', () => {
    const now = Date.now();
    expect(relativeTime(now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3600_000)).toBe('3h ago');
    expect(relativeTime(now - 2 * 24 * 3600_000)).toBe('2d ago');
  });
});
