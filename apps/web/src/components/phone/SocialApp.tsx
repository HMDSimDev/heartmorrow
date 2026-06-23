import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CHARACTER_LINK_ORDER,
  type Character,
  type CharacterDossier,
  type CharacterLinkKind,
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

type TFn = (key: string, opts?: Record<string, unknown>) => string;

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
  crush: 'remember',
  roommate: 'property',
  coworker: 'work',
  classmate: 'book',
  neighbor: 'location',
  mentor: 'star',
  acquaintance: 'acquaintance',
};

/** A card-owner's read of a tie, for the chip tooltip (touch has no hover, but
 *  this still surfaces the full peer name when a chip truncates). */
function tieTitle(owner: string, peer: string, kind: CharacterLinkKind, tie: SocialTie, tt: TFn): string {
  const kindLabel = characterLinkLabel(kind);
  if (tie.incoming) return tt('social.tieIncoming', { peer, owner, label: kindLabel.toLowerCase() });
  if (tie.derived) return tt('social.tieDerived', { peer, kind: kindLabel });
  return tt('social.tiePlain', { peer, kind: kindLabel });
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
  const { t } = useTranslation(['phone', 'common']);
  const { activeWorldId, creatorMode, dayTick } = useAppData();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [nodes, setNodes] = useState<SocialWebNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  // The person whose dossier sheet is open (tap a card or a tie chip to open it).
  const [dossierId, setDossierId] = useState<string | null>(null);
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

  // Tapping a person opens their dossier as a full screen (with a back button),
  // replacing the list — not a popup. Tapping a tie inside re-points the screen.
  if (dossierId) {
    return (
      <DossierScreen
        id={dossierId}
        charById={charById}
        onBack={() => setDossierId(null)}
        onOpen={setDossierId}
      />
    );
  }

  return (
    <div className="phone-app">
      <PhoneAppBar title={t('social.title')} kicker={t('social.kicker')} icon="social" />
      <div className="social-app">
        {loading ? (
          <Spinner />
        ) : error ? (
          <div className="sw-error">
            <Banner kind="error">{t('social.loadError', { error })}</Banner>
            <button type="button" className="btn ghost sm" onClick={() => setReloadKey((k) => k + 1)}>
              <Icon name="refresh" size={14} /> {t('social.tryAgain')}
            </button>
          </div>
        ) : knownNodes.length === 0 ? (
          <Empty icon={<Icon name="social" size={36} />} title={t('social.emptyTitle')}>
            {creatorMode ? (
              <p className="muted">{t('social.emptyCreator')}</p>
            ) : (
              <p className="muted">{t('social.emptyPlayer')}</p>
            )}
          </Empty>
        ) : (
          <>
            <header className="sw-head">
              <div className="sw-summary">
                <span className="sw-stat">
                  <b>{knownNodes.length}</b> {t('social.peopleCount', { count: knownNodes.length })}
                </span>
                <span className="sw-stat-dot">·</span>
                <span className="sw-stat">
                  <b>{edges.total}</b> {t('social.tieCount', { count: edges.total })}
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
                      title={t('social.chipTitle', { action: activeKinds.has(kind) ? t('social.hide') : t('social.show'), kind: characterLinkLabel(kind).toLowerCase() })}
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
                placeholder={t('social.searchPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('social.searchLabel')}
              />
              {query && (
                <button type="button" className="sw-search-clear" onClick={() => setQuery('')} aria-label={t('social.clearSearch')}>
                  <Icon name="close" size={14} />
                </button>
              )}
            </label>

            {cards.length === 0 ? (
              <div className="sw-none">{t('social.noMatch')}</div>
            ) : (
              <div className="sw-list">
                {cards.map(({ character, ties }) => (
                  <PersonCard key={character.id} character={character} ties={ties} charById={charById} onOpen={setDossierId} />
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
                {' '}{t('social.acqToggle', { action: showingAcq ? t('social.hide') : t('social.show'), count: acqCount })}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One person's row: portrait + name, then their ties grouped by kind (bonds
 *  first), each kind a tinted icon with that kind's people as avatar chips. Tapping
 *  the header (or any peer chip) opens that person's dossier. */
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
      .filter((t) => t.kind === kind)
      .sort((a, b) => (charById.get(a.targetId)?.name ?? '').localeCompare(charById.get(b.targetId)?.name ?? '')),
  })).filter((g) => g.peers.length > 0);

  return (
    <article className="sw-person">
      <button
        type="button"
        className="sw-person-head"
        onClick={() => onOpen(character.id)}
        title={t('social.openProfile', { name: character.name })}
      >
        <span className="sw-person-portrait">
          <Portrait character={character} className="round" />
        </span>
        <span className="sw-person-name">{character.name}</span>
        <span className="sw-person-count">
          {t('social.tiesCount', { count: ties.length })}
        </span>
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
                const peerName = peer?.name ?? t('social.someone');
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

/** A confidence phrase for a piece of grapevine word, by its surviving fidelity. */
function fidelityPhrase(fidelity: number, tt: TFn): string {
  if (fidelity >= 70) return tt('social.dossier.fidelityClear');
  if (fidelity >= 40) return tt('social.dossier.fidelityFuzzy');
  return tt('social.dossier.fidelityGarbled');
}

/**
 * A person's dossier as a full phone screen (with a back button) — who they are,
 * where you stand, their circle, their remembered recent life, and what's reached
 * them about you through the grapevine. Fetches the composed dossier read-model;
 * tapping a tie re-points the screen at that person, so you can walk the web.
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

  // Prefer the full roster character (carries expression assets) for the portrait;
  // fall back to the dossier's name + portrait id for anyone not in the loaded set.
  const portraitFor = (cid: string, name: string, assetId: string | null) =>
    charById.get(cid) ?? { name, portraitAssetId: assetId, expressionAssets: {} };

  return (
    <div className="phone-app">
      <PhoneAppBar
        title={data?.name ?? t('social.title')}
        kicker={t('social.dossier.kicker')}
        icon="social"
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
            <Banner kind="error">{t('social.dossier.loadError', { error })}</Banner>
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
                    <span className={`swd-band band-${data.standing.warmthBand}`}>
                      {warmthBandLabel(data.standing.warmthBand)}
                    </span>
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
                  <p className="swd-notmet">{t('social.dossier.notMet')}</p>
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
              <h4 className="swd-section-head">{t('social.dossier.circleHead')}</h4>
              {data.ties.length === 0 ? (
                <p className="swd-empty">{t('social.dossier.noTies')}</p>
              ) : (
                <ul className="swd-ties">
                  {data.ties.map((tie) => (
                    <li key={tie.targetId}>
                      <button
                        type="button"
                        className="swd-tie"
                        onClick={() => onOpen(tie.targetId)}
                        title={t('social.openProfile', { name: tie.name })}
                      >
                        <span className="swd-tie-ava">
                          <Portrait
                            character={portraitFor(tie.targetId, tie.name, tie.portraitAssetId)}
                            className="round"
                          />
                        </span>
                        <span className="swd-tie-body">
                          <span className="swd-tie-name">{tie.name}</span>
                          <span className={`swd-tie-kind kind-${tie.kind}`}>
                            <Icon name={KIND_ICON[tie.kind]} size={12} /> {characterLinkLabel(tie.kind)}
                            {tie.incoming
                              ? ` · ${t('social.dossier.incoming')}`
                              : tie.derived
                                ? ` · ${t('social.dossier.derived')}`
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
              <h4 className="swd-section-head">{t('social.dossier.lifeHead')}</h4>
              {data.timeline.length === 0 ? (
                <p className="swd-empty">{t('social.dossier.noTimeline')}</p>
              ) : (
                <ul className="swd-timeline">
                  {data.timeline.map((e) => (
                    <li key={e.id} className={`swd-tl swd-tl-${e.kind}`}>
                      <span className="swd-tl-dot" aria-hidden />
                      <span className="swd-tl-text">
                        {e.text}
                        {e.withName && (
                          <span className="swd-tl-with"> · {t('social.dossier.with', { name: e.withName })}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {data.heardAboutYou.length > 0 && (
              <section className="swd-section">
                <h4 className="swd-section-head">{t('social.dossier.heardHead')}</h4>
                <ul className="swd-heard">
                  {data.heardAboutYou.map((h, i) => (
                    <li className="swd-heard-item" key={i}>
                      <span className="swd-heard-claim">“{h.claim}”</span>
                      <span className="swd-heard-meta">
                        {fidelityPhrase(h.fidelity, t as unknown as TFn)}
                        {h.fromName ? ` · ${t('social.dossier.heardFrom', { name: h.fromName })}` : ''}
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
