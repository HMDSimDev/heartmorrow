import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CHARACTER_LINK_ORDER,
  type Character,
  type CharacterDossier,
  type CharacterLinkKind,
  type ConstellationEdge,
  type SocialTie,
  type SocialWebNode,
} from '@dsim/shared';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import { characterLinkLabel, relationshipStatusLabel, warmthBandLabel } from '../../i18n/labels';
import { Icon, type IconName } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Portrait } from '../Portrait';
import { Banner, Empty, Spinner } from '../ui';
import './phone-life.css';
import './phone-constellation.css';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/** The hearth at the center of the sky — the player's own star. */
const PLAYER = '__player__';

/** "Crossed paths" is low-signal noise next to real bonds, so it's collapsed
 *  until the player opts in (the List view's footer toggle). */
const NOISE_KIND: CharacterLinkKind = 'acquaintance';

/** Each relationship kind → a monochrome lamplit icon (tints via currentColor). */
const KIND_ICON: Record<CharacterLinkKind, IconName> = {
  partner: 'affection',
  family: 'home',
  friend: 'people',
  ex: 'breakup',
  rival: 'rival',
  crush: 'remember',
  roommate: 'property',
  coworker: 'work',
  classmate: 'book',
  neighbor: 'location',
  mentor: 'star',
  acquaintance: 'acquaintance',
};

/** How tightly a tie of each kind draws two stars together (0..1) — partners orbit
 *  close, mere run-ins drift to the edge. Also drives a thread's weight in the sky. */
const KIND_PULL: Record<CharacterLinkKind, number> = {
  partner: 1,
  crush: 0.85,
  family: 0.8,
  friend: 0.7,
  roommate: 0.7,
  mentor: 0.6,
  ex: 0.5,
  classmate: 0.5,
  coworker: 0.5,
  rival: 0.45,
  neighbor: 0.4,
  acquaintance: 0.25,
};

// --- deterministic star-field layout ----------------------------------------

/** A stable 0..1 hash of a string — seeds each star's starting place so the sky
 *  always settles into the same shape for the same town (no per-load jitter). */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** A fixed, seeded field of faint background stars — each twinkles on its own clock
 *  (its own duration + a negative delay so they start mid-animation, never in sync). */
const BG_STARS = Array.from({ length: 26 }, (_, i) => ({
  x: hash01(`bx${i}`) * 100,
  y: hash01(`by${i}`) * 100,
  size: 1 + hash01(`bs${i}`) * 1.7,
  dur: 2.8 + hash01(`bu${i}`) * 4.6,
  delay: hash01(`bd${i}`) * -7,
  bright: hash01(`bb${i}`),
}));

interface SkyNode {
  id: string;
  x: number;
  y: number;
  degree: number;
  /** The player's warmth band toward this person, if they've met (colors the glow). */
  band?: string;
  warmth?: number;
}

interface SkyEdge {
  a: string;
  b: string;
  /** 0..1 — thread weight / how hard it pulls the pair together. */
  strength: number;
  kind?: CharacterLinkKind;
  /** A hearth-thread (player ↔ character) rather than an NPC↔NPC tie. */
  player?: boolean;
}

interface Sky {
  nodes: SkyNode[];
  edges: SkyEdge[];
  /** id → ids it's threaded to (incl. the hearth), for hover-to-light-up. */
  neighbors: Map<string, Set<string>>;
  hearth: { x: number; y: number };
}

/**
 * A tiny deterministic force layout in a normalized 100×100 space: seeded ring
 * starts, then repulsion + edge springs + a gentle pull to center, with the player
 * pinned at the middle. Settled positions are recentered on the hearth and scaled so
 * the farthest star sits near the rim — the town always blooms outward from you.
 */
