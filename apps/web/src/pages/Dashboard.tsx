import './dashboard.page.css';
import { Link } from 'react-router-dom';
import type { ParseKeys } from 'i18next';
import { Trans, useTranslation } from 'react-i18next';
import { PHASE_ICONS, SEASON_ICONS, deriveCalendar } from '@dsim/shared';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { phaseLabel, seasonLabel, weekdayLabel } from '../i18n/labels';
import { Portrait } from '../components/Portrait';
import { Empty } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { EnergyPips } from '../components/EnergyPips';
import { useAppData } from '../state/app-context';

// How many faces the homepage "People in your life" strip previews before pointing
// the player to the full roster. Newest-first, so a just-added person is always shown.
const PEOPLE_PREVIEW_CAP = 15;

type PagesKey = ParseKeys<'pages'>;
const TILES: { to: string; icon: IconName; titleKey: PagesKey; descKey: PagesKey }[] = [
  { to: '/chat', icon: 'date', titleKey: 'dashboard.tiles.dateTitle', descKey: 'dashboard.tiles.dateDesc' },
  { to: '/phone', icon: 'phone', titleKey: 'dashboard.tiles.phoneTitle', descKey: 'dashboard.tiles.phoneDesc' },
  { to: '/characters', icon: 'people', titleKey: 'dashboard.tiles.peopleTitle', descKey: 'dashboard.tiles.peopleDesc' },
  { to: '/settings', icon: 'settings', titleKey: 'dashboard.tiles.settingsTitle', descKey: 'dashboard.tiles.settingsDesc' },
];

