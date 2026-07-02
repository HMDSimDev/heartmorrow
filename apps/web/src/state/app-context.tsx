import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import type { ActiveDate, Asset, PlayerProfile, SleepResponse, World, WorldState } from '@dsim/shared';
import { deriveCalendar } from '@dsim/shared';
import { api } from '../lib/api';
import { idbGet, idbSet, idbDel } from '../lib/idb-kv';

const ACTIVE_WORLD_KEY = 'dsim.activeWorldId';
const CREATOR_KEY = 'dsim.creatorMode';
// Advanced mode reveals power-user settings (sampler knobs, the Prompt Editor). It
// is purely UI gating — client-only, like creator mode — and OFF by default.
const ADVANCED_KEY = 'dsim.advancedMode';
// Only the tiny accent values live in localStorage. The wallpaper IMAGE is stored
// as a Blob in IndexedDB, and `theme.wallpaper` holds a short-lived blob: object
// URL — NOT the megabyte data URL. Two reasons a data URL fails:
//   1. localStorage has a ~5MB quota (setTheme threw, silently dropping changes).
//   2. A CSS custom property value is capped near ~1MB, so a multi-MB data URL in
//      --phone-wallpaper truncates to garbage and renders as nothing.
// A blob: URL is ~50 chars, so it sidesteps both.
const THEME_KEY = 'dsim.theme';
const WALLPAPER_IDB_KEY = 'phoneWallpaper';

/** How the phone wallpaper is scaled to the screen — mirrors a desktop OS's
 *  wallpaper options. `fit` = whole image, letterboxed (the safe default). */
export type WallpaperFit = 'fit' | 'fill' | 'stretch' | 'center' | 'tile';
export const WALLPAPER_FITS: WallpaperFit[] = ['fit', 'fill', 'stretch', 'center', 'tile'];

/** Maps a fit mode to the CSS background size/position/repeat it implies. */
export function wallpaperFitCss(fit: WallpaperFit): { size: string; position: string; repeat: string } {
  switch (fit) {
    case 'fill': return { size: 'cover', position: 'center', repeat: 'no-repeat' };
    case 'stretch': return { size: '100% 100%', position: 'center', repeat: 'no-repeat' };
    case 'center': return { size: 'auto', position: 'center', repeat: 'no-repeat' };
    case 'tile': return { size: 'auto', position: 'top left', repeat: 'repeat' };
    case 'fit':
    default: return { size: 'contain', position: 'center', repeat: 'no-repeat' };
  }
}

export interface Theme {
  accent: string | null;
  accent2: string | null;
  wallpaper: string | null; // a blob: object URL (the image Blob lives in IndexedDB)
  wallpaperFit: WallpaperFit;
}

const DEFAULT_THEME: Theme = { accent: null, accent2: null, wallpaper: null, wallpaperFit: 'fit' };

/** Synchronous initial theme: the accents + wallpaper fit (from localStorage). The
 *  wallpaper image itself is hydrated asynchronously from IndexedDB after mount. */
function loadThemeMeta(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (!raw) return DEFAULT_THEME;
    const p = JSON.parse(raw) as Partial<Theme>;
    return {
      accent: p.accent ?? null,
      accent2: p.accent2 ?? null,
      wallpaper: null,
      wallpaperFit: p.wallpaperFit ?? 'fit',
    };
  } catch {
    return DEFAULT_THEME;
  }
}

