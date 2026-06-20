import { useEffect, useMemo, useState } from 'react';
import {
  CHARACTER_LINK_LABELS,
  CHARACTER_LINK_ORDER,
  type Character,
  type CharacterLinkKind,
  type SocialTie,
  type SocialWebNode,
} from '@dsim/shared';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import { Icon, type IconName } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Portrait } from '../Portrait';
import { Banner, Empty, Spinner } from '../ui';
import './phone-life.css';

/** "Crossed paths" is low-signal noise next to real bonds, so it's collapsed
 *  until the player opts in (the footer toggle). */
const NOISE_KIND: CharacterLinkKind = 'acquaintance';

/** Each relationship kind → a monochrome lamplit icon (tints via currentColor). */
const KIND_ICON: Record<CharacterLinkKind, IconName> = {
  partner: 'affection',
  family: 'home',
  friend: 'people',
  ex: 'breakup',
  rival: 'rival',
  acquaintance: 'acquaintance',
};

/** A card-owner's read of a tie, for the chip tooltip (touch has no hover, but
 *  this still surfaces the full peer name when a chip truncates). */
function tieTitle(owner: string, peer: string, kind: CharacterLinkKind, t: SocialTie): string {
  const label = CHARACTER_LINK_LABELS[kind].toLowerCase();
  if (t.incoming) return `${peer} considers ${owner} a ${label}`;
  if (t.derived) return `${peer} · ${CHARACTER_LINK_LABELS[kind]} (grew during play)`;
  return `${peer} · ${CHARACTER_LINK_LABELS[kind]}`;
}

/** Count the web's UNIQUE connections (an unordered pair + kind), so a mutual
 *  bond reads as one tie rather than two directed half-edges. Operates on the
 *  already-known-filtered node set, so the tally matches what the cards render. */
