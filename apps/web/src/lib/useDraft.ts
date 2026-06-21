import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type DraftEnvelope,
  type DraftKind,
  draftEqual,
  loadDraft,
  removeDraft,
  saveDraft,
} from './drafts';

/* ===========================================================================
   useDraft — auto-persist unsaved editor state as a localStorage draft.

   The caller owns its form `value` and a `baseline` (the saved record, or the
   empty/initial form for a new record). This hook:
     • writes `value` to localStorage (debounced) whenever it diverges from
       `baseline`, and removes the draft when it returns to baseline;
     • flushes the pending write synchronously when the record changes or the
       editor unmounts, so a fast tab/world switch never drops sub-debounce
       edits (and on refresh/close via beforeunload, which also warns);
     • on entering an editor, surfaces any pre-existing draft as `found` — an
       *offer* the caller renders as a restore bar (we never silently apply it);
     • exposes restore/discard/clear so Save and the restore bar resolve it.

   `found` holds the discovered draft in memory, so Restore keeps working even
   after the on-disk copy is overwritten by fresh edits.
   =========================================================================== */

export interface UseDraftMeta {
  kind: DraftKind;
  scopeId: string;
  worldId: string | null;
  isNew: boolean;
  /** Lazy so the label reflects the latest form at write time (e.g. the name). */
  label: () => string;
}

export interface UseDraftOptions<T> {
  /** The localStorage key; null disables persistence (e.g. before it's known). */
  key: string | null;
  /** The live form state to persist. */
  value: T;
  /** The saved/initial state to diff against; null while the record is loading. */
  baseline: T | null;
  meta: UseDraftMeta;
  /** Gate persistence until the initial load has run (default true). */
  enabled?: boolean;
  debounceMs?: number;
}

export interface UseDraftResult<T> {
  /** value differs from baseline — drives the "Unsaved draft" pill. */
  dirty: boolean;
  /** True when the last write failed (storage full/disabled) while still dirty —
   *  so the UI can stop promising the work is safely kept. */
  persistError: boolean;
  /** Bumped whenever a draft is written or removed — a signal callers can put in
   *  a dep array to re-read localStorage (e.g. the WorldEditor sidebar dots). */
  persisted: number;
  /** A pre-existing draft discovered for this key (offer it via a restore bar). */
  found: DraftEnvelope<T> | null;
  /** Resolve the offer by restoring: returns the draft's data (caller setForm's
   *  it) and dismisses the bar. Returns null if there was no offer. */
  restore: () => T | null;
  /** Resolve the offer by deleting the stored draft. */
  discard: () => void;
  /** Hide the offer without deleting the draft (a refresh re-offers it). */
  dismissFound: () => void;
  /** Call on a successful Save: deletes the draft + cancels any pending write. */
  clear: () => void;
}

interface Pending<T> {
  key: string;
  data: T;
  meta: UseDraftMeta;
}

export function useDraft<T>(opts: UseDraftOptions<T>): UseDraftResult<T> {
  const { key, value, baseline, meta, enabled = true, debounceMs = 600 } = opts;

  const active = enabled && key != null && baseline != null;

  const dirty = useMemo(
    () => (active ? !draftEqual(value, baseline) : false),
    [active, value, baseline],
  );

  const [found, setFound] = useState<DraftEnvelope<T> | null>(null);
  const [persistError, setPersistError] = useState(false);
  const [persisted, setPersisted] = useState(0);

  // Latest baseline, read by the discovery effect without being a dep (a new
  // record's baseline is a fresh object each render and would thrash effects).
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;

  // The not-yet-written snapshot. Held explicitly (with its own key+meta) so a
  // flush triggered by switching records writes the OLD record, not the new one.
  const pendingRef = useRef<Pending<T> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // True once this session has dirtied the form — so a fresh mount sitting at
  // baseline never deletes a just-discovered draft (only an actual return to
  // baseline after editing clears it).
  const wasDirty = useRef(false);

  // Cancel any queued write + reset the dirtied flag. Shared by clear()/discard()
  // so a resolved draft can't be resurrected by a still-armed debounce timer.
  const cancelPending = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pendingRef.current = null;
    wasDirty.current = false;
  }, []);

  // Write the pending snapshot now (and cancel the debounce). Stable identity so
  // it can run from effect cleanups without re-subscribing.
  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pendingRef.current;
    if (!p) return;
    const ok = saveDraft<T>(p.key, {
      v: 1,
      kind: p.meta.kind,
      scopeId: p.meta.scopeId,
      worldId: p.meta.worldId,
      isNew: p.meta.isNew,
      label: p.meta.label(),
      updatedAt: Date.now(),
      data: p.data,
    });
    pendingRef.current = null;
    setPersistError(!ok);
    setPersisted((n) => n + 1);
  }, []);

  // Discover a stored draft when the record (key/active) changes. The cleanup
  // flushes any pending write for the OLD record before we move on — this is
  // what makes a fast switch / unmount lossless.
  useEffect(() => {
    wasDirty.current = false;
    if (!active || !key) {
      setFound(null);
    } else {
      const env = loadDraft<T>(key);
      // Only offer a draft that diverges from the saved baseline; an equal one is
      // a no-op (and shouldn't exist — we clear on return-to-baseline).
      if (env && (baselineRef.current == null || !draftEqual(env.data, baselineRef.current))) {
        setFound(env);
      } else {
        setFound(null);
      }
    }
    return () => flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);

  // Queue a debounced write while dirty; remove the draft on return-to-baseline.
  useEffect(() => {
    if (!active || !key) return;
    if (!dirty) {
      pendingRef.current = null; // nothing to persist
      if (wasDirty.current) {
        // edited then returned to baseline — drop the now-stale draft
        wasDirty.current = false;
        removeDraft(key);
        setPersisted((n) => n + 1);
      }
      return;
    }
    wasDirty.current = true;
    pendingRef.current = { key, data: value, meta };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, debounceMs);
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
    // meta is captured per-render via the closure above (not a dep — its identity
    // changes every render); value changes already re-run this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, dirty, value, debounceMs]);

  // Refresh/close backstop: synchronously flush the latest edits and warn the
  // browser-native way. Only while dirty.
  useEffect(() => {
    if (!active || !key || !dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      flush();
      e.preventDefault();
      e.returnValue = ''; // Chrome needs a set returnValue to show the prompt
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active, key, dirty, flush]);

  const restore = useCallback((): T | null => {
    const data = found ? found.data : null;
    setFound(null);
    return data;
  }, [found]);

  const discard = useCallback(() => {
    cancelPending(); // stop a queued/cleanup flush from rewriting the discarded draft
    if (key) removeDraft(key);
    setPersistError(false);
    setPersisted((n) => n + 1);
    setFound(null);
  }, [key, cancelPending]);

  const dismissFound = useCallback(() => setFound(null), []);

  const clear = useCallback(() => {
    cancelPending();
    if (key) removeDraft(key);
    setPersistError(false);
    setPersisted((n) => n + 1);
    setFound(null);
  }, [key, cancelPending]);

  return { dirty, persistError, persisted, found, restore, discard, dismissFound, clear };
}
