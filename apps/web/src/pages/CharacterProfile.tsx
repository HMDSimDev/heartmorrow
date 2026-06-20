import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  effectiveDatingStats,
  isInternalFlagKey,
  humanizeStoryFlag,
  relationshipStage,
  currentStatus,
  isBrokenUp,
  isMemorialized,
  isOnTheRocks,
  RECONCILE_COOLDOWN_DAYS,
  RELATIONSHIP_STATUS_LABELS,
  RELATIONSHIP_STYLE_LABELS,
  CHARACTER_LINK_LABELS,
  GENDER_LABELS,
  SEXUALITY_LABELS,
  DAYS_OF_WEEK,
  WEATHER_LABELS,
  WEATHER_ICONS,
  listActiveBuffs,
  DATING_STAT_LABELS,
  type CharacterMemory,
  type ConversationSession,
  type Relationship,
} from '@dsim/shared';
import { api } from '../lib/api';
import { useAsync, errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { Portrait } from '../components/Portrait';
import { Icon } from '../components/Icon';
import { CrisisResources } from '../components/CrisisResources';
import { DatingBars, RelationshipBars } from '../components/StatBars';
import { Banner, Empty, Loader, ConfirmDialog } from '../components/ui';
import './profile.page.css';

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** A friendly summary of where the relationship stands — uses the shared band
 *  labels (single source of truth in social.ts) so it never drifts. */
function relationshipStatus(rel: Relationship): string {
  const label = relationshipStage(rel).label;
  const display = label.charAt(0).toUpperCase() + label.slice(1);
  return rel.tension >= 60 ? `${display} · tense` : display;
}

const weatherLabel = (k: string) => WEATHER_LABELS[k as keyof typeof WEATHER_LABELS] ?? k;
const weatherIcon = (k: string) => WEATHER_ICONS[k as keyof typeof WEATHER_ICONS] ?? '';

// ---------------------------------------------------------------------------
// Tabs — mirror the editor's stepped layout, read-only.
// ---------------------------------------------------------------------------

type TabId = 'overview' | 'about' | 'profile' | 'history' | 'memories';

const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'about',    label: 'About' },
  { id: 'profile',  label: 'Profile' },
  { id: 'history',  label: 'History' },
  { id: 'memories', label: 'Memories' },
];

