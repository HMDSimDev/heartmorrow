import './dashboard.page.css';
import { Link } from 'react-router-dom';
import { PHASE_ICONS, PHASE_LABELS, SEASON_ICONS, deriveCalendar, type Phase } from '@dsim/shared';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { Portrait } from '../components/Portrait';
import { Empty } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { EnergyPips } from '../components/EnergyPips';
import { useAppData } from '../state/app-context';

const GREETING: Record<Phase, string> = {
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
  night: 'Still up',
};

const PHASE_LINE: Record<Phase, string> = {
  morning: 'A fresh day is open. Who will you spend it with?',
  afternoon: 'The afternoon is yours — make a little time for someone.',
  evening: 'The lamps are lit. A fine hour for a date.',
  night: 'The night is quiet. Send a text, or rest until tomorrow.',
};

// How many faces the homepage "People in your life" strip previews before pointing
// the player to the full roster. Newest-first, so a just-added person is always shown.
const PEOPLE_PREVIEW_CAP = 15;

const TILES: { to: string; icon: IconName; t: string; d: string }[] = [
  { to: '/chat', icon: 'date', t: 'Date', d: 'Spend an evening with someone.' },
  { to: '/phone', icon: 'phone', t: 'Phone', d: 'Messages, mail, gifts, and keepsakes.' },
  { to: '/characters', icon: 'people', t: 'People', d: 'Everyone you know.' },
  { to: '/settings', icon: 'settings', t: 'Settings', d: 'Your persona and preferences.' },
];

export function Dashboard() {
  const { creatorMode, player, worldState, activeWorld, activeWorldId, dayTick } = useAppData();
  const characters = useAsync(() => api.listCharacters(), [activeWorldId, dayTick]);

  const phase = worldState?.phase ?? null;
  const cal = worldState ? deriveCalendar(worldState.day) : null;
  const name = player?.name?.trim();
  const greeting = phase ? GREETING[phase] : 'Welcome back';
  const line = phase ? PHASE_LINE[phase] : 'Pick someone, and see where the evening goes.';
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
            .
          </h1>
          <p className="dash-hero-line">{line}</p>
        </div>
      </section>

      {/* Game HUD: the world clock as a status console. */}
      {worldState && cal && (
        <div className="dash-hud">
          <div className="dash-hud-strip">
            <span className="dash-hud-label">Almanac status</span>
            <span className="dash-hud-rule" />
          </div>
          <div className="dash-hud-cells">
            {activeWorld && (
              <div className="dash-cell world">
                <span className="dash-cell-k">World</span>
                <span className="dash-cell-v">{activeWorld.name}</span>
              </div>
            )}
            <div className="dash-cell" title={PHASE_LABELS[worldState.phase]}>
              <span className="dash-cell-k">Day · Hour</span>
              <span className="dash-cell-v">
                <span className="dash-icon">{PHASE_ICONS[worldState.phase]}</span>
                <span className="dash-num">Day {worldState.day}</span>
              </span>
              <span className="dash-cell-sub">{PHASE_LABELS[worldState.phase]}</span>
            </div>
            <div className="dash-cell" title={`${cal.dayOfWeek} · ${cal.season}`}>
              <span className="dash-cell-k">Calendar</span>
              <span className="dash-cell-v">
                <span className="dash-icon">{SEASON_ICONS[cal.season]}</span>
                {cal.dayOfWeek}
              </span>
              <span className="dash-cell-sub">
                {cal.season}
                {cal.isWeekend ? ' · weekend' : ''}
              </span>
            </div>
            <div
              className="dash-cell dash-energy"
              title={`${worldState.stamina}/${worldState.staminaMax} energy`}
            >
              <span className="dash-cell-k">Energy</span>
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
            <span className="kicker">Your circle</span>
            <h2>People in your life</h2>
          </div>
          <span className="trail" />
          <Link className="btn sm ghost" to="/characters">
            See everyone
          </Link>
        </div>
        {people.length === 0 ? (
          <Empty icon="✦" title="No one here yet">
            {creatorMode ? (
              <>
                <p className="muted">Create someone to begin your story.</p>
                <Link className="btn primary" to="/characters/new">
                  Create a character
                </Link>
              </>
            ) : (
              <p className="muted">Switch to Creator mode in the phone's Settings to add people.</p>
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
                <Link className="dash-plate-add" to="/characters/new" title="New character">
                  <span className="dash-plate-add-mark"><Icon name="plus" size={26} /></span>
                  <span>New</span>
                </Link>
              )}
            </div>
            {hiddenCount > 0 && (
              <p className="dash-people-more muted">
                There {hiddenCount === 1 ? 'is' : 'are'} {hiddenCount} more{' '}
                {hiddenCount === 1 ? 'person' : 'people'} available — head to the{' '}
                <Link to="/chat">Date tab</Link> to see the full list.
              </p>
            )}
          </>
        )}
      </section>

      <section className="dash-people">
        <div className="section-head">
          <div className="titles">
            <span className="kicker">Quick launch</span>
            <h2>Where to tonight?</h2>
          </div>
          <span className="trail" />
        </div>
        <div className="dash-menu">
          {TILES.map((x) => (
            <Link key={x.to} to={x.to} className="dash-tile">
              <span className="dash-tile-glyph"><Icon name={x.icon} size={24} /></span>
              <span className="dash-tile-text">
                <span className="dash-tile-title">{x.t}</span>
                <span className="dash-tile-desc">{x.d}</span>
              </span>
              <span className="dash-tile-go"><Icon name="chevronRight" size={18} /></span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
