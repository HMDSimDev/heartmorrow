/* ===========================================================================
   Draft persistence — unsaved creator work auto-kept in localStorage.

   The contract: anything you're editing (a new/edited character, a world, a
   half-set-up new world) is snapshotted to localStorage as a *draft* while it
   differs from its saved baseline, so a tab switch / refresh / close never
   loses it. Drafts are cleared the moment you Save (or explicitly Discard).

   This module is pure (no React) so it's trivially testable and so the People
   page can enumerate drafts without touching any editor. Keys follow the app's
   existing `dsim.<area>.<...>` localStorage convention (see app-context.tsx).
   =========================================================================== */

export type DraftKind = 'character' | 'world' | 'worldOnboarding';

/** The stored shape. We keep metadata alongside the form data so a drafts list
 *  can describe a draft (label, age, world) without rehydrating the editor. */
export interface DraftEnvelope<T = unknown> {
  /** Schema version — bump to invalidate incompatible old drafts after a Form
   *  shape change. Anything that isn't `1` is treated as absent. */
  v: 1;
  kind: DraftKind;
  /** Distinguishes records of the same kind: a character id, `new__<worldId>`
   *  for an unsaved new character, a world id, or `singleton`. */
  scopeId: string;
  /** The world this draft belongs to (for filtering a per-world drafts list).
   *  null for world-less new characters / the onboarding singleton. */
  worldId: string | null;
  /** A brand-new record (the draft *is* the whole thing) vs unsaved edits to an
   *  existing saved record (the draft diverges from a server record). Drives the
   *  restore-bar copy. */
  isNew: boolean;
  /** Human label for the drafts list, e.g. the in-progress name or 'Untitled'. */
  label: string;
  /** Date.now() of the last write — powers "saved 3m ago" and stale GC. */
  updatedAt: number;
  /** The actual form snapshot (Character `Form`, `World`, onboarding bundle). */
  data: T;
}

const PREFIX = 'dsim.draft.v1';

/** Scope id for an unsaved *new* character, keyed by the world it'll belong to
 *  so each world keeps its own in-flight new character (and they never collide). */
export const NEW_CHAR_SCOPE = (worldId: string | null): string => `new__${worldId ?? 'none'}`;

/** True when a character draft's scopeId is an unsaved-new one (vs a saved id). */
export const isNewCharScope = (scopeId: string): boolean => scopeId.startsWith('new__');

export const draftKey = {
  character: (scopeId: string) => `${PREFIX}.character.${scopeId}`,
  world: (worldId: string) => `${PREFIX}.world.${worldId}`,
  worldOnboarding: () => `${PREFIX}.worldOnboarding.singleton`,
};

// ---------------------------------------------------------------------------
// Storage primitives — all best-effort: localStorage can throw (quota, or be
// disabled in private mode). Mirror app-context's try/catch-and-degrade style.
// ---------------------------------------------------------------------------

export function loadDraft<T>(key: string): DraftEnvelope<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const env = JSON.parse(raw) as DraftEnvelope<T>;
    return env && env.v === 1 ? env : null;
  } catch {
    return null;
  }
}

/** Returns false if the write failed (quota exceeded / storage disabled) so the
 *  UI can stop promising the work is safely kept. */
export function saveDraft<T>(key: string, env: DraftEnvelope<T>): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(env));
    return true;
  } catch {
    /* quota exceeded / storage disabled — drafts are best-effort */
    return false;
  }
}

export function removeDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Enumerate every stored draft (newest first), optionally filtered. Reads
 *  envelopes rather than parsing keys, so the key format can evolve freely. */
export function listDrafts(filter?: {
  kind?: DraftKind;
  /** Pass a worldId (or null) to match exactly; omit to match any. */
  worldId?: string | null;
  isNew?: boolean;
}): DraftEnvelope[] {
  const out: DraftEnvelope[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(`${PREFIX}.`)) continue;
      const env = loadDraft(key);
      if (!env) continue;
      if (filter?.kind && env.kind !== filter.kind) continue;
      if (filter && 'worldId' in filter && filter.worldId !== undefined && env.worldId !== filter.worldId) continue;
      if (filter?.isNew !== undefined && env.isNew !== filter.isNew) continue;
      out.push(env);
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The localStorage key for a stored envelope (used by a drafts list to act on
 *  a draft it enumerated). */
export function keyForEnvelope(env: DraftEnvelope): string {
  switch (env.kind) {
    case 'character':
      return draftKey.character(env.scopeId);
    case 'world':
      return draftKey.world(env.scopeId);
    case 'worldOnboarding':
      return draftKey.worldOnboarding();
  }
}

/** Drop drafts that can no longer be acted on: older than `maxAgeMs`, or whose
 *  world/character no longer exists. Keeps the drafts list honest. Best-effort
 *  and safe to call on mount. Returns the number pruned. */
export function pruneDrafts(opts: {
  maxAgeMs?: number;
  /** Ids of worlds that still exist; a draft whose world is gone is pruned.
   *  Omit to skip the world check (when the world list isn't loaded yet). */
  liveWorldIds?: Set<string>;
  /** Ids of characters that still exist; an *edit* character draft whose record
   *  is gone is pruned. Omit to skip. */
  liveCharacterIds?: Set<string>;
} = {}): number {
  const { maxAgeMs, liveWorldIds, liveCharacterIds } = opts;
  const now = Date.now();
  const doomed: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(`${PREFIX}.`)) continue;
      const env = loadDraft(key);
      if (!env) {
        doomed.push(key); // corrupt / wrong-version blob
        continue;
      }
      if (maxAgeMs !== undefined && now - env.updatedAt > maxAgeMs) {
        doomed.push(key);
        continue;
      }
      // A draft tied to a world that's been deleted can never be resumed.
      if (liveWorldIds && env.worldId && !liveWorldIds.has(env.worldId)) {
        doomed.push(key);
        continue;
      }
      // An *edit* character draft whose saved record is gone is unreachable.
      if (
        liveCharacterIds &&
        env.kind === 'character' &&
        !isNewCharScope(env.scopeId) &&
        !liveCharacterIds.has(env.scopeId)
      ) {
        doomed.push(key);
        continue;
      }
    }
  } catch {
    return 0;
  }
  for (const key of doomed) removeDraft(key);
  return doomed.length;
}

// ---------------------------------------------------------------------------
// Dirty detection — a structural, key-order-insensitive compare. Our draftable
// state is plain JSON (objects/arrays/strings/numbers/booleans/null), so a
// canonical stringify is a correct and cheap equality test.
// ---------------------------------------------------------------------------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = canonical(obj[k]);
    return sorted;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** Structural equality for draftable form state (ignores object key order). */
export function draftEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** "just now" / "5m ago" / "3h ago" / "2d ago" for restore copy + drafts list. */
export function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const min = Math.round(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}