export function CharacterProfile() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { creatorMode, dayTick } = useAppData();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const bundle = useAsync(() => api.getCharacterBundle(id), [id]);
  const sessions = useAsync(() => api.listConversations(), [id]);
  const chronicle = useAsync(() => api.getChronicle(id), [id]);
  const characters = useAsync(() => api.listCharacters(), []);
  // The character's world day, so we can tell "needs space" (still in the
  // post-breakup cooldown) from "open to reconciling" (cooldown elapsed).
  const worldId = bundle.data?.character.worldId ?? null;
  // dayTick keeps the post-breakup cooldown ("needs space" vs "open to
  // reconciling") live as the player ends days with this profile open.
  const worldState = useAsync(
    () => (worldId ? api.getWorldState(worldId) : Promise.resolve(null)),
    [worldId, dayTick],
  );

  const duplicate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const copy = await api.duplicateCharacter(id);
      nav(`/characters/${copy.id}`); // navigates away; no need to clear busy
    } catch (e) {
      setBusy(false);
      alert(errorMessage(e));
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.deleteCharacter(id);
      nav('/characters');
    } catch (e) {
      setBusy(false);
      alert(errorMessage(e));
    }
  };

  const deleteMemory = async (memoryId: string) => {
    await api.deleteMemory(memoryId);
    bundle.reload();
  };

  return (
    <Loader state={bundle}>
      {({ character, relationship, memories }) => {
        const effective = effectiveDatingStats(character.datingStats, relationship.flags);
        const buffs = listActiveBuffs(relationship.flags);
        const storyFlags = Object.entries(relationship.flags)
          .filter(([k]) => !isInternalFlagKey(k))
          .map(([k, v]) => [k, humanizeStoryFlag(k, v)] as const)
          .filter((entry): entry is readonly [string, string] => entry[1] !== null);
        const convoCount = (sessions.data ?? []).filter((s: ConversationSession) => s.characterId === id).length;
        const status = currentStatus(relationship);

        // Endgame state: memorialized (gone), broken up, or on the rocks.
        const memorial = isMemorialized(relationship);
        const brokenUp = isBrokenUp(relationship);
        const onTheRocks = isOnTheRocks(relationship);
        const breakupDay = relationship.flags['breakup:day'];
        const worldDay = worldState.data?.day ?? null;
        const needsSpace =
          brokenUp &&
          typeof breakupDay === 'number' &&
          worldDay != null &&
          worldDay - breakupDay < RECONCILE_COOLDOWN_DAYS;

        const nameOf = (cid: string) => (characters.data ?? []).find((c) => c.id === cid)?.name ?? 'Someone';
        const connections = character.links.filter((l) => l.targetId);

        const dates = chronicle.data?.sessionCount ?? 0;
        const toolTag = memorial
          ? 'in memoriam'
          : brokenUp
            ? 'parted'
            : status !== 'none'
              ? RELATIONSHIP_STATUS_LABELS[status].toLowerCase()
              : relationshipStage(relationship).label;

        const hasAbout =
          !!character.personality.trim() ||
          !!character.speechStyle.trim() ||
          !!character.relationshipPreferences.trim() ||
          character.likes.length > 0 ||
          character.dislikes.length > 0 ||
          character.goals.length > 0 ||
          character.boundaries.length > 0;

        const hasProfile =
          !!character.appearance.trim() ||
          !!character.textingStyle.trim() ||
          !!character.onlinePersona.trim() ||
          !!character.loveLanguage.trim() ||
          !!character.roomDescription.trim() ||
          character.physicalNeeds.length > 0 ||
          character.physicalDesires.length > 0 ||
          character.physicalDislikes.length > 0 ||
          character.insecurities.length > 0 ||
          character.quirks.length > 0 ||
          character.favoriteWeather.length > 0 ||
          character.dislikedWeather.length > 0 ||
          character.employment != null;

        const hasHistory = !!chronicle.data && (!!chronicle.data.chronicle || chronicle.data.recentLines.length > 0);

        const panelClass = (tab: TabId) => `prof-panel stack ${activeTab === tab ? '' : 'prof-panel-hidden'}`;

        return (
          <div className="prof-layout">
            {/* ===== Masthead ===== */}
            <div className="framed prof-mast">
              <div className="prof-mast-titles">
                <div className="prof-mast-meta">
                  <span className="kicker">Character dossier</span>
                  <span className="prof-mast-tag">{toolTag}</span>
                </div>
                <h1>{character.name}</h1>
                <div className="prof-mast-vitals">
                  {character.age}
                  <span className="sep">·</span>
                  {character.pronouns}
                  {character.gender !== 'unspecified' && (
                    <>
                      <span className="sep">·</span>
                      {GENDER_LABELS[character.gender]}
                    </>
                  )}
                  <span className="sep">·</span>
                  {RELATIONSHIP_STYLE_LABELS[character.relationshipStyle]}
                  {character.sexuality !== 'unspecified' &&
                    (creatorMode || relationship.flags['state:orientationRevealed'] === true) && (
                      <>
                        <span className="sep">·</span>
                        {SEXUALITY_LABELS[character.sexuality]}
                      </>
                    )}
                </div>
                {character.shortDescription && <p>{character.shortDescription}</p>}
              </div>
              <div className="prof-mast-actions">
                {!memorial && (
                  <Link className="btn primary" to={`/chat?character=${character.id}`}>
                    <Icon name="date" size={16} /> Date
                  </Link>
                )}
                {creatorMode && (
                  <>
                    <Link className="btn" to={`/characters/${character.id}/edit`}>
                      <Icon name="edit" size={16} /> Edit
                    </Link>
                    <button className="btn ghost" onClick={duplicate} disabled={busy}>
                      <Icon name="duplicate" size={16} /> Duplicate
                    </button>
                    <button className="btn danger ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>
                      <Icon name="trash" size={16} /> Delete
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Endgame banners — always visible, above the tabbed canvas */}
            {memorial && (
              <>
                <Banner kind="error">
                  {character.name} is gone. They're remembered here — your history together remains, but you can't reach
                  them anymore.
                </Banner>
                <CrisisResources />
              </>
            )}
            {!memorial && brokenUp && (
              <Banner kind="error">
                You two broke up.{' '}
                {needsSpace
                  ? `${character.name} needs some space — you can't go on a date yet, but you can still text them.`
                  : `${character.name} is open to seeing you again — keep reaching out (texts + a date) and you may rekindle things.`}
              </Banner>
            )}
            {!memorial && !brokenUp && onTheRocks && (
              <Banner kind="info">
                Things are on the rocks with {character.name}. Turn it around soon — a few good dates — or the
                relationship could end.
              </Banner>
            )}

            {/* ===== Two-column canvas: portrait rail + tabbed content ===== */}
            <div className="prof-canvas">
              {/* Sticky portrait rail */}
              <aside className="prof-rail">
                <div className="prof-rail-plate framed">
                  <Portrait character={character} memorial={memorial} className="prof-rail-img" />
                  <div className="prof-rail-name">{character.name}</div>
                  <div className="prof-rail-meta">
                    {character.age} · {character.pronouns}
                  </div>
                  <div className="prof-rail-badges">
                    {memorial ? (
                      <span className="badge danger"><Icon name="remember" size={13} /> In memoriam</span>
                    ) : brokenUp ? (
                      <>
                        <span className="badge danger"><Icon name="breakup" size={13} /> Broken up</span>
                        <span className="badge warn">{needsSpace ? 'Needs space' : 'Open to reconciling'}</span>
                      </>
                    ) : (
                      <>
                        <span className="badge accent">{relationshipStatus(relationship)}</span>
                        {status !== 'none' && (
                          <span className="badge accent">
                            <Icon name="affection" size={13} /> {RELATIONSHIP_STATUS_LABELS[status]}
                          </span>
                        )}
                        {onTheRocks && <span className="badge warn"><Icon name="warn" size={13} /> On the rocks</span>}
                      </>
                    )}
                  </div>
                  <div className="prof-rail-bars">
                    <RelationshipBars relationship={relationship} />
                  </div>
                  <div className="prof-rail-figs">
                    <div className="prof-rail-fig">
                      <span className="prof-rail-fig-n">{convoCount}</span>
                      <span className="prof-rail-fig-l">chats</span>
                    </div>
                    <div className="prof-rail-fig">
                      <span className="prof-rail-fig-n">{dates}</span>
                      <span className="prof-rail-fig-l">dates</span>
                    </div>
                    <div className="prof-rail-fig">
                      <span className="prof-rail-fig-n">{memories.length}</span>
                      <span className="prof-rail-fig-l">memories</span>
                    </div>
                  </div>
                </div>
              </aside>

              {/* Content column */}
              <div className="prof-main stack">
                {/* Tab nav */}
                <nav className="prof-tabs" aria-label="Profile sections">
                  {TABS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`prof-tab ${activeTab === t.id ? 'prof-tab-active' : ''}`}
                      onClick={() => setActiveTab(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </nav>

                {/* ---- Tab: Overview ---- */}
                <div className={panelClass('overview')}>
                  <div className="card">
                    <div className="section-head">
                      <div className="titles">
                        <span className="kicker">Between you two</span>
                        <h2>Your relationship</h2>
                      </div>
                      <span className="trail" />
                    </div>
                    <div className="prof-gaugegrid">
                      <RelationshipBars relationship={relationship} />
                    </div>
                    {(buffs.length > 0 || storyFlags.length > 0) && (
                      <div className="prof-meta-row">
                        {buffs.length > 0 && (
                          <div>
                            <div className="prof-subhead">Active buffs</div>
                            <div className="tags">
                              {buffs.map((b) => (
                                <span className={`badge prof-buff${b.delta < 0 ? ' down' : ''}`} key={b.stat}>
                                  {b.delta >= 0 ? '+' : ''}
                                  {b.delta} {DATING_STAT_LABELS[b.stat]} <span className="left">· {b.remaining} left</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {storyFlags.length > 0 && (
                          <div>
                            <div className="prof-subhead">Your story</div>
                            <div className="tags">
                              {storyFlags.map(([k, label]) => (
                                <span className="tag prof-flag" key={k}>
                                  {label}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="card">
                    <div className="section-head">
                      <div className="titles">
                        <span className="kicker">How they date</span>
                        <h2>Dating stats</h2>
                      </div>
                      <span className="trail" />
                      {buffs.length > 0 && <span className="muted">with buffs</span>}
                    </div>
                    <div className="prof-gaugegrid">
                      <DatingBars stats={effective} />
                    </div>
                  </div>

                  {connections.length > 0 && (
                    <div className="card">
                      <div className="section-head">
                        <div className="titles">
                          <span className="kicker">Their social web</span>
                          <h2>Connections</h2>
                        </div>
                        <span className="trail" />
                      </div>
                      <div className="prof-conns">
                        {connections.map((l, i) => (
                          <Link className="prof-conn" to={`/characters/${l.targetId}`} key={i}>
                            <span className="prof-conn-kind">{CHARACTER_LINK_LABELS[l.kind]}</span>
                            <span className="prof-conn-name flex-fill">{nameOf(l.targetId)}</span>
                            <Icon name="chevronRight" size={15} />
                          </Link>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* ---- Tab: About ---- */}
                <div className={panelClass('about')}>
                  {hasAbout ? (
                    <>
                      <div className="card">
                        <div className="section-head">
                          <div className="titles">
                            <span className="kicker">Who they are</span>
                            <h2>Personality & voice</h2>
                          </div>
                          <span className="trail" />
                        </div>
                        {character.personality && <p className="prof-personality">{character.personality}</p>}
                        <Prose label="Speech style" value={character.speechStyle} />
                        <Prose label="What they want" value={character.relationshipPreferences} />
                      </div>

                      {(character.likes.length > 0 ||
                        character.dislikes.length > 0 ||
                        character.goals.length > 0 ||
                        character.boundaries.length > 0) && (
                        <div className="card">
                          <div className="section-head">
                            <div className="titles">
                              <span className="kicker">Tastes & limits</span>
                              <h2>Traits & boundaries</h2>
                            </div>
                            <span className="trail" />
                          </div>
                          <div className="prof-taxons">
                            <TagRow label="♥ Likes" items={character.likes} variant="like" />
                            <TagRow label="✕ Dislikes" items={character.dislikes} variant="dislike" />
                            <TagRow label="Goals" items={character.goals} />
                            <TagRow label="Boundaries" items={character.boundaries} />
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="card">
                      <Empty icon={<Icon name="people" size={34} />} title="Nothing written yet">
                        <p className="muted">No personality or traits have been filled in for {character.name}.</p>
                      </Empty>
                    </div>
                  )}
                </div>

                {/* ---- Tab: Profile ---- */}
                <div className={panelClass('profile')}>
                  {hasProfile ? (
                    <>
                      {(character.appearance.trim() ||
                        character.textingStyle.trim() ||
                        character.onlinePersona.trim() ||
                        character.loveLanguage.trim() ||
                        character.employment != null) && (
                        <div className="card">
                          <div className="section-head">
                            <div className="titles">
                              <span className="kicker">Presence</span>
                              <h2>Profile & presence</h2>
                            </div>
                            <span className="trail" />
                          </div>
                          <Prose label="Appearance" value={character.appearance} />
                          <Prose label="Texting style" value={character.textingStyle} />
                          <Prose label="Online persona" value={character.onlinePersona} />
                          <Prose label="Love language" value={character.loveLanguage} />
                          {character.employment && (
                            <div className="prof-detail">
                              <div className="prof-detail-label">Work</div>
                              <p className="prof-detail-text">
                                {character.employment.title} at {character.employment.place} · {character.employment.shiftPhase}{' '}
                                shift
                                {character.employment.workdays.length > 0 &&
                                  ` · ${character.employment.workdays.map((d) => DAYS_OF_WEEK[d]?.slice(0, 3)).join(' ')}`}
                              </p>
                            </div>
                          )}
                        </div>
                      )}

                      {(character.physicalNeeds.length > 0 ||
                        character.physicalDesires.length > 0 ||
                        character.physicalDislikes.length > 0 ||
                        character.insecurities.length > 0 ||
                        character.quirks.length > 0) && (
                        <div className="card">
                          <div className="section-head">
                            <div className="titles">
                              <span className="kicker">The little things</span>
                              <h2>Chemistry & quirks</h2>
                            </div>
                            <span className="trail" />
                          </div>
                          <div className="prof-taxons">
                            <TagRow label="Physical needs" items={character.physicalNeeds} />
                            <TagRow label="Physical desires" items={character.physicalDesires} variant="like" />
                            <TagRow label="Physical dislikes" items={character.physicalDislikes} variant="dislike" />
                            <TagRow label="Insecurities" items={character.insecurities} />
                            <TagRow label="Quirks" items={character.quirks} />
                          </div>
                        </div>
                      )}

                      {(character.favoriteWeather.length > 0 || character.dislikedWeather.length > 0) && (
                        <div className="card">
                          <div className="section-head">
                            <div className="titles">
                              <span className="kicker">Under what skies</span>
                              <h2>Weather</h2>
                            </div>
                            <span className="trail" />
                          </div>
                          <div className="prof-weather">
                            {character.favoriteWeather.map((k) => (
                              <span className="prof-weather-chip fav" key={`f-${k}`}>
                                ♥ {weatherIcon(k)} {weatherLabel(k)}
                              </span>
                            ))}
                            {character.dislikedWeather.map((k) => (
                              <span className="prof-weather-chip dis" key={`d-${k}`}>
                                ✕ {weatherIcon(k)} {weatherLabel(k)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {character.roomDescription.trim() && (
                        <div className="card">
                          <div className="section-head">
                            <div className="titles">
                              <span className="kicker">Where they live</span>
                              <h2>Their space</h2>
                            </div>
                            <span className="trail" />
                          </div>
                          <p className="prof-personality">{character.roomDescription}</p>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="card">
                      <Empty icon={<Icon name="phone" size={34} />} title="No profile yet">
                        <p className="muted">
                          Flavor like appearance, texting style, and quirks hasn't been added — generate it in the editor.
                        </p>
                      </Empty>
                    </div>
                  )}
                </div>

                {/* ---- Tab: History ---- */}
                <div className={panelClass('history')}>
                  {hasHistory ? (
                    <div className="card">
                      <div className="section-head">
                        <div className="titles">
                          <span className="kicker">The story so far</span>
                          <h2>Your history</h2>
                        </div>
                        <span className="trail" />
                        <span className="readout">
                          <span className="num">{chronicle.data!.sessionCount}</span> dates
                        </span>
                      </div>
                      {chronicle.data!.chronicle && <div className="prof-chronicle">{chronicle.data!.chronicle}</div>}
                      {chronicle.data!.recentLines.length > 0 && (
                        <ul className="prof-log">
                          {chronicle.data!.recentLines.map((l, i) => (
                            <li key={i} className="prof-log-line">
                              <span className="prof-log-day">Day {l.day}</span>
                              <span>{l.line}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : (
                    <div className="card">
                      <Empty icon={<Icon name="date" size={34} />} title="No history yet">
                        <p className="muted">Go on a date with {character.name} to start writing your story together.</p>
                      </Empty>
                    </div>
                  )}
                </div>

                {/* ---- Tab: Memories ---- */}
                <div className={panelClass('memories')}>
                  <MemoriesSection memories={memories} characterName={character.name} onDelete={deleteMemory} />
                </div>
              </div>
            </div>

            {bundle.error && <Banner kind="error">{bundle.error}</Banner>}

            {confirmDelete && (
              <ConfirmDialog
                title={`Delete ${character.name}?`}
                body="This removes their memories and your relationship too. This can't be undone."
                confirmLabel="Delete"
                danger
                busy={busy}
                onConfirm={remove}
                onCancel={() => setConfirmDelete(false)}
              />
            )}
          </div>
        );
      }}
    </Loader>
  );
}

// ---------------------------------------------------------------------------
// Read-only field helpers — a labeled prose block / tag row, hidden when empty.
// ---------------------------------------------------------------------------

function Prose({ label, value }: { label: string; value: string }) {
  if (!value || !value.trim()) return null;
  return (
    <div className="prof-detail">
      <div className="prof-detail-label">{label}</div>
      <p className="prof-detail-text">{value}</p>
    </div>
  );
}

function TagRow({ label, items, variant }: { label: string; items: string[]; variant?: 'like' | 'dislike' }) {
  if (items.length === 0) return null;
  const cls = variant === 'like' ? 'prof-tag-like' : variant === 'dislike' ? 'prof-tag-dislike' : '';
  return (
    <div className="prof-detail">
      <div className="prof-detail-label">{label}</div>
      <div className="tags">
        {items.map((t) => (
          <span className={`tag ${cls}`} key={t}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function MemoriesSection({
  memories,
  characterName,
  onDelete,
}: {
  memories: CharacterMemory[];
  characterName: string;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="card">
      <div className="section-head">
        <div className="titles">
          <span className="kicker">What they hold onto</span>
          <h2>Memories</h2>
        </div>
        <span className="trail" />
        <span className="readout">
          <span className="num">{memories.length}</span> kept
        </span>
        {memories.length > 0 && (
          <button className="btn sm ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} /> {open ? 'Hide' : 'Show'}
          </button>
        )}
      </div>
      {memories.length === 0 ? (
        <Empty icon={<Icon name="remember" size={34} />} title="No memories yet">
          <p className="muted">Go on a date and end it to capture memories, or add some in the editor.</p>
        </Empty>
      ) : open ? (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            What {characterName} remembers about you — written manually or captured automatically after a date.
          </p>
          <MemoryList memories={memories} onDelete={onDelete} />
        </>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {memories.length} {memories.length === 1 ? 'memory' : 'memories'} kept — tap <strong>Show</strong> to read them.
        </p>
      )}
    </div>
  );
}

function MemoryList({
  memories,
  onDelete,
}: {
  memories: CharacterMemory[];
  onDelete: (id: string) => void;
}) {
  return (
    <div className="prof-mem-list">
      {memories.map((m) => (
        <div className="prof-mem" key={m.id}>
          <span className="prof-mem-pips" title={`importance ${m.importance}/5`} aria-label={`importance ${m.importance} of 5`}>
            {Array.from({ length: 5 }).map((_, i) => (
              <span key={i} className={`prof-pip${i < m.importance ? ' on' : ''}`} />
            ))}
          </span>
          <div className="flex-fill">
            <div className="prof-mem-text">{m.text}</div>
            <div className="prof-mem-meta">
              <small className={`prof-mem-src${m.sourceEventId ? ' date' : ''}`}>
                {m.sourceEventId ? (
                  <><Icon name="date" size={12} /> from a date</>
                ) : (
                  <><Icon name="edit" size={12} /> added manually</>
                )}
              </small>
              <small className="prof-mem-src">· {ago(m.createdAt)}</small>
              {m.tags.map((t) => (
                <span className="tag prof-mem-tag" key={t}>
                  {t}
                </span>
              ))}
            </div>
          </div>
          <button className="btn sm danger ghost prof-mem-del" onClick={() => onDelete(m.id)} aria-label="Delete memory">
            <Icon name="close" size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
