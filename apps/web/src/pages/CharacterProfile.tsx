import { useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import {
  effectiveDatingStats,
  isInternalFlagKey,
  storyFlagParts,
  relationshipStage,
  currentStatus,
  isBrokenUp,
  isMemorialized,
  isOnTheRocks,
  RECONCILE_COOLDOWN_DAYS,
  DAYS_OF_WEEK,
  WEATHER_ICONS,
  listActiveBuffs,
  type CharacterMemory,
  type ConversationSession,
  type Relationship,
} from '@dsim/shared';
import { api } from '../lib/api';
import { useAsync, errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import {
  characterLinkLabel,
  datingStatLabel,
  genderLabel,
  relationshipStatusLabel,
  relationshipStyleLabel,
  relativeTime,
  sexualityLabel,
  weatherLabel,
  weekdayAbbr,
} from '../i18n/labels';
import { Portrait } from '../components/Portrait';
import { Icon } from '../components/Icon';
import { CrisisResources } from '../components/CrisisResources';
import { DatingBars, RelationshipBars } from '../components/StatBars';
import { Banner, Empty, Loader, ConfirmDialog } from '../components/ui';
import { ShareExportDialog } from '../components/ShareTools';
import './profile.page.css';

type TFn = (key: string, opts?: Record<string, unknown>) => string;

/** A friendly summary of where the relationship stands — uses the shared band
 *  labels (single source of truth in social.ts) so it never drifts. */
function relationshipStatus(rel: Relationship, t: TFn): string {
  const label = relationshipStage(rel).label;
  const display = label.charAt(0).toUpperCase() + label.slice(1);
  return rel.tension >= 60 ? `${display}${t('profile.tenseSuffix')}` : display;
}

const weatherIcon = (k: string) => WEATHER_ICONS[k as keyof typeof WEATHER_ICONS] ?? '';

// ---------------------------------------------------------------------------
// Tabs — mirror the editor's stepped layout, read-only.
// ---------------------------------------------------------------------------

type TabId = 'overview' | 'about' | 'profile' | 'history' | 'memories';

const TAB_IDS: TabId[] = ['overview', 'about', 'profile', 'history', 'memories'];

export function CharacterProfile() {
  const { t } = useTranslation(['pages', 'common']);
  const { id = '' } = useParams();
  const nav = useNavigate();
  const { creatorMode, dayTick } = useAppData();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [exporting, setExporting] = useState(false);
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
          .map(([k, v]) => [k, storyFlagParts(k, v)] as const)
          .filter((entry): entry is readonly [string, { label: string; value: string | null }] => entry[1] !== null);
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

        const nameOf = (cid: string) => (characters.data ?? []).find((c) => c.id === cid)?.name ?? t('profile.someone');
        const connections = character.links.filter((l) => l.targetId);

        const dates = chronicle.data?.sessionCount ?? 0;
        const toolTag = memorial
          ? t('profile.inMemoriam2')
          : brokenUp
            ? t('profile.parted')
            : status !== 'none'
              ? relationshipStatusLabel(status).toLowerCase()
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
                  <span className="kicker">{t('profile.dossier')}</span>
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
                      {genderLabel(character.gender)}
                    </>
                  )}
                  <span className="sep">·</span>
                  {relationshipStyleLabel(character.relationshipStyle)}
                  {character.sexuality !== 'unspecified' &&
                    (creatorMode || relationship.flags['state:orientationRevealed'] === true) && (
                      <>
                        <span className="sep">·</span>
                        {sexualityLabel(character.sexuality)}
                      </>
                    )}
                </div>
                {character.shortDescription && <p>{character.shortDescription}</p>}
              </div>
              <div className="prof-mast-actions">
                {!memorial && (
                  <Link className="btn primary" to={`/chat?character=${character.id}`}>
                    <Icon name="date" size={16} /> {t('profile.date')}
                  </Link>
                )}
                {creatorMode && (
                  <>
                    <Link className="btn" to={`/characters/${character.id}/edit`}>
                      <Icon name="edit" size={16} /> {t('profile.edit')}
                    </Link>
                    <button className="btn ghost" onClick={() => setConfirmDuplicate(true)} disabled={busy}>
                      <Icon name="duplicate" size={16} /> {t('profile.duplicate')}
                    </button>
                    <button className="btn ghost" onClick={() => setExporting(true)} disabled={busy}>
                      <Icon name="download" size={16} /> {t('profile.export')}
                    </button>
                    <button className="btn danger ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>
                      <Icon name="trash" size={16} /> {t('profile.delete')}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Endgame banners — always visible, above the tabbed canvas */}
            {memorial && (
              <>
                <Banner kind="error">
                  {t('profile.memorialBanner', { name: character.name })}
                </Banner>
                <CrisisResources />
              </>
            )}
            {!memorial && brokenUp && (
              <Banner kind="error">
                {t('profile.brokeUp')}{' '}
                {needsSpace
                  ? t('profile.needsSpace', { name: character.name })
                  : t('profile.openToReconcile', { name: character.name })}
              </Banner>
            )}
            {!memorial && !brokenUp && onTheRocks && (
              <Banner kind="info">
                {t('profile.onTheRocksBanner', { name: character.name })}
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
                      <span className="badge danger"><Icon name="remember" size={13} /> {t('profile.inMemoriamBadge')}</span>
                    ) : brokenUp ? (
                      <>
                        <span className="badge danger"><Icon name="breakup" size={13} /> {t('profile.brokenUpBadge')}</span>
                        <span className="badge warn">{needsSpace ? t('profile.needsSpaceBadge') : t('profile.openBadge')}</span>
                      </>
                    ) : (
                      <>
                        <span className="badge accent">{relationshipStatus(relationship, t as unknown as TFn)}</span>
                        {status !== 'none' && (
                          <span className="badge accent">
                            <Icon name="affection" size={13} /> {relationshipStatusLabel(status)}
                          </span>
                        )}
                        {onTheRocks && <span className="badge warn"><Icon name="warn" size={13} /> {t('profile.onTheRocksBadge')}</span>}
                      </>
                    )}
                  </div>
                  <div className="prof-rail-bars">
                    <RelationshipBars relationship={relationship} />
                  </div>
                  <div className="prof-rail-figs">
                    <div className="prof-rail-fig">
                      <span className="prof-rail-fig-n">{convoCount}</span>
                      <span className="prof-rail-fig-l">{t('profile.chats')}</span>
                    </div>
                    <div className="prof-rail-fig">
                      <span className="prof-rail-fig-n">{dates}</span>
                      <span className="prof-rail-fig-l">{t('profile.dates')}</span>
                    </div>
                    <div className="prof-rail-fig">
                      <span className="prof-rail-fig-n">{memories.length}</span>
                      <span className="prof-rail-fig-l">{t('profile.memoriesShort')}</span>
                    </div>
                  </div>
                </div>
              </aside>

              {/* Content column */}
              <div className="prof-main stack">
                {/* Tab nav */}
                <nav className="prof-tabs" aria-label={t('profile.sectionsAria')}>
                  {TAB_IDS.map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      className={`prof-tab ${activeTab === tab ? 'prof-tab-active' : ''}`}
                      onClick={() => setActiveTab(tab)}
                    >
                      {t(`profile.tabs.${tab}`)}
                    </button>
                  ))}
                </nav>

                {/* ---- Tab: Overview ---- */}
                <div className={panelClass('overview')}>
                  <div className="card">
                    <div className="section-head">
                      <div className="titles">
                        <span className="kicker">{t('profile.betweenYou')}</span>
                        <h2>{t('profile.yourRelationship')}</h2>
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
                            <div className="prof-subhead">{t('profile.activeBuffs')}</div>
                            <div className="tags">
                              {buffs.map((b) => (
                                <span className={`badge prof-buff${b.delta < 0 ? ' down' : ''}`} key={b.stat}>
                                  {b.delta >= 0 ? '+' : ''}
                                  {b.delta} {datingStatLabel(b.stat)} <span className="left">{t('profile.buffLeft', { remaining: b.remaining })}</span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {storyFlags.length > 0 && (
                          <div className="prof-meta-story">
                            <div className="prof-subhead">{t('profile.yourStory')}</div>
                            <div className="prof-story">
                              {storyFlags.map(([k, flag]) => (
                                <div className="prof-story-entry" key={k}>
                                  <span className="prof-story-tick" aria-hidden="true" />
                                  <div className="prof-story-body">
                                    <span className="prof-story-key">{flag.label}</span>
                                    {flag.value !== null && (
                                      <span className={`prof-story-text${/^\d+$/.test(flag.value) ? ' is-num' : ''}`}>
                                        {flag.value}
                                      </span>
                                    )}
                                  </div>
                                </div>
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
                        <span className="kicker">{t('profile.howTheyDate')}</span>
                        <h2>{t('profile.datingStats')}</h2>
                      </div>
                      <span className="trail" />
                      {buffs.length > 0 && <span className="muted">{t('profile.withBuffs')}</span>}
                    </div>
                    <div className="prof-gaugegrid">
                      <DatingBars stats={effective} />
                    </div>
                  </div>

                  {connections.length > 0 && (
                    <div className="card">
                      <div className="section-head">
                        <div className="titles">
                          <span className="kicker">{t('profile.theirWeb')}</span>
                          <h2>{t('profile.connections')}</h2>
                        </div>
                        <span className="trail" />
                      </div>
                      <div className="prof-conns">
                        {connections.map((l, i) => (
                          <Link className="prof-conn" to={`/characters/${l.targetId}`} key={i}>
                            <span className="prof-conn-kind">{characterLinkLabel(l.kind)}</span>
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
                            <span className="kicker">{t('profile.whoTheyAre')}</span>
                            <h2>{t('profile.personalityVoice')}</h2>
                          </div>
                          <span className="trail" />
                        </div>
                        {character.personality && <p className="prof-personality">{character.personality}</p>}
                        <Prose label={t('profile.speechStyle')} value={character.speechStyle} />
                        <Prose label={t('profile.whatTheyWant')} value={character.relationshipPreferences} />
                      </div>

                      {(character.likes.length > 0 ||
                        character.dislikes.length > 0 ||
                        character.goals.length > 0 ||
                        character.boundaries.length > 0) && (
                        <div className="card">
                          <div className="section-head">
                            <div className="titles">
                              <span className="kicker">{t('profile.tastesLimits')}</span>
                              <h2>{t('profile.traitsBoundaries')}</h2>
                            </div>
                            <span className="trail" />
                          </div>
                          <div className="prof-taxons">
                            <TagRow label={t('profile.likes')} items={character.likes} variant="like" />
                            <TagRow label={t('profile.dislikes')} items={character.dislikes} variant="dislike" />
                            <TagRow label={t('profile.goals')} items={character.goals} />
                            <TagRow label={t('profile.boundaries')} items={character.boundaries} />
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="card">
                      <Empty icon={<Icon name="people" size={34} />} title={t('profile.nothingWritten')}>
                        <p className="muted">{t('profile.noPersonality', { name: character.name })}</p>
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
                              <span className="kicker">{t('profile.presence')}</span>
                              <h2>{t('profile.profilePresence')}</h2>
                            </div>
                            <span className="trail" />
                          </div>
                          <Prose label={t('profile.appearance')} value={character.appearance} />
                          <Prose label={t('profile.textingStyle')} value={character.textingStyle} />
                          <Prose label={t('profile.onlinePersona')} value={character.onlinePersona} />
                          <Prose label={t('profile.loveLanguage')} value={character.loveLanguage} />
                          {character.employment && (
                            <div className="prof-detail">
                              <div className="prof-detail-label">{t('profile.work')}</div>
                              <p className="prof-detail-text">
                                {t('profile.workLine', { title: character.employment.title, place: character.employment.place, phase: character.employment.shiftPhase })}
                                {character.employment.workdays.length > 0 &&
                                  ` · ${character.employment.workdays.map((d) => weekdayAbbr(DAYS_OF_WEEK[d] ?? '')).join(' ')}`}
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
                              <span className="kicker">{t('profile.littleThings')}</span>
                              <h2>{t('profile.chemistryQuirks')}</h2>
                            </div>
                            <span className="trail" />
                          </div>
                          <div className="prof-taxons">
                            <TagRow label={t('profile.physicalNeeds')} items={character.physicalNeeds} />
                            <TagRow label={t('profile.physicalDesires')} items={character.physicalDesires} variant="like" />
                            <TagRow label={t('profile.physicalDislikes')} items={character.physicalDislikes} variant="dislike" />
                            <TagRow label={t('profile.insecurities')} items={character.insecurities} />
                            <TagRow label={t('profile.quirks')} items={character.quirks} />
                          </div>
                        </div>
                      )}

                      {(character.favoriteWeather.length > 0 || character.dislikedWeather.length > 0) && (
                        <div className="card">
                          <div className="section-head">
                            <div className="titles">
                              <span className="kicker">{t('profile.underSkies')}</span>
                              <h2>{t('profile.weather')}</h2>
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
                              <span className="kicker">{t('profile.whereTheyLive')}</span>
                              <h2>{t('profile.theirSpace')}</h2>
                            </div>
                            <span className="trail" />
                          </div>
                          <p className="prof-personality">{character.roomDescription}</p>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="card">
                      <Empty icon={<Icon name="phone" size={34} />} title={t('profile.noProfileTitle')}>
                        <p className="muted">
                          {t('profile.noProfileBody')}
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
                          <span className="kicker">{t('profile.storySoFar')}</span>
                          <h2>{t('profile.yourHistory')}</h2>
                        </div>
                        <span className="trail" />
                        <span className="readout">
                          <span className="num">{chronicle.data!.sessionCount}</span> {t('profile.datesReadout')}
                        </span>
                      </div>
                      {chronicle.data!.chronicle && <div className="prof-chronicle">{chronicle.data!.chronicle}</div>}
                      {chronicle.data!.recentLines.length > 0 && (
                        <ul className="prof-log">
                          {chronicle.data!.recentLines.map((l, i) => (
                            <li key={i} className="prof-log-line">
                              <span className="prof-log-day">{t('profile.day', { day: l.day })}</span>
                              <span>{l.line}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : (
                    <div className="card">
                      <Empty icon={<Icon name="date" size={34} />} title={t('profile.noHistoryTitle')}>
                        <p className="muted">{t('profile.noHistoryBody', { name: character.name })}</p>
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

            {exporting && (
              <ShareExportDialog worlds={[]} characters={[character]} onClose={() => setExporting(false)} />
            )}

            {confirmDelete && (
              <ConfirmDialog
                title={t('profile.confirmDeleteTitle', { name: character.name })}
                body={t('profile.confirmDeleteBody')}
                confirmLabel={t('profile.delete')}
                danger
                busy={busy}
                onConfirm={remove}
                onCancel={() => setConfirmDelete(false)}
              />
            )}

            {confirmDuplicate && (
              <ConfirmDialog
                kicker={t('profile.duplicateKicker')}
                title={t('profile.confirmDuplicateTitle', { name: character.name })}
                body={t('profile.confirmDuplicateBody', { name: character.name })}
                confirmLabel={t('profile.duplicate')}
                busy={busy}
                onConfirm={() => {
                  setConfirmDuplicate(false);
                  void duplicate();
                }}
                onCancel={() => setConfirmDuplicate(false)}
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
  const { t } = useTranslation(['pages', 'common']);
  const [open, setOpen] = useState(true);
  return (
    <div className="card">
      <div className="section-head">
        <div className="titles">
          <span className="kicker">{t('profile.whatTheyHold')}</span>
          <h2>{t('profile.memories')}</h2>
        </div>
        <span className="trail" />
        <span className="readout">
          <span className="num">{memories.length}</span> {t('profile.kept')}
        </span>
        {memories.length > 0 && (
          <button className="btn sm ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} /> {open ? t('profile.hide') : t('profile.show')}
          </button>
        )}
      </div>
      {memories.length === 0 ? (
        <Empty icon={<Icon name="remember" size={34} />} title={t('profile.noMemoriesTitle')}>
          <p className="muted">{t('profile.noMemoriesBody')}</p>
        </Empty>
      ) : open ? (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            {t('profile.memoriesHint', { name: characterName })}
          </p>
          <MemoryList memories={memories} onDelete={onDelete} />
        </>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          <Trans i18nKey="profile.memoriesCollapsed" ns="pages" count={memories.length} components={[<strong />]} />
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
  const { t } = useTranslation(['pages', 'common']);
  // Pruning what someone holds onto is an author's tool, not a player's move.
  const { creatorMode } = useAppData();
  return (
    <div className="prof-mem-list">
      {memories.map((m) => (
        // --w (0.2–1.0) grades the card's lamplight: heavier memories carry a
        // warmer frame, wash and seal glow, so the grid reads by importance.
        <article
          className="prof-mem"
          key={m.id}
          style={{ '--w': m.importance / 5 } as CSSProperties}
        >
          <header className="prof-mem-head">
            <span
              className="prof-mem-seal"
              title={t('profile.importanceTitle', { n: m.importance })}
              aria-label={t('profile.importanceAria', { n: m.importance })}
            >
              <span className="prof-mem-seal-label" aria-hidden="true">{t('profile.weight')}</span>
              <span className="prof-mem-pips" aria-hidden="true">
                {Array.from({ length: 5 }).map((_, i) => (
                  <span key={i} className={`prof-pip${i < m.importance ? ' on' : ''}`} />
                ))}
                <span className="prof-mem-seal-n">{m.importance}/5</span>
              </span>
            </span>
            <span className="prof-mem-trail" aria-hidden="true" />
            <small className={`prof-mem-src${m.sourceEventId ? ' date' : ''}`}>
              {m.sourceEventId ? (
                <><Icon name="date" size={12} /> {t('profile.fromDate')}</>
              ) : (
                <><Icon name="edit" size={12} /> {t('profile.addedManually')}</>
              )}
            </small>
            {creatorMode && (
              <button className="prof-mem-del" onClick={() => onDelete(m.id)} aria-label={t('profile.deleteMemory')}>
                <Icon name="close" size={14} />
              </button>
            )}
          </header>
          <blockquote className="prof-mem-text">{m.text}</blockquote>
          <footer className="prof-mem-meta">
            <small className="prof-mem-when">{relativeTime(m.createdAt)}</small>
            {m.tags.map((tag) => (
              <span className="tag prof-mem-tag" key={tag}>
                {tag}
              </span>
            ))}
          </footer>
        </article>
      ))}
    </div>
  );
}