export function Dashboard() {
  const { t } = useTranslation(['pages', 'common']);
  const { creatorMode, player, worldState, activeWorld, activeWorldId, dayTick } = useAppData();
  const characters = useAsync(() => api.listCharacters(), [activeWorldId, dayTick]);

  const phase = worldState?.phase ?? null;
  const cal = worldState ? deriveCalendar(worldState.day) : null;
  const name = player?.name?.trim();
  const greeting = phase ? t(`dashboard.greeting.${phase}` as 'dashboard.greeting.morning') : t('dashboard.welcome');
  // Punctuation lives with the copy: "Still up, Hunter?" asks; the others state.
  const greetingMark = phase ? t(`dashboard.greetingMark.${phase}` as 'dashboard.greetingMark.morning') : '.';
  const line = phase ? t(`dashboard.line.${phase}` as 'dashboard.line.morning') : t('dashboard.fallbackLine');
  // Only the active world's cast appears in this world. The strip below is a capped
  // preview (newest first, then `.slice(0, PEOPLE_PREVIEW_CAP)`) — the server returns
  // characters oldest-first, so reversing here keeps a just-added person visible
  // instead of letting them fall past the oldest faces.
  const people = (characters.data ?? [])
    .filter((c) => !activeWorldId || c.worldId === activeWorldId)
    .reverse();
  const hiddenCount = Math.max(0, people.length - PEOPLE_PREVIEW_CAP);

  return (
    <div className="stack">
      {/* Signature element: the framed hero centerpiece. */}
      <section className="framed dash-hero bracketed">
        <div className="dash-hero-grain" />
        <div className="dash-hero-inner">
          <div className="dash-hero-eyebrow">A lamplit almanac of the heart</div>
          <h1 className="dash-hero-title">
            {greeting}
            {name ? (
              <>
                , <span className="dash-hero-name">{name}</span>
              </>
            ) : (
              ''
            )}
            {greetingMark}
          </h1>
          <p className="dash-hero-line">{line}</p>
        </div>
      </section>

      {/* Game HUD: the world clock as a status console. */}
      {worldState && cal && (
        <div className="dash-hud">
          <div className="dash-hud-strip">
            <span className="dash-hud-label">{t('dashboard.almanacStatus')}</span>
            <span className="dash-hud-rule" />
          </div>
          <div className="dash-hud-cells">
            {activeWorld && (
              <div className="dash-cell world">
                <span className="dash-cell-k">{t('dashboard.world')}</span>
                <span className="dash-cell-v">{activeWorld.name}</span>
              </div>
            )}
            <div className="dash-cell" title={phaseLabel(worldState.phase)}>
              <span className="dash-cell-k">{t('dashboard.dayHour')}</span>
              <span className="dash-cell-v">
                <span className="dash-icon">{PHASE_ICONS[worldState.phase]}</span>
                <span className="dash-num">{t('dashboard.day', { day: worldState.day })}</span>
              </span>
              <span className="dash-cell-sub">{phaseLabel(worldState.phase)}</span>
            </div>
            <div className="dash-cell" title={`${weekdayLabel(cal.dayOfWeek)} · ${seasonLabel(cal.season)}`}>
              <span className="dash-cell-k">{t('dashboard.calendar')}</span>
              <span className="dash-cell-v">
                <span className="dash-icon">{SEASON_ICONS[cal.season]}</span>
                {weekdayLabel(cal.dayOfWeek)}
              </span>
              <span className="dash-cell-sub">
                {seasonLabel(cal.season)}
                {cal.isWeekend ? t('dashboard.weekendSuffix') : ''}
              </span>
            </div>
            <div
              className="dash-cell dash-energy"
              title={`${worldState.stamina}/${worldState.staminaMax} energy`}
            >
              <span className="dash-cell-k">{t('dashboard.energy')}</span>
              <span className="dash-cell-v">
                <EnergyPips value={worldState.stamina} max={worldState.staminaMax} />
                <span className="dash-energy-count">
                  {worldState.stamina}/{worldState.staminaMax}
                </span>
              </span>
            </div>
            <span className="money-pill dash-hud-money">
              <Icon name="coin" size={15} /> {player?.money ?? 0}
            </span>
          </div>
        </div>
      )}

      <section className="dash-people">
        <div className="section-head">
          <div className="titles">
            <span className="kicker">{t('dashboard.yourCircle')}</span>
            <h2>{t('dashboard.peopleInLife')}</h2>
          </div>
          <span className="trail" />
          <Link className="btn sm ghost" to="/characters">
            {t('dashboard.seeEveryone')}
          </Link>
        </div>
        {people.length === 0 ? (
          <Empty icon="✦" title={t('dashboard.noOneTitle')}>
            {creatorMode ? (
              <>
                <p className="muted">{t('dashboard.createSomeone')}</p>
                <Link className="btn primary" to="/characters/new">
                  {t('dashboard.createCharacter')}
                </Link>
              </>
            ) : (
              <p className="muted">{t('dashboard.switchToCreator')}</p>
            )}
          </Empty>
        ) : (
          <>
            <div className="dash-people-row">
              {people.slice(0, PEOPLE_PREVIEW_CAP).map((c) => (
                <Link key={c.id} className="dash-plate" to={`/characters/${c.id}`} title={c.name}>
                  <Portrait character={c} />
                  <span className="dash-plate-foot">
                    <span className="dash-plate-tick" />
                    <span className="dash-plate-name truncate">{c.name}</span>
                  </span>
                </Link>
              ))}
              {creatorMode && (
                <Link className="dash-plate-add" to="/characters/new" title={t('dashboard.newCharacter')}>
                  <span className="dash-plate-add-mark"><Icon name="plus" size={26} /></span>
                  <span>{t('dashboard.new')}</span>
                </Link>
              )}
            </div>
            {hiddenCount > 0 && (
              <p className="dash-people-more muted">
                <Trans i18nKey="dashboard.morePeople" ns="pages" count={hiddenCount} components={[<Link to="/chat" />]} />
              </p>
            )}
          </>
        )}
      </section>

      <section className="dash-people">
        <div className="section-head">
          <div className="titles">
            <span className="kicker">{t('dashboard.quickLaunch')}</span>
            <h2>{t('dashboard.whereTonight')}</h2>
          </div>
          <span className="trail" />
        </div>
        <div className="dash-menu">
          {TILES.map((x) => (
            <Link key={x.to} to={x.to} className="dash-tile">
              <span className="dash-tile-glyph"><Icon name={x.icon} size={24} /></span>
              <span className="dash-tile-text">
                <span className="dash-tile-title">{t(x.titleKey)}</span>
                <span className="dash-tile-desc">{t(x.descKey)}</span>
              </span>
              <span className="dash-tile-go"><Icon name="chevronRight" size={18} /></span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