function layout(nodeIds: string[], edges: SkyEdge[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  nodeIds.forEach((id) => {
    const a = hash01(id) * Math.PI * 2;
    const r = 16 + hash01(`${id}#r`) * 26;
    pos.set(id, { x: 50 + Math.cos(a) * r, y: 50 + Math.sin(a) * r });
  });
  pos.set(PLAYER, { x: 50, y: 50 });

  const all = [...nodeIds, PLAYER];
  const REPULSION = 26;
  const SPRING = 0.05;
  const REST = 15;
  const GRAVITY = 0.016;
  const MAXSTEP = 4;
  const ITERS = 260;

  for (let it = 0; it < ITERS; it += 1) {
    const alpha = 1 - it / ITERS;
    const disp = new Map(nodeIds.map((id) => [id, { x: 0, y: 0 }]));
    // Repulsion between every pair (the hearth pushes too, but never moves).
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const A = pos.get(all[i]!)!;
        const B = pos.get(all[j]!)!;
        let dx = A.x - B.x;
        let dy = A.y - B.y;
        const d2 = Math.max(0.4, dx * dx + dy * dy);
        const d = Math.sqrt(d2);
        const f = (REPULSION / d2) * alpha;
        dx /= d;
        dy /= d;
        const di = disp.get(all[i]!);
        if (di) {
          di.x += dx * f;
          di.y += dy * f;
        }
        const dj = disp.get(all[j]!);
        if (dj) {
          dj.x -= dx * f;
          dj.y -= dy * f;
        }
      }
    }
    // Spring along threads — stronger ties rest closer.
    for (const e of edges) {
      const A = pos.get(e.a);
      const B = pos.get(e.b);
      if (!A || !B) continue;
      let dx = B.x - A.x;
      let dy = B.y - A.y;
      const d = Math.max(0.4, Math.hypot(dx, dy));
      const f = SPRING * (d - REST * (1 - e.strength * 0.5)) * (0.4 + e.strength) * alpha;
      dx /= d;
      dy /= d;
      const da = disp.get(e.a);
      if (da) {
        da.x += dx * f;
        da.y += dy * f;
      }
      const db = disp.get(e.b);
      if (db) {
        db.x -= dx * f;
        db.y -= dy * f;
      }
    }
    // Gravity to center, then step (clamped) — the hearth stays pinned.
    for (const id of nodeIds) {
      const p = pos.get(id)!;
      const d = disp.get(id)!;
      d.x += (50 - p.x) * GRAVITY * alpha;
      d.y += (50 - p.y) * GRAVITY * alpha;
      p.x += Math.max(-MAXSTEP, Math.min(MAXSTEP, d.x));
      p.y += Math.max(-MAXSTEP, Math.min(MAXSTEP, d.y));
    }
  }

  // Recenter on the hearth + scale so the farthest star lands near the rim.
  let maxR = 1;
  for (const id of nodeIds) {
    const p = pos.get(id)!;
    maxR = Math.max(maxR, Math.hypot(p.x - 50, p.y - 50));
  }
  const scale = 41 / maxR;
  for (const id of all) {
    const p = pos.get(id)!;
    p.x = 50 + (p.x - 50) * scale;
    p.y = 50 + (p.y - 50) * scale;
  }
  return pos;
}

/** Weave the NPC↔NPC web and the player's warmth-threads into one star-field. */
function buildSky(
  knownNodes: SocialWebNode[],
  charById: Map<string, Character>,
  playerEdges: ConstellationEdge[],
): Sky {
  // One thread per unordered pair, keeping the strongest kind if several exist.
  const pairs = new Map<string, SkyEdge>();
  for (const n of knownNodes) {
    for (const tie of n.ties) {
      if (!charById.has(tie.targetId)) continue;
      const [a, b] = n.id < tie.targetId ? [n.id, tie.targetId] : [tie.targetId, n.id];
      const key = `${a}|${b}`;
      const strength = KIND_PULL[tie.kind];
      const prev = pairs.get(key);
      if (!prev || strength > prev.strength) pairs.set(key, { a, b, kind: tie.kind, strength });
    }
  }

  const edges: SkyEdge[] = [...pairs.values()];
  const bandOf = new Map<string, ConstellationEdge>();
  for (const pe of playerEdges) {
    if (!charById.has(pe.characterId)) continue;
    bandOf.set(pe.characterId, pe);
    edges.push({ a: PLAYER, b: pe.characterId, player: true, strength: Math.max(0.12, pe.warmth / 100) });
  }

  // Every star that's threaded to something (the connected town + everyone you've met).
  const ids = new Set<string>();
  for (const e of edges) {
    if (e.a !== PLAYER) ids.add(e.a);
    if (e.b !== PLAYER) ids.add(e.b);
  }
  const nodeIds = [...ids].filter((id) => charById.has(id));

  const degree = new Map<string, number>();
  const neighbors = new Map<string, Set<string>>();
  const link = (x: string, y: string) => {
    degree.set(x, (degree.get(x) ?? 0) + 1);
    if (!neighbors.has(x)) neighbors.set(x, new Set());
    neighbors.get(x)!.add(y);
  };
  for (const e of edges) {
    link(e.a, e.b);
    link(e.b, e.a);
  }

  const pos = layout(nodeIds, edges);
  const nodes: SkyNode[] = nodeIds.map((id) => {
    const p = pos.get(id)!;
    const pe = bandOf.get(id);
    return { id, x: p.x, y: p.y, degree: degree.get(id) ?? 0, band: pe?.band, warmth: pe?.warmth };
  });
  return { nodes, edges, neighbors, hearth: pos.get(PLAYER)! };
}