interface AppData {
  player: PlayerProfile | null;
  assets: Asset[];
  assetById: (id: string | null | undefined) => Asset | undefined;
  reloadPlayer: () => Promise<void>;
  reloadAssets: () => Promise<void>;
  // World clock
  worlds: World[];
  /** True once the world list has been fetched at least once (so the app can tell
   *  "no world chosen yet" apart from "still loading"). */
  worldsLoaded: boolean;
  activeWorldId: string | null;
  activeWorld: World | null;
  worldState: WorldState | null;
  /** Monotonic counter bumped whenever the world clock advances (sleep) or a
   *  total reset happens. Day-derived per-tab effects depend on it so they
   *  refetch after End day / reset without each page re-deriving worldState.day. */
  dayTick: number;
  setActiveWorld: (id: string) => void;
  reloadWorlds: () => Promise<void>;
  refreshWorldState: () => Promise<void>;
  sleep: (expectedDay?: number) => Promise<SleepResponse | null>;
  // Mode + theme (client-side)
  creatorMode: boolean;
  setCreatorMode: (on: boolean) => void;
  /** Advanced mode: reveals power-user settings (sampler knobs + the Prompt Editor).
   *  Client-only UI gating, persisted to localStorage; the server enforces nothing. */
  advancedMode: boolean;
  setAdvancedMode: (on: boolean) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** Set (or clear, with null) the phone wallpaper from an image Blob/File. The
   *  Blob is persisted to IndexedDB and exposed as a blob: URL on `theme.wallpaper`. */
  setWallpaper: (image: Blob | null) => void;
  // Phone: unread incoming TEXTS (not emails), for the sidebar badge
  unreadTexts: number;
  refreshInbox: () => Promise<void>;
  /** The active world's single in-progress date (if any). Drives the Date-tab
   *  auto-resume, the nav "date underway" badge, and the lock on day-spending
   *  actions (Sleep / Work / Minigames). Null when no date is open. */
  activeDate: ActiveDate | null;
  /** False until the active-date has been fetched at least once for the current
   *  session, so the Date tab can show a spinner instead of flashing "plan a date"
   *  before it knows whether a date is already underway. */
  activeDateLoaded: boolean;
  refreshActiveDate: () => Promise<ActiveDate | null>;
  // Total reset
  resetProgress: () => Promise<void>;
}