function countEdges(nodes: SocialWebNode[]): { total: number; byKind: Map<CharacterLinkKind, number> } {
  const seen = new Set<string>();
  const byKind = new Map<CharacterLinkKind, number>();
  for (const n of nodes) {
    for (const t of n.ties) {
      const [x, y] = n.id < t.targetId ? [n.id, t.targetId] : [t.targetId, n.id];
      const key = `${x}|${y}|${t.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      byKind.set(t.kind, (byKind.get(t.kind) ?? 0) + 1);
    }
  }
  return { total: seen.size, byKind };
}

/** Read-only view of the world's social web (authored ties + ties the world-sim
 *  has formed during play), grouped by person and built to stay legible as the
 *  web fills in: a summary header, kind filters, search, and collapsed noise. */
export function SocialApp() {
  const { activeWorldId, creatorMode, dayTick } = useAppData();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [nodes, setNodes] = useState<SocialWebNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  // Every meaningful bond is shown by default; "crossed paths" starts collapsed.
  const [activeKinds, setActiveKinds] = useState<Set<CharacterLinkKind>>(
    () => new Set(CHARACTER_LINK_ORDER.filter((k) => k !== NOISE_KIND)),
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    // The web (ties) is the primary data; the roster supplies names + portraits.
    // Both are needed to render, so a failure of either is a real error — not a
    // silently-empty web.
    Promise.all([
      api.listCharacters(activeWorldId ?? undefined),
      api.socialWeb(activeWorldId ?? undefined),
    ])
      .then(([chars, web]) => {
        if (cancelled) return;
        setCharacters(chars);
        setNodes(web.nodes);
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

  // Keep only people and ties whose endpoints are in the roster, so the tally,
  // legend, and cards are all computed from one consistent set.
  const knownNodes = useMemo(
    () =>
      nodes
        .filter((n) => charById.has(n.id))
        .map((n) => ({ id: n.id, ties: n.ties.filter((t) => charById.has(t.targetId)) }))
        .filter((n) => n.ties.length > 0),
    [nodes, charById],
  );
  const edges = useMemo(() => countEdges(knownNodes), [knownNodes]);

  const toggleKind = (k: CharacterLinkKind) =>
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  // Legend chips double as filters — bonds only; acquaintances live in the footer.
  const legend = CHARACTER_LINK_ORDER.filter((k) => k !== NOISE_KIND && (edges.byKind.get(k) ?? 0) > 0).map((k) => ({
    kind: k,
    count: edges.byKind.get(k) ?? 0,
  }));

  // People to show: those with a tie of an active kind that also matches the
  // search (by their name or any of their connections' names).
  const cards = useMemo(() => {
    const q = query.trim().toLowerCase();
    return knownNodes
      .map((n) => {
        const character = charById.get(n.id)!;
        const ties = n.ties.filter((t) => activeKinds.has(t.kind));
        return ties.length ? { character, ties } : null;
      })
      .filter((c): c is { character: Character; ties: SocialTie[] } => c !== null)
      .filter((c) => {
        if (!q) return true;
        if (c.character.name.toLowerCase().includes(q)) return true;
        return c.ties.some((t) => (charById.get(t.targetId)?.name ?? '').toLowerCase().includes(q));
      })
      .sort((a, b) => b.ties.length - a.ties.length || a.character.name.localeCompare(b.character.name));
  }, [knownNodes, charById, activeKinds, query]);

  const acqCount = edges.byKind.get(NOISE_KIND) ?? 0;
  const showingAcq = activeKinds.has(NOISE_KIND);

  return (
    <div className="phone-app">
      <PhoneAppBar title="Social" kicker="The web" icon="social" />
      <div className="social-app">
        {loading ? (
          <Spinner />
        ) : error ? (
          <div className="sw-error">
            <Banner kind="error">Couldn't load the web. {error}</Banner>
            <button type="button" className="btn ghost sm" onClick={() => setReloadKey((k) => k + 1)}>
              <Icon name="refresh" size={14} /> Try again
            </button>
          </div>
        ) : knownNodes.length === 0 ? (
          <Empty icon={<Icon name="social" size={36} />} title="No connections yet">
            {creatorMode ? (
              <p className="muted">Add connections between characters in the character editor to map the social web.</p>
            ) : (
              <p className="muted">As people's stories unfold, their connections will appear here.</p>
            )}
          </Empty>
        ) : (
          <>
            <header className="sw-head">
              <div className="sw-summary">
                <span className="sw-stat">
                  <b>{knownNodes.length}</b> {knownNodes.length === 1 ? 'person' : 'people'}
                </span>
                <span className="sw-stat-dot">·</span>
                <span className="sw-stat">
                  <b>{edges.total}</b> {edges.total === 1 ? 'tie' : 'ties'}
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
                      title={`${activeKinds.has(kind) ? 'Hide' : 'Show'} ${CHARACTER_LINK_LABELS[kind].toLowerCase()} ties`}
                    >
                      <span className="sw-chip-icon">
                        <Icon name={KIND_ICON[kind]} size={14} />
                      </span>
                      <span className="sw-chip-label">{CHARACTER_LINK_LABELS[kind]}</span>
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
                placeholder="Search people…"
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search people"
              />
              {query && (
                <button type="button" className="sw-search-clear" onClick={() => setQuery('')} aria-label="Clear search">
                  <Icon name="close" size={14} />
                </button>
              )}
            </label>

            {cards.length === 0 ? (
              <div className="sw-none">No connections match.</div>
            ) : (
              <div className="sw-list">
                {cards.map(({ character, ties }) => (
                  <PersonCard key={character.id} character={character} ties={ties} charById={charById} />
                ))}
              </div>
            )}

            {acqCount > 0 && (
              <button
                type="button"
                className="sw-acq-toggle"
                onClick={() => toggleKind(NOISE_KIND)}
                aria-pressed={showingAcq}
              >
                <Icon name="acquaintance" size={14} />
                {showingAcq ? 'Hide' : 'Show'} {acqCount} {acqCount === 1 ? 'acquaintance' : 'acquaintances'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One person's row: portrait + name, then their ties grouped by kind (bonds
 *  first), each kind a tinted icon with that kind's people as avatar chips. */
function PersonCard({
  character,
  ties,
  charById,
}: {
  character: Character;
  ties: SocialTie[];
  charById: Map<string, Character>;
}) {
  const groups = CHARACTER_LINK_ORDER.map((kind) => ({
    kind,
    peers: ties
      .filter((t) => t.kind === kind)
      .sort((a, b) => (charById.get(a.targetId)?.name ?? '').localeCompare(charById.get(b.targetId)?.name ?? '')),
  })).filter((g) => g.peers.length > 0);

  return (
    <article className="sw-person">
      <div className="sw-person-head">
        <span className="sw-person-portrait">
          <Portrait character={character} className="round" />
        </span>
        <span className="sw-person-name">{character.name}</span>
        <span className="sw-person-count">
          {ties.length} {ties.length === 1 ? 'tie' : 'ties'}
        </span>
      </div>
      <div className="sw-groups">
        {groups.map(({ kind, peers }) => (
          <div className={`sw-group kind-${kind}`} key={kind}>
            <span className="sw-group-icon" title={CHARACTER_LINK_LABELS[kind]} aria-label={CHARACTER_LINK_LABELS[kind]}>
              <Icon name={KIND_ICON[kind]} size={15} />
            </span>
            <div className="sw-peers">
              {peers.map((t) => {
                const peer = charById.get(t.targetId);
                const peerName = peer?.name ?? 'someone';
                return (
                  <span
                    key={t.targetId}
                    className={`sw-peer${t.derived ? ' is-derived' : ''}${t.incoming ? ' is-incoming' : ''}`}
                    title={tieTitle(character.name, peerName, kind, t)}
                  >
                    {t.incoming && (
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
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </article>
  );
}
