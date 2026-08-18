import { useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import {
  effectiveDatingStats,
  ACTIVITIES,
  DATING_STAT_KEYS,
  FAVORITE_BY_STAT,
  favoriteMinigameFor,
  fitLabel,
  isInternalFlagKey,
  storyFlagParts,
  relationshipStage,
  warmthBand,
  warmthOf,
  mutualAttraction,
  incompatibleWarmthCap,
  INCOMPATIBLE_MAX_BAND,
  togetherFit,
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
  type ActivityDef,
  type DatingStatKey,
  type DatingStats,
  type Relationship,
} from '@dsim/shared';
import { api } from '../lib/api';
import { useAsync, errorMessage } from '../lib/hooks';
import { loadWorldPlayer } from '../lib/world-player';
import { useAppData } from '../state/app-context';
import {
  characterLinkLabel,
  datingStatDesc,
  datingStatLabel,
  genderLabel,
  minigameTitleLabel,
  relationshipStatLabel,
  relationshipStatusLabel,
  relationshipStyleLabel,
  relativeTime,
  sexualityLabel,
  warmthBandLabel,
  weatherLabel,
  weekdayAbbr,
} from '../i18n/labels';
import { Portrait } from '../components/Portrait';
import { Icon, type IconName } from '../components/Icon';
import { WarmthBridge, type WarmthBridgePath } from '../components/WarmthBridge';
import { CrisisResources } from '../components/CrisisResources';
import { RelationshipBars } from '../components/StatBars';
import { Banner, Empty, Loader, ConfirmDialog } from '../components/ui';
import { ShareExportDialog } from '../components/ShareTools';
import './profile.page.css';

const weatherIcon = (k: string) => WEATHER_ICONS[k as keyof typeof WEATHER_ICONS] ?? '';
const DATING_STAT_ICONS: Record<DatingStatKey, IconName> = { charm: 'sparkle', empathy: 'affection', humor: 'reactLaugh', confidence: 'trust', intellect: 'chronicle', style: 'ring' };
const RADAR_LEVELS = [25, 50, 75, 100] as const;
const RADAR_CENTER_X = 160;
const RADAR_CENTER_Y = 132;
const RADAR_RADIUS = 78;

type ActivityFit = { activity: ActivityDef; fit: number; tier: ReturnType<typeof fitLabel> };

function strongestDatingStat(stats: DatingStats): DatingStatKey {
  let strongest: DatingStatKey = DATING_STAT_KEYS[0];
  for (const key of DATING_STAT_KEYS) if (stats[key] > stats[strongest]) strongest = key;
  return strongest;
}

function radarCoordinate(index: number, distance: number): { x: number; y: number } {
  const angle = -Math.PI / 2 + index * (Math.PI / 3);
  return { x: RADAR_CENTER_X + Math.cos(angle) * distance, y: RADAR_CENTER_Y + Math.sin(angle) * distance };
}

function radarPolygon(values: readonly number[]): string {
  const points: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? 0;
    const point = radarCoordinate(index, RADAR_RADIUS * (value / 100));
    points.push(`${point.x},${point.y}`);
  }
  return points.join(' ');
}

function radarTextAnchor(index: number): 'start' | 'middle' | 'end' {
  if (index === 0 || index === 3) return 'middle';
  if (index === 1 || index === 2) return 'start';
  return 'end';
}