const AppDataContext = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [player, setPlayer] = useState<PlayerProfile | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [worldsLoaded, setWorldsLoaded] = useState(false);
  // Whether the most recent world-list fetch actually SUCCEEDED. The stale-active-world
  // purge below must run only against a real list — a transient fetch failure leaves
  // `worlds` empty, which must NOT look like "the active world was deleted".
  const [worldsFetchedOk, setWorldsFetchedOk] = useState(false);
  const [activeWorldId, setActiveWorldId] = useState<string | null>(() => localStorage.getItem(ACTIVE_WORLD_KEY));
  const [worldState, setWorldState] = useState<WorldState | null>(null);
  const [dayTick, setDayTick] = useState(0);
  const [creatorMode, setCreatorModeState] = useState<boolean>(() => localStorage.getItem(CREATOR_KEY) !== 'false');
  const [advancedMode, setAdvancedModeState] = useState<boolean>(() => localStorage.getItem(ADVANCED_KEY) === 'true');
  const [theme, setThemeState] = useState<Theme>(loadThemeMeta);
  const [unreadTexts, setUnreadTexts] = useState(0);
  const [activeDate, setActiveDate] = useState<ActiveDate | null>(null);
  const [activeDateLoaded, setActiveDateLoaded] = useState(false);

  const reloadPlayer = useCallback(async () => {
    try {
      // The player profile (money + persona) is per-world; fetch the active world's.
      setPlayer(await api.getPlayer(activeWorldId ?? undefined));
    } catch {
      /* server may not be up yet */
    }
  }, [activeWorldId]);
  const reloadAssets = useCallback(async () => {
    try {
      setAssets(await api.listAssets());
    } catch {
      /* ignore */
    }
  }, []);
  const reloadWorlds = useCallback(async () => {
    try {
      setWorlds(await api.listWorlds());
      setWorldsFetchedOk(true);
    } catch {
      // Keep the last-known list and mark the fetch as failed so the stale-world
      // purge stays disabled — a server hiccup must never erase the saved active world.
      setWorldsFetchedOk(false);
    } finally {
      setWorldsLoaded(true);
    }
  }, []);
  const refreshInbox = useCallback(async () => {
    try {
      setUnreadTexts((await api.phoneInbox(activeWorldId ?? undefined)).unreadTexts);
    } catch {
      /* server may not be up yet */
    }
  }, [activeWorldId]);
  // The active world's in-progress date, the single source of truth for resume +
  // action-locking. Refetched on world change; the Date page also drives explicit
  // refreshes as a date starts and ends.
  const refreshActiveDate = useCallback(async (): Promise<ActiveDate | null> => {
    if (!activeWorldId) {
      setActiveDate(null);
      setActiveDateLoaded(true);
      return null;
    }
    try {
      const date = (await api.activeDate(activeWorldId)).date;
      setActiveDate(date);
      return date;
    } catch {
      /* leave the last-known value on a transient error */
      return null;
    } finally {
      setActiveDateLoaded(true);
    }
  }, [activeWorldId]);

  useEffect(() => {
    void reloadPlayer();
    void reloadAssets();
    void reloadWorlds();
  }, [reloadPlayer, reloadAssets, reloadWorlds]);

  // Poll the unread-text count so the sidebar badge stays current (texts can
  // arrive in the background as the world clock advances).
  useEffect(() => {
    void refreshInbox();
    const id = setInterval(() => void refreshInbox(), 15000);
    return () => clearInterval(id);
  }, [refreshInbox]);

  // World selection is DELIBERATE — we never silently drop the player into worlds[0].
  // Once the world list is known, only clear a STALE active id (a world that was
  // deleted), which routes the app back to the selector. Gate on a SUCCESSFUL fetch
  // so a transient list-fetch failure (empty `worlds`) can't masquerade as a deletion
  // and wipe the persisted active world.
  useEffect(() => {
    if (!worldsLoaded || !worldsFetchedOk) return;
    setActiveWorldId((cur) => {
      if (cur && worlds.some((w) => w.id === cur)) return cur;
      if (cur) localStorage.removeItem(ACTIVE_WORLD_KEY); // forget a deleted world
      return null;
    });
  }, [worldsLoaded, worldsFetchedOk, worlds]);

  const setActiveWorld = useCallback((id: string) => {
    localStorage.setItem(ACTIVE_WORLD_KEY, id);
    setActiveWorldId(id);
  }, []);

  const refreshWorldState = useCallback(async () => {
    if (!activeWorldId) {
      setWorldState(null);
      return;
    }
    try {
      setWorldState(await api.getWorldState(activeWorldId));
    } catch {
      setWorldState(null);
    }
  }, [activeWorldId]);

  useEffect(() => {
    void refreshWorldState();
  }, [refreshWorldState]);

  // Re-derive the in-progress date whenever the active world changes (and on first
  // mount) — so a refresh lands you back on the Date tab mid-date, and switching
  // worlds reflects that world's own open date (or none).
  useEffect(() => {
    void refreshActiveDate();
  }, [refreshActiveDate]);

  const sleep = useCallback(async (expectedDay?: number): Promise<SleepResponse | null> => {
    if (!activeWorldId) return null;
    const res = await api.sleep(activeWorldId, expectedDay);
    setWorldState(res.state);
    setDayTick((t) => t + 1); // signal day-derived tabs to refetch
    await reloadPlayer();
    return res;
  }, [activeWorldId, reloadPlayer]);

  const setCreatorMode = useCallback((on: boolean) => {
    localStorage.setItem(CREATOR_KEY, String(on));
    setCreatorModeState(on);
  }, []);

  const setAdvancedMode = useCallback((on: boolean) => {
    localStorage.setItem(ADVANCED_KEY, String(on));
    setAdvancedModeState(on);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    // Accents + wallpaper-fit are persisted here (small, to localStorage). The
    // wallpaper is a blob: URL carried through in state; its Blob is persisted by
    // setWallpaper into IndexedDB.
    try {
      localStorage.setItem(
        THEME_KEY,
        JSON.stringify({ accent: t.accent, accent2: t.accent2, wallpaperFit: t.wallpaperFit }),
      );
    } catch {
      /* ignore */
    }
    setThemeState(t);
  }, []);

  // The live blob: object URL for the wallpaper, tracked so we revoke the old one
  // when it's replaced (object URLs leak until revoked).
  const wallpaperUrlRef = useRef<string | null>(null);
  const applyWallpaperBlob = useCallback((blob: Blob | null) => {
    if (wallpaperUrlRef.current) URL.revokeObjectURL(wallpaperUrlRef.current);
    const url = blob ? URL.createObjectURL(blob) : null;
    wallpaperUrlRef.current = url;
    setThemeState((cur) => ({ ...cur, wallpaper: url }));
  }, []);

  const setWallpaper = useCallback(
    (image: Blob | null) => {
      if (image) void idbSet(WALLPAPER_IDB_KEY, image).catch(() => undefined);
      else void idbDel(WALLPAPER_IDB_KEY).catch(() => undefined);
      applyWallpaperBlob(image);
    },
    [applyWallpaperBlob],
  );

  // Hydrate the wallpaper Blob from IndexedDB after mount (it's too big for the
  // synchronous localStorage load), turning it into a blob: URL. Also migrates any
  // legacy data-URL wallpaper (from localStorage, or an earlier IDB string) to a Blob.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = localStorage.getItem(THEME_KEY);
        const legacy = raw ? (JSON.parse(raw) as Partial<Theme>) : null;
        if (legacy && typeof legacy.wallpaper === 'string' && legacy.wallpaper) {
          const blob = await (await fetch(legacy.wallpaper)).blob();
          await idbSet(WALLPAPER_IDB_KEY, blob);
          localStorage.setItem(
            THEME_KEY,
            JSON.stringify({
              accent: legacy.accent ?? null,
              accent2: legacy.accent2 ?? null,
              wallpaperFit: legacy.wallpaperFit ?? 'fit',
            }),
          );
        }
      } catch {
        /* ignore */
      }
      try {
        let stored = await idbGet<Blob | string>(WALLPAPER_IDB_KEY);
        if (typeof stored === 'string') {
          // Legacy: a data URL string was stored — convert to a Blob in place.
          stored = await (await fetch(stored)).blob();
          await idbSet(WALLPAPER_IDB_KEY, stored);
        }
        // Only apply if the user hasn't already set one this session (don't clobber).
        if (!cancelled && stored instanceof Blob) {
          const url = URL.createObjectURL(stored);
          setThemeState((cur) => {
            if (cur.wallpaper) {
              URL.revokeObjectURL(url);
              return cur;
            }
            wallpaperUrlRef.current = url;
            return { ...cur, wallpaper: url };
          });
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply theme to CSS variables.
  useEffect(() => {
    const root = document.documentElement;
    if (theme.accent) {
      root.style.setProperty('--accent', theme.accent);
      root.style.setProperty('--accent-2', theme.accent2 ?? theme.accent);
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-2');
    }
    root.style.setProperty('--phone-wallpaper', theme.wallpaper ? `url("${theme.wallpaper}")` : 'none');
    // Drive the wallpaper scaling from the chosen fit mode.
    const fit = wallpaperFitCss(theme.wallpaperFit);
    root.style.setProperty('--phone-wallpaper-size', fit.size);
    root.style.setProperty('--phone-wallpaper-position', fit.position);
    root.style.setProperty('--phone-wallpaper-repeat', fit.repeat);
  }, [theme]);

  // The Nocturne signature: the ambient lamplight breathes with the in-world
  // hour and season. We only set data-* hooks (consumed by styles.css) — never
  // --accent — so the user's chosen accent always survives.
  useEffect(() => {
    const root = document.documentElement;
    if (worldState) {
      root.dataset.phase = worldState.phase;
      root.dataset.season = deriveCalendar(worldState.day).season;
    } else {
      delete root.dataset.phase;
      delete root.dataset.season;
    }
  }, [worldState]);

  // Today's weather for the active world drives the ambient atmosphere overlay
  // (rain/snow/fog/sun…). Refetched when the world or the day changes.
  useEffect(() => {
    const root = document.documentElement;
    if (!activeWorldId) {
      delete root.dataset.weather;
      return;
    }
    let cancelled = false;
    void api
      .worldWeather(activeWorldId)
      .then((w) => {
        if (!cancelled) root.dataset.weather = w.today.kind;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeWorldId, worldState?.day]);

  const resetProgress = useCallback(async () => {
    await api.resetData();
    setDayTick((t) => t + 1); // everything is day-derived after a reset
    setActiveDate(null); // a reset wipes all sessions
    await Promise.all([reloadPlayer(), refreshWorldState(), refreshActiveDate()]);
  }, [reloadPlayer, refreshWorldState, refreshActiveDate]);

  const assetMap = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const assetById = useCallback(
    (id: string | null | undefined) => (id ? assetMap.get(id) : undefined),
    [assetMap],
  );
  const activeWorld = useMemo(() => worlds.find((w) => w.id === activeWorldId) ?? null, [worlds, activeWorldId]);

  const value = useMemo<AppData>(
    () => ({
      player,
      assets,
      assetById,
      reloadPlayer,
      reloadAssets,
      worlds,
      worldsLoaded,
      activeWorldId,
      activeWorld,
      worldState,
      dayTick,
      setActiveWorld,
      reloadWorlds,
      refreshWorldState,
      sleep,
      creatorMode,
      setCreatorMode,
      advancedMode,
      setAdvancedMode,
      theme,
      setTheme,
      setWallpaper,
      unreadTexts,
      refreshInbox,
      activeDate,
      activeDateLoaded,
      refreshActiveDate,
      resetProgress,
    }),
    [player, assets, assetById, reloadPlayer, reloadAssets, worlds, worldsLoaded, activeWorldId, activeWorld, worldState, dayTick, setActiveWorld, reloadWorlds, refreshWorldState, sleep, creatorMode, setCreatorMode, advancedMode, setAdvancedMode, theme, setTheme, setWallpaper, unreadTexts, refreshInbox, activeDate, activeDateLoaded, refreshActiveDate, resetProgress],
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppData {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error('useAppData must be used within AppDataProvider');
  return ctx;
}