// --- the app ----------------------------------------------------------------

/**
 * The Constellation — the world's relationships as a breathing star-field: you, a
 * hearth at the center, threaded in warm light to everyone you've met, with the
 * town's own web glinting beyond. A List view keeps the searchable, filterable
 * roster; tapping any star (or list chip) opens that person's dossier.
 */
export function ConstellationApp() {
  const { t } = useTranslation(['phone', 'common']);
  const { activeWorldId, creatorMode, dayTick } = useAppData();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [nodes, setNodes] = useState<SocialWebNode[]>([]);
  const [playerEdges, setPlayerEdges] = useState<ConstellationEdge[]>([]);
  const [playerName, setPlayerName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState<'sky' | 'list'>('sky');
  const [query, setQuery] = useState('');
  const [dossierId, setDossierId] = useState<string | null>(null);
  const [activeKinds, setActiveKinds] = useState<Set<CharacterLinkKind>>(
    () => new Set(CHARACTER_LINK_ORDER.filter((k) => k !== NOISE_KIND)),
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    Promise.all([
      api.listCharacters(activeWorldId ?? undefined),
      api.socialWeb(activeWorldId ?? undefined),
      api.constellation(activeWorldId ?? undefined),
    ])
      .then(([chars, web, cst]) => {
        if (cancelled) return;
        setCharacters(chars);
        setNodes(web.nodes);
        setPlayerEdges(cst.edges);
        setPlayerName(cst.playerName);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorldId, reloadKey, dayTick]);

  const charById = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);

  const knownNodes = useMemo(
    () =>
      nodes
        .filter((n) => charById.has(n.id))
        .map((n) => ({ id: n.id, ties: n.ties.filter((tie) => charById.has(tie.targetId)) }))
        .filter((n) => n.ties.length > 0),
    [nodes, charById],
  );
  const knownPlayerEdges = useMemo(
    () => playerEdges.filter((e) => charById.has(e.characterId)),
    [playerEdges, charById],
  );
  const edges = useMemo(() => countEdges(knownNodes), [knownNodes]);
  const sky = useMemo(() => buildSky(knownNodes, charById, knownPlayerEdges), [knownNodes, charById, knownPlayerEdges]);

  const toggleKind = (k: CharacterLinkKind) =>
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const legend = CHARACTER_LINK_ORDER.filter((k) => k !== NOISE_KIND && (edges.byKind.get(k) ?? 0) > 0).map((k) => ({
    kind: k,
    count: edges.byKind.get(k) ?? 0,
  }));

  const cards = useMemo(() => {
    const q = query.trim().toLowerCase();
    return knownNodes
      .map((n) => {
        const character = charById.get(n.id)!;
        const ties = n.ties.filter((tie) => activeKinds.has(tie.kind));
        return ties.length ? { character, ties } : null;
      })
      .filter((c): c is { character: Character; ties: SocialTie[] } => c !== null)
      .filter((c) => {
        if (!q) return true;
        if (c.character.name.toLowerCase().includes(q)) return true;
        return c.ties.some((tie) => (charById.get(tie.targetId)?.name ?? '').toLowerCase().includes(q));
      })
      .sort((a, b) => b.ties.length - a.ties.length || a.character.name.localeCompare(b.character.name));
  }, [knownNodes, charById, activeKinds, query]);

  const acqCount = edges.byKind.get(NOISE_KIND) ?? 0;
  const showingAcq = activeKinds.has(NOISE_KIND);
  const isEmpty = knownNodes.length === 0 && sky.nodes.length === 0;
  const hasGraph = !loading && !error && !isEmpty;

  if (dossierId) {
    return <DossierScreen id={dossierId} charById={charById} onBack={() => setDossierId(null)} onOpen={setDossierId} />;
  }

  return (
    <div className="phone-app">
      <PhoneAppBar
        title={t('constellation.title')}
        kicker={t('constellation.kicker')}
        icon="constellation"
        right={
          hasGraph ? (
            <div className="cst-seg" role="tablist" aria-label={t('constellation.title')}>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'sky'}
                className={view === 'sky' ? 'is-on' : ''}
                onClick={() => setView('sky')}
                aria-label={t('constellation.viewSkyLabel')}
              >
                {t('constellation.viewSky')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'list'}
                className={view === 'list' ? 'is-on' : ''}
                onClick={() => setView('list')}
                aria-label={t('constellation.viewListLabel')}
              >
                {t('constellation.viewList')}
              </button>
            </div>
          ) : undefined
        }
      />

      {loading ? (
        <div className="cst-app">
          <Spinner />
        </div>
      ) : error ? (
        <div className="cst-app">
          <div className="sw-error">
            <Banner kind="error">{t('constellation.loadError', { error })}</Banner>
            <button type="button" className="btn ghost sm" onClick={() => setReloadKey((k) => k + 1)}>
              <Icon name="refresh" size={14} /> {t('constellation.tryAgain')}
            </button>
          </div>
        </div>
      ) : isEmpty ? (
        <div className="cst-app">
          <Empty icon={<Icon name="constellation" size={36} />} title={t('constellation.emptyTitle')}>
            <p className="muted">{creatorMode ? t('constellation.emptyCreator') : t('constellation.emptyPlayer')}</p>
          </Empty>
        </div>
      ) : view === 'sky' ? (
        <Sky sky={sky} charById={charById} playerName={playerName} onOpen={setDossierId} />
      ) : (
        <div className="social-app">
          <header className="sw-head">
            <div className="sw-summary">
              <span className="sw-stat">
                <b>{knownNodes.length}</b> {t('constellation.peopleCount', { count: knownNodes.length })}
              </span>
              <span className="sw-stat-dot">·</span>
              <span className="sw-stat">
                <b>{edges.total}</b> {t('constellation.tieCount', { count: edges.total })}
              </span>
            </div>
            {legend.length > 0 && (
              <div className="sw-legend">
                {legend.map(({ kind, count }) => (
                  <button
                    key={kind}
                    type="button"
                    className={`sw-chip kind-${kind}${activeKinds.has(kind) ? '' : ' is-off'}`}
                    onClick={() => toggleKind(kind)}
                    aria-pressed={activeKinds.has(kind)}
                    title={t('constellation.chipTitle', {
                      action: activeKinds.has(kind) ? t('constellation.hide') : t('constellation.show'),
                      kind: characterLinkLabel(kind).toLowerCase(),
                    })}
                  >
                    <span className="sw-chip-icon">
                      <Icon name={KIND_ICON[kind]} size={14} />
                    </span>
                    <span className="sw-chip-label">{characterLinkLabel(kind)}</span>
                    <span className="sw-chip-count">{count}</span>
                  </button>
                ))}
              </div>
            )}
          </header>

          <label className="sw-search">
            <Icon name="search" size={15} />
            <input
              value={query}
              placeholder={t('constellation.searchPlaceholder')}
              onChange={(e) => setQuery(e.target.value)}
              aria-label={t('constellation.searchLabel')}
            />
            {query && (
              <button
                type="button"
                className="sw-search-clear"
                onClick={() => setQuery('')}
                aria-label={t('constellation.clearSearch')}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </label>

          {cards.length === 0 ? (
            <div className="sw-none">{t('constellation.noMatch')}</div>
          ) : (
            <div className="sw-list">
              {cards.map(({ character, ties }) => (
                <PersonCard key={character.id} character={character} ties={ties} charById={charById} onOpen={setDossierId} />
              ))}
            </div>
          )}

          {acqCount > 0 && (
            <button type="button" className="sw-acq-toggle" onClick={() => toggleKind(NOISE_KIND)} aria-pressed={showingAcq}>
              <Icon name="acquaintance" size={14} />{' '}
              {t('constellation.acqToggle', { action: showingAcq ? t('constellation.hide') : t('constellation.show'), count: acqCount })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// --- the sky view -----------------------------------------------------------

/** The star-field: SVG threads beneath HTML stars (so portraits + glow style and
 *  hit-test as normal elements). Hovering a star lights its threads + neighbours and
 *  dims the rest; tapping opens the dossier. */
function Sky({
  sky,
  charById,
  playerName,
  onOpen,
}: {
  sky: Sky;
  charById: Map<string, Character>;
  playerName: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation(['phone', 'common']);
  // A star is SELECTED by a tap (persistent — works on touch, where there's no hover)
  // and HOVERED by a mouse (a transient desktop preview). Either lights its threads +
  // neighbours; tapping a star that's already selected opens its dossier.
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const active = hovered ?? selected;
  const activeSet = active ? sky.neighbors.get(active) ?? new Set<string>() : null;
  const selectedName = selected ? charById.get(selected)?.name : undefined;

  return (
    // Tapping the empty sky deselects (star taps stopPropagation so they don't bubble).
    <div className={`cst-stage${active ? ' is-focusing' : ''}`} onClick={() => setSelected(null)}>
      <div className="cst-skyglow" aria-hidden />
      <div className="cst-stars" aria-hidden>
        {BG_STARS.map((s, i) => (
          <span
            key={i}
            className="cst-bgstar"
            style={
              {
                left: `${s.x.toFixed(2)}%`,
                top: `${s.y.toFixed(2)}%`,
                '--sz': `${s.size.toFixed(2)}px`,
                '--d': `${s.dur.toFixed(2)}s`,
                '--delay': `${s.delay.toFixed(2)}s`,
                '--b': s.bright.toFixed(2),
              } as CSSProperties
            }
          />
        ))}
      </div>
      <svg className="cst-threads" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {sky.edges.map((e, i) => {
          const A = e.a === PLAYER ? sky.hearth : sky.nodes.find((n) => n.id === e.a);
          const B = e.b === PLAYER ? sky.hearth : sky.nodes.find((n) => n.id === e.b);
          if (!A || !B) return null;
          const isLit = active != null && (e.a === active || e.b === active);
          const cls = e.player ? 'is-player' : `kind-${e.kind}`;
          return (
            <line
              key={i}
              x1={A.x}
              y1={A.y}
              x2={B.x}
              y2={B.y}
              vectorEffect="non-scaling-stroke"
              className={`cst-thread ${cls}${isLit ? ' is-lit' : ''}`}
              style={{ '--str': e.strength } as CSSProperties}
            />
          );
        })}
      </svg>

      {/* The hearth — you, at the center of it all. */}
      <div
        className="cst-star is-hearth"
        style={{ left: `${sky.hearth.x}%`, top: `${sky.hearth.y}%` }}
        title={playerName || t('constellation.you')}
      >
        <span className="cst-star-glow" aria-hidden />
        <span className="cst-hearth-flame" aria-hidden>
          <Icon name="remember" size={18} />
        </span>
        <span className="cst-star-name is-you">{playerName || t('constellation.you')}</span>
      </div>

      {sky.nodes.map((n) => {
        const c = charById.get(n.id);
        if (!c) return null;
        const size = 30 + Math.min(6, n.degree) * 4;
        const dim = active != null && active !== n.id && !activeSet?.has(n.id);
        const isLit = active != null && (active === n.id || activeSet?.has(n.id));
        const isSel = selected === n.id;
        return (
          <button
            type="button"
            key={n.id}
            className={`cst-star${n.band ? ` band-${n.band}` : ' is-distant'}${dim ? ' is-dim' : ''}${isLit ? ' is-lit' : ''}${isSel ? ' is-selected' : ''}`}
            style={
              {
                left: `${n.x}%`,
                top: `${n.y}%`,
                '--r': `${size}px`,
                '--tw': `${(hash01(n.id) * 6).toFixed(2)}s`,
              } as CSSProperties
            }
            onClick={(e) => {
              e.stopPropagation();
              // First tap traces their ties; a second tap on the same star opens it —
              // so the map is fully usable by touch, where there's no hover to preview with.
              if (selected === n.id) onOpen(n.id);
              else setSelected(n.id);
            }}
            onMouseEnter={() => setHovered(n.id)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(n.id)}
            onBlur={() => setHovered(null)}
            title={t('constellation.openProfile', { name: c.name })}
          >
            <span className="cst-star-glow" aria-hidden />
            <span className="cst-star-ava">
              <Portrait character={c} className="round" />
            </span>
            <span className="cst-star-name">{c.name}</span>
          </button>
        );
      })}

      <p className="cst-hint">
        {selectedName ? t('constellation.mapHintOpen', { name: selectedName }) : t('constellation.mapHint')}
      </p>
    </div>
  );
}

// --- shared list helpers ----------------------------------------------------

function tieTitle(owner: string, peer: string, kind: CharacterLinkKind, tie: SocialTie, tt: TFn): string {
  const kindLabel = characterLinkLabel(kind);
  if (tie.incoming) return tt('constellation.tieIncoming', { peer, owner, label: kindLabel.toLowerCase() });
  if (tie.derived) return tt('constellation.tieDerived', { peer, kind: kindLabel });
  return tt('constellation.tiePlain', { peer, kind: kindLabel });
}

/** Count the web's UNIQUE connections (an unordered pair + kind). */
function countEdges(nodes: SocialWebNode[]): { total: number; byKind: Map<CharacterLinkKind, number> } {
  const seen = new Set<string>();
  const byKind = new Map<CharacterLinkKind, number>();
  for (const n of nodes) {
    for (const tie of n.ties) {
      const [x, y] = n.id < tie.targetId ? [n.id, tie.targetId] : [tie.targetId, n.id];
      const key = `${x}|${y}|${tie.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      byKind.set(tie.kind, (byKind.get(tie.kind) ?? 0) + 1);
    }
  }
  return { total: seen.size, byKind };
}

/** One person's row in the List view: portrait + name, then their ties grouped by
 *  kind (bonds first). Tapping the header (or any peer chip) opens that dossier. */
function PersonCard({
  character,
  ties,
  charById,
  onOpen,
}: {
  character: Character;
  ties: SocialTie[];
  charById: Map<string, Character>;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation(['phone', 'common']);
  const groups = CHARACTER_LINK_ORDER.map((kind) => ({
    kind,
    peers: ties
      .filter((tie) => tie.kind === kind)
      .sort((a, b) => (charById.get(a.targetId)?.name ?? '').localeCompare(charById.get(b.targetId)?.name ?? '')),
  })).filter((g) => g.peers.length > 0);

  return (
    <article className="sw-person">
      <button
        type="button"
        className="sw-person-head"
        onClick={() => onOpen(character.id)}
        title={t('constellation.openProfile', { name: character.name })}
      >
        <span className="sw-person-portrait">
          <Portrait character={character} className="round" />
        </span>
        <span className="sw-person-name">{character.name}</span>
        <span className="sw-person-count">{t('constellation.tiesCount', { count: ties.length })}</span>
      </button>
      <div className="sw-groups">
        {groups.map(({ kind, peers }) => (
          <div className={`sw-group kind-${kind}`} key={kind}>
            <span className="sw-group-icon" title={characterLinkLabel(kind)} aria-label={characterLinkLabel(kind)}>
              <Icon name={KIND_ICON[kind]} size={15} />
            </span>
            <div className="sw-peers">
              {peers.map((tie) => {
                const peer = charById.get(tie.targetId);
                const peerName = peer?.name ?? t('constellation.someone');
                return (
                  <button
                    type="button"
                    key={tie.targetId}
                    className={`sw-peer${tie.derived ? ' is-derived' : ''}${tie.incoming ? ' is-incoming' : ''}`}
                    title={tieTitle(character.name, peerName, kind, tie, t as unknown as TFn)}
                    onClick={() => onOpen(tie.targetId)}
                  >
                    {tie.incoming && (
                      <span className="sw-peer-dir" aria-hidden>
                        ‹
                      </span>
                    )}
                    {peer && (
                      <span className="sw-peer-ava">
                        <Portrait character={peer} className="round" />
                      </span>
                    )}
                    <span className="sw-peer-name">{peerName}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}

// --- the dossier (a full screen reached by tapping a star or chip) ----------

function fidelityPhrase(fidelity: number, tt: TFn): string {
  if (fidelity >= 70) return tt('constellation.dossier.fidelityClear');
  if (fidelity >= 40) return tt('constellation.dossier.fidelityFuzzy');
  return tt('constellation.dossier.fidelityGarbled');
}

/**
 * A person's dossier as a full phone screen (with a back button) — who they are,
 * where you stand, their circle, their remembered recent life, and what's reached
 * them about you through the grapevine. Tapping a tie re-points the screen.
 */
function DossierScreen({
  id,
  charById,
  onBack,
  onOpen,
}: {
  id: string;
  charById: Map<string, Character>;
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation(['phone', 'common']);
  const [data, setData] = useState<CharacterDossier | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setData(null);
    api
      .dossier(id)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const portraitFor = (cid: string, name: string, assetId: string | null) =>
    charById.get(cid) ?? { name, portraitAssetId: assetId, expressionAssets: {} };

  return (
    <div className="phone-app">
      <PhoneAppBar
        title={data?.name ?? t('constellation.title')}
        kicker={t('constellation.dossier.kicker')}
        icon="constellation"
        left={
          <button
            className="btn sm ghost pbar-iconbtn"
            onClick={onBack}
            aria-label={t('common:back')}
            title={t('common:back')}
          >
            <Icon name="chevronDown" size={18} />
          </button>
        }
      />
      <div className="social-app">
        {loading ? (
          <Spinner />
        ) : error ? (
          <div className="sw-error">
            <Banner kind="error">{t('constellation.dossier.loadError', { error })}</Banner>
            <button type="button" className="btn ghost sm" onClick={onBack}>
              <Icon name="chevronDown" size={14} /> {t('common:back')}
            </button>
          </div>
        ) : data ? (
          <div className="sw-dossier">
            <header className="swd-head">
              <span className="swd-portrait">
                <Portrait character={portraitFor(data.characterId, data.name, data.portraitAssetId)} className="round" />
              </span>
              <div className="swd-id">
                <h3 className="swd-name">{data.name}</h3>
                {data.shortDescription && <p className="swd-desc">{data.shortDescription}</p>}
                {data.standing ? (
                  <div className="swd-standing">
                    <span className={`swd-band band-${data.standing.warmthBand}`}>{warmthBandLabel(data.standing.warmthBand)}</span>
                    {data.standing.status !== 'none' && (
                      <>
                        <span className="swd-dot" aria-hidden>
                          ·
                        </span>
                        <span className="swd-status">{relationshipStatusLabel(data.standing.status)}</span>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="swd-notmet">{t('constellation.dossier.notMet')}</p>
                )}
              </div>
            </header>

            {data.standing && data.standing.flags.length > 0 && (
              <div className="swd-flags">
                {data.standing.flags.map((f) => (
                  <span className="swd-flag" key={f}>
                    {f}
                  </span>
                ))}
              </div>
            )}

            <section className="swd-section">
              <h4 className="swd-section-head">{t('constellation.dossier.circleHead')}</h4>
              {data.ties.length === 0 ? (
                <p className="swd-empty">{t('constellation.dossier.noTies')}</p>
              ) : (
                <ul className="swd-ties">
                  {data.ties.map((tie) => (
                    <li key={tie.targetId}>
                      <button
                        type="button"
                        className="swd-tie"
                        onClick={() => onOpen(tie.targetId)}
                        title={t('constellation.openProfile', { name: tie.name })}
                      >
                        <span className="swd-tie-ava">
                          <Portrait character={portraitFor(tie.targetId, tie.name, tie.portraitAssetId)} className="round" />
                        </span>
                        <span className="swd-tie-body">
                          <span className="swd-tie-name">{tie.name}</span>
                          <span className={`swd-tie-kind kind-${tie.kind}`}>
                            <Icon name={KIND_ICON[tie.kind]} size={12} /> {characterLinkLabel(tie.kind)}
                            {tie.incoming
                              ? ` · ${t('constellation.dossier.incoming')}`
                              : tie.derived
                                ? ` · ${t('constellation.dossier.derived')}`
                                : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="swd-section">
              <h4 className="swd-section-head">{t('constellation.dossier.lifeHead')}</h4>
              {data.timeline.length === 0 ? (
                <p className="swd-empty">{t('constellation.dossier.noTimeline')}</p>
              ) : (
                <ul className="swd-timeline">
                  {data.timeline.map((e) => (
                    <li key={e.id} className={`swd-tl swd-tl-${e.kind}`}>
                      <span className="swd-tl-dot" aria-hidden />
                      <span className="swd-tl-text">
                        {e.text}
                        {e.withName && <span className="swd-tl-with"> · {t('constellation.dossier.with', { name: e.withName })}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {data.heardAboutYou.length > 0 && (
              <section className="swd-section">
                <h4 className="swd-section-head">{t('constellation.dossier.heardHead')}</h4>
                <ul className="swd-heard">
                  {data.heardAboutYou.map((h, i) => (
                    <li className="swd-heard-item" key={i}>
                      <span className="swd-heard-claim">“{h.claim}”</span>
                      <span className="swd-heard-meta">
                        {fidelityPhrase(h.fidelity, t as unknown as TFn)}
                        {h.fromName ? ` · ${t('constellation.dossier.heardFrom', { name: h.fromName })}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
