import type { ReactNode } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useAppData } from './state/app-context';
import { DayHud } from './components/DayHud';
import { Icon, type IconName } from './components/Icon';
import { Dashboard } from './pages/Dashboard';
import { Characters } from './pages/Characters';
import { CharacterProfile } from './pages/CharacterProfile';
import { CharacterEditor } from './pages/CharacterEditor';
import { WorldEditor } from './pages/WorldEditor';
import { WorldSelector, WorldOnboarding } from './pages/WorldSelector';
import { Chat } from './pages/Chat';
import { Shop } from './pages/Shop';
import { Inventory } from './pages/Inventory';
import { Minigames } from './pages/Minigames';
import { Phone } from './pages/Phone';
import { Settings } from './pages/Settings';
import { Bench } from './pages/Bench';
import { Debug } from './pages/Debug';

// `short` is the label used by the cramped bottom nav (phones); the roomy
// sidebar always shows the full `label`. Only set it where the full label is
// long enough to risk overflowing an evenly-flexed bottom-nav cell.
const NAV: { to: string; icon: IconName; label: string; short?: string; end?: boolean; creatorOnly?: boolean }[] = [
  { to: '/', icon: 'home', label: 'Home', end: true },
  { to: '/characters', icon: 'people', label: 'People' },
  { to: '/world', icon: 'chronicle', label: 'World', creatorOnly: true },
  { to: '/chat', icon: 'date', label: 'Date' },
  { to: '/phone', icon: 'phone', label: 'Phone' },
  { to: '/settings', icon: 'settings', label: 'Settings' },
  { to: '/worlds', icon: 'worlds', label: 'Switch world', short: 'Worlds' },
  { to: '/debug', icon: 'debug', label: 'Debug', creatorOnly: true },
];

/** A short, stable key for the current screen — drives the per-screen wallpaper. */
function routeKey(path: string): string {
  if (path === '/') return 'home';
  if (path === '/characters') return 'people';
  if (path.startsWith('/characters')) return 'profile'; // profile, new, edit
  if (path.startsWith('/chat')) return 'date';
  if (path.startsWith('/phone')) return 'phone';
  if (path.startsWith('/shop')) return 'shop';
  if (path.startsWith('/inventory')) return 'bag';
  if (path.startsWith('/minigames')) return 'games';
  if (path.startsWith('/settings')) return 'settings';
  if (path.startsWith('/bench')) return 'settings';
  if (path.startsWith('/world')) return 'world';
  if (path.startsWith('/debug')) return 'debug';
  return 'home';
}

/** Redirects to Home in Play mode — enforces creator gating at the route level. */
function CreatorRoute({ children }: { children: ReactNode }) {
  const { creatorMode } = useAppData();
  return creatorMode ? <>{children}</> : <Navigate to="/" replace />;
}

export default function App() {
  const { creatorMode, unreadTexts, activeWorldId, activeDate } = useAppData();
  const location = useLocation();

  // The world selector + onboarding are a full-screen experience OUTSIDE the
  // in-world shell — you haven't "entered" a world yet, so there's no sidebar/HUD.
  if (location.pathname.startsWith('/worlds')) {
    return (
      <Routes>
        <Route path="/worlds" element={<WorldSelector />} />
        <Route path="/worlds/new" element={<WorldOnboarding />} />
        <Route path="*" element={<Navigate to="/worlds" replace />} />
      </Routes>
    );
  }

  // No world chosen (fresh start, or the active world was deleted) → make the
  // player pick one deliberately rather than dropping them into an arbitrary world.
  if (!activeWorldId) {
    return <Navigate to="/worlds" replace />;
  }

  const nav = NAV.filter((n) => creatorMode || !n.creatorOnly);
  const badgeFor = (to: string) => {
    if (to === '/phone' && unreadTexts > 0)
      return <span className="nav-badge">{unreadTexts > 9 ? '9+' : unreadTexts}</span>;
    // A live date is underway — a pulsing dot on the Date tab so a refresh/navigation
    // away never hides that there's a date to return to.
    if (to === '/chat' && activeDate)
      return (
        <span
          className="nav-badge nav-badge-live"
          title={`On a date with ${activeDate.characterName}`}
          aria-label={`Date in progress with ${activeDate.characterName}`}
        />
      );
    return null;
  };
  return (
    <div className="app" data-route={routeKey(location.pathname)}>
      <div className="atmosphere" aria-hidden="true" />

      <aside className="sidebar">
        <div className="sidebar-inner">
          <div className="brand">
            <span className="dot" /> Heartmorrow
          </div>
          <DayHud />
          <nav className="nav-links">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
                <span className="ico"><Icon name={n.icon} size={20} /></span>
                {n.label}
                {badgeFor(n.to)}
              </NavLink>
            ))}
          </nav>
        </div>
      </aside>

      <header className="topbar">
        <div className="brand">
          <span className="dot" /> Heartmorrow
        </div>
        <DayHud />
      </header>

      <main className="app-main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/characters" element={<Characters />} />
          <Route path="/characters/new" element={<CreatorRoute><CharacterEditor /></CreatorRoute>} />
          <Route path="/characters/:id" element={<CharacterProfile />} />
          <Route path="/characters/:id/edit" element={<CreatorRoute><CharacterEditor /></CreatorRoute>} />
          <Route path="/world" element={<CreatorRoute><WorldEditor /></CreatorRoute>} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/phone" element={<Phone />} />
          <Route path="/shop" element={<Shop />} />
          <Route path="/inventory" element={<Inventory />} />
          <Route path="/minigames" element={<Minigames />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/bench" element={<Bench />} />
          <Route path="/debug" element={<CreatorRoute><Debug /></CreatorRoute>} />
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </main>

      <nav className="bottomnav">
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="ico"><Icon name={n.icon} size={20} /></span>
            {n.short ?? n.label}
            {badgeFor(n.to)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