function DatingRadar({ stats, ariaLabel }: { stats: DatingStats; ariaLabel: string }) {
  const values = DATING_STAT_KEYS.map((key) => stats[key]);
  return (
    <svg className="prof-radar" viewBox="0 0 320 270" role="img" aria-label={ariaLabel}>
      <g className="prof-radar-grid" aria-hidden="true">
        {RADAR_LEVELS.map((level) => <polygon points={radarPolygon(DATING_STAT_KEYS.map(() => level))} key={level} />)}
        {DATING_STAT_KEYS.map((key, index) => {
          const edge = radarCoordinate(index, RADAR_RADIUS);
          return <line x1={RADAR_CENTER_X} y1={RADAR_CENTER_Y} x2={edge.x} y2={edge.y} key={key} />;
        })}
      </g>
      <polygon className="prof-radar-shape" points={radarPolygon(values)} />
      <g className="prof-radar-points" aria-hidden="true">
        {values.map((value, index) => {
          const point = radarCoordinate(index, RADAR_RADIUS * (value / 100));
          return <circle cx={point.x} cy={point.y} r="3" key={DATING_STAT_KEYS[index]} />;
        })}
      </g>
      <g className="prof-radar-labels">
        {DATING_STAT_KEYS.map((key, index) => {
          const point = radarCoordinate(index, 112);
          return <text x={point.x} y={point.y} textAnchor={radarTextAnchor(index)} key={key}><tspan>{datingStatLabel(key)}</tspan><tspan className="prof-radar-value" x={point.x} dy="15">{stats[key]}</tspan></text>;
        })}
      </g>
    </svg>
  );
}

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
  const profileWorldPlayer = useAsync(() => loadWorldPlayer(worldId), [worldId]);
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
    if (busy) return; // a double-click must not fire two DELETEs
    setBusy(true);
    try {
      await api.deleteMemory(memoryId);
      bundle.reload();
    } catch (e) {
      // Surface the failure like duplicate/remove above — silently swallowing it
      // left the memory on screen with the click reading as a dead no-op.
      alert(errorMessage(e));
    } finally {
      setBusy(false);
    }
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
        let warmthPath: WarmthBridgePath = 'romance';
        let warmthMax = 100;
        if (profileWorldPlayer.data && profileWorldPlayer.data.worldId === character.worldId) {
          const compatibility = mutualAttraction({ gender: profileWorldPlayer.data.profile.gender, sexuality: profileWorldPlayer.data.profile.sexuality }, { gender: character.gender, sexuality: character.sexuality });
          if (!compatibility.mutual) {
            warmthPath = 'friendship';
            warmthMax = incompatibleWarmthCap();
          }
        }
        const warmth = Math.max(0, Math.min(warmthMax, warmthOf(relationship)));
        const warmthDisplay = Number(warmth.toFixed(1));
        let warmthStageKey = warmthBand(relationship);
        if (warmthPath === 'friendship' && warmthOf(relationship) > warmthMax) warmthStageKey = INCOMPATIBLE_MAX_BAND;
        const warmthStage = warmthBandLabel(warmthStageKey);
        const warmthSummary = t(`profile.warmthSummary.${warmthStageKey}`);
        const warmthAria = t('profile.warmthAria', { value: warmthDisplay, max: warmthMax, stage: warmthStage });
        const strongestStat = strongestDatingStat(character.datingStats);
        const favoriteGame = favoriteMinigameFor(character);
        const activityFits: ActivityFit[] = [];
        for (const activity of ACTIVITIES) {
          if (activity.kind !== 'together') continue;
          const fit = togetherFit(activity, character.datingStats);
          activityFits.push({ activity, fit, tier: fitLabel(fit) });
        }
        activityFits.sort((a, b) => b.fit - a.fit);

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
                {character.shortDescription && <p dir="auto">{character.shortDescription}</p>}
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
                  <div className="prof-rail-identity">
                    <div className="prof-rail-name">{character.name}</div>
                    <div className="prof-rail-meta">{character.age} · {character.pronouns}</div>
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
                        <div className="prof-relationship-readout">
                          <WarmthBridge value={warmth} maxValue={warmthMax} path={warmthPath} ariaLabel={warmthAria} />
                          <div className="prof-warmth-stage">{warmthStage}</div>
                          <div className="prof-warmth-summary">{warmthSummary}</div>
                        </div>
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
                    <RelationshipBars relationship={relationship} showIcons />
                  </div>
                  <div className="prof-rail-figs">
                    <div className="prof-rail-fig">
                      <span className="prof-rail-fig-icon"><Icon name="messages" size={16} /></span>
                      <span className="prof-rail-fig-n">{convoCount}</span>
                      <span className="prof-rail-fig-l">{t('profile.chats')}</span>
                    </div>
                    <div className="prof-rail-fig">
                      <span className="prof-rail-fig-icon"><Icon name="calendar" size={16} /></span>
                      <span className="prof-rail-fig-n">{dates}</span>
                      <span className="prof-rail-fig-l">{t('profile.dates')}</span>
                    </div>
                    <div className="prof-rail-fig">
                      <span className="prof-rail-fig-icon"><Icon name="moments" size={16} /></span>
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
                  <section className="prof-overview-hero">
                    <div className="prof-overview-heading">
                      <div>
                        <span className="kicker">{t('profile.howTheyDate')}</span>
                        <h2>{t('profile.datingProfile')}</h2>
                      </div>
                      <p>{t('profile.datingProfileLede', { name: character.name })}</p>
                    </div>
                    <div className="prof-dating-cards">
                      {DATING_STAT_KEYS.map((key) => {
                        const activeBuff = buffs.find((buff) => buff.stat === key);
                        let buffPrefix = '';
                        let statClass = 'prof-dating-card';
                        if (activeBuff && activeBuff.delta >= 0) buffPrefix = '+';
                        if (activeBuff) statClass += ' is-buffed';
                        if (activeBuff && activeBuff.delta < 0) statClass += ' is-down';
                        return (
                          <article className={statClass} key={key}>
                            <div className="prof-dating-card-head">
                              <span className="prof-dating-icon"><Icon name={DATING_STAT_ICONS[key]} size={19} /></span>
                              <div className="prof-dating-title">
                                <h3>{datingStatLabel(key)}</h3>
                                <span className="prof-dating-value">{effective[key]}</span>
                              </div>
                            </div>
                            <div className="prof-dating-track" role="meter" aria-label={t('profile.datingStatAria', { stat: datingStatLabel(key), value: effective[key] })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={effective[key]}>
                              <span style={{ width: `${effective[key]}%` }} />
                            </div>
                            <p>{datingStatDesc(key)}</p>
                            {activeBuff && <div className="prof-dating-buff"><span>{buffPrefix}{activeBuff.delta}</span> · {t('profile.baseValue', { value: character.datingStats[key] })} · {t('profile.sessionsLeft', { count: activeBuff.remaining })}</div>}
                          </article>
                        );
                      })}
                    </div>
                  </section>

                  <div className="prof-overview-dashboard">
                    <section className="prof-overview-panel prof-radar-panel">
                      <div className="prof-panel-heading">
                        <span className="kicker">{t('profile.atAGlance')}</span>
                        <h3>{t('profile.traitProfile')}</h3>
                      </div>
                      <DatingRadar stats={effective} ariaLabel={t('profile.datingRadarAria', { name: character.name })} />
                    </section>

                    <section className="prof-overview-panel prof-influence-panel">
                      <div className="prof-panel-heading">
                        <span className="kicker">{t('profile.inPlay')}</span>
                        <h3>{t('profile.whatStatsInfluence')}</h3>
                      </div>
                      <div className="prof-influence-list">
                        <div className="prof-influence-row">
                          <span className="prof-influence-icon"><Icon name="together" size={18} /></span>
                          <div><strong>{t('profile.togetherFitTitle')}</strong><p>{t('profile.togetherFitBody')}</p></div>
                        </div>
                        <div className="prof-influence-row">
                          <span className="prof-influence-icon"><Icon name="games" size={18} /></span>
                          <div><strong>{t('profile.favoriteGameTitle')}</strong><p>{t('profile.favoriteGameBody', { name: character.name, stat: datingStatLabel(strongestStat), game: minigameTitleLabel(favoriteGame) })}</p></div>
                        </div>
                        <div className="prof-influence-row">
                          <span className="prof-influence-icon"><Icon name="messages" size={18} /></span>
                          <div><strong>{t('profile.dateVoiceTitle')}</strong><p>{t('profile.dateVoiceBody')}</p></div>
                        </div>
                      </div>
                    </section>
                  </div>

                  <section className="prof-overview-panel prof-activity-panel">
                    <div className="prof-panel-heading prof-panel-heading-row">
                      <div>
                        <span className="kicker">{t('profile.realActivityFit')}</span>
                        <h3>{t('profile.timeTogether')}</h3>
                      </div>
                      <p>{t('profile.timeTogetherLede')}</p>
                    </div>
                    <div className="prof-activity-grid">
                      {activityFits.map(({ activity, fit, tier }) => {
                        let costLabel = t('profile.free');
                        let statLabel = relationshipStatLabel('comfort');
                        if ((activity.cost ?? 0) > 0) costLabel = t('profile.cost', { value: activity.cost });
                        if (activity.relationshipStat) statLabel = relationshipStatLabel(activity.relationshipStat);
                        return (
                          <article className="prof-activity-card" key={activity.id}>
                            <div className="prof-activity-top">
                              <span className="prof-activity-icon" aria-hidden="true">{activity.icon}</span>
                              <div><h4>{activity.label}</h4><span className={`prof-fit prof-fit-${tier}`}>{t(`profile.fit.${tier}`, { value: Math.round(fit) })}</span></div>
                            </div>
                            <p>{activity.description}</p>
                            <div className="prof-activity-meta"><span>{t('profile.nurtures', { stat: statLabel })}</span><span>{costLabel}</span></div>
                            <div className="prof-activity-traits">{activity.fitStats?.map((stat) => <span key={stat}>{datingStatLabel(stat)}</span>)}</div>
                          </article>
                        );
                      })}
                    </div>
                  </section>

                  {(buffs.length > 0 || storyFlags.length > 0 || connections.length > 0) && (
                    <div className="prof-overview-details">
                      {(buffs.length > 0 || storyFlags.length > 0) && (
                        <section className="prof-overview-panel">
                          <div className="prof-panel-heading"><span className="kicker">{t('profile.betweenYou')}</span><h3>{t('profile.currentContext')}</h3></div>
                          {buffs.length > 0 && <div className="prof-overview-buffs">{buffs.map((buff) => <span className="badge prof-buff" key={buff.stat}>{datingStatLabel(buff.stat)} {buff.delta} · {t('profile.sessionsLeft', { count: buff.remaining })}</span>)}</div>}
                          {storyFlags.length > 0 && <div className="prof-story">{storyFlags.map(([key, flag]) => <div className="prof-story-entry" key={key}><span className="prof-story-tick" aria-hidden="true" /><div className="prof-story-body"><span className="prof-story-key">{flag.label}</span>{flag.value !== null && <span className="prof-story-text">{flag.value}</span>}</div></div>)}</div>}
                        </section>
                      )}
                      {connections.length > 0 && (
                        <section className="prof-overview-panel">
                          <div className="prof-panel-heading"><span className="kicker">{t('profile.theirWeb')}</span><h3>{t('profile.connections')}</h3></div>
                          <div className="prof-conns">{connections.map((link, index) => <Link className="prof-conn" to={`/characters/${link.targetId}`} key={index}><span className="prof-conn-kind">{characterLinkLabel(link.kind)}</span><span className="prof-conn-name flex-fill">{nameOf(link.targetId)}</span><Icon name="chevronRight" size={15} /></Link>)}</div>
                        </section>
                      )}
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
                        {character.personality && <p className="prof-personality" dir="auto">{character.personality}</p>}
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
                          <p className="prof-personality" dir="auto">{character.roomDescription}</p>
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
                      {chronicle.data!.chronicle && <div className="prof-chronicle" dir="auto">{chronicle.data!.chronicle}</div>}
                      {chronicle.data!.recentLines.length > 0 && (
                        <ul className="prof-log">
                          {chronicle.data!.recentLines.map((l, i) => (
                            <li key={i} className="prof-log-line">
                              <span className="prof-log-day">{t('profile.day', { day: l.day })}</span>
                              <span dir="auto">{l.line}</span>
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
      <p className="prof-detail-text" dir="auto">{value}</p>
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
          <span className={`tag ${cls}`} key={t} dir="auto">
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
            {/* Where the memory came from. `sourceMode` was added with hangouts, so
                every memory written before it is null — and all of those were dates. */}
            <small className={`prof-mem-src${m.sourceEventId ? ' date' : ''}`}>
              {m.sourceEventId ? (
                <>
                  <Icon name="date" size={12} />{' '}
                  {t(m.sourceMode === 'hangout' ? 'profile.fromHangout' : 'profile.fromDate')}
                </>
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
          <blockquote className="prof-mem-text" dir="auto">{m.text}</blockquote>
          <footer className="prof-mem-meta">
            <small className="prof-mem-when">{relativeTime(m.createdAt)}</small>
            {m.tags.map((tag) => (
              <span className="tag prof-mem-tag" key={tag} dir="auto">
                {tag}
              </span>
            ))}
          </footer>
        </article>
      ))}
    </div>
  );
}
