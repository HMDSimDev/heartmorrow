import { useEffect, useState } from 'react';
import { PHASE_ICONS, PHASE_LABELS } from '@dsim/shared';
import { api } from '../lib/api';
import './phone.page.css';
import { useAppData } from '../state/app-context';
import { Icon } from '../components/Icon';
import { MessagesApp } from '../components/phone/MessagesApp';
import { FacesApp } from '../components/phone/FacesApp';
import { EmailApp } from '../components/phone/EmailApp';
import { WorkApp } from '../components/phone/WorkApp';
import { TogetherApp } from '../components/phone/TogetherApp';
import { SettingsApp } from '../components/phone/SettingsApp';
import { MomentsApp } from '../components/phone/MomentsApp';
import { SocialApp } from '../components/phone/SocialApp';
import { WeatherApp } from '../components/phone/WeatherApp';
import { CalendarApp } from '../components/phone/CalendarApp';
import { EndingsApp } from '../components/phone/EndingsApp';
import { PropertyApp } from '../components/phone/PropertyApp';
import { MarketApp } from '../components/phone/MarketApp';
import { GamblingApp } from '../components/phone/GamblingApp';
import { Shop } from './Shop';
import { Minigames } from './Minigames';
import { Inventory } from './Inventory';

type AppId = 'home' | 'messages' | 'email' | 'faces' | 'moments' | 'social' | 'weather' | 'calendar' | 'endings' | 'work' | 'together' | 'property' | 'market' | 'gambling' | 'shop' | 'games' | 'bag' | 'settings';

type Tint = 'rose' | 'brass' | 'moon' | 'sage';

type AppDef = { id: Exclude<AppId, 'home'>; icon: string; label: string; tint: Tint };

const APPS: AppDef[] = [
  { id: 'messages', icon: 'messages', label: 'Messages', tint: 'rose' },
  { id: 'email', icon: 'mail', label: 'Mail', tint: 'moon' },
  { id: 'faces', icon: 'faces', label: 'Faces', tint: 'moon' },
  { id: 'moments', icon: 'moments', label: 'Moments', tint: 'rose' },
  { id: 'calendar', icon: 'calendar', label: 'Almanac', tint: 'brass' },
  { id: 'social', icon: 'social', label: 'Social', tint: 'moon' },
  { id: 'weather', icon: 'weather', label: 'Weather', tint: 'moon' },
  { id: 'endings', icon: 'endings', label: 'Endings', tint: 'brass' },
  { id: 'work', icon: 'work', label: 'Work', tint: 'brass' },
  { id: 'together', icon: 'together', label: 'Together', tint: 'rose' },
  { id: 'property', icon: 'property', label: 'Property', tint: 'brass' },
  { id: 'market', icon: 'stocks', label: 'Market', tint: 'sage' },
  { id: 'gambling', icon: 'gambling', label: 'Casino', tint: 'rose' },
  { id: 'shop', icon: 'shop', label: 'Shop', tint: 'brass' },
  { id: 'games', icon: 'games', label: 'Games', tint: 'sage' },
  { id: 'bag', icon: 'bag', label: 'Bag', tint: 'sage' },
];

// Pinned to the dock, in order; the rest fill the home grid.
const DOCK_IDS: Array<AppDef['id']> = ['messages', 'email', 'moments', 'settings'];

const SETTINGS_APP: AppDef = { id: 'settings', icon: 'settings', label: 'Settings', tint: 'sage' };
const ALL_APPS: AppDef[] = [...APPS, SETTINGS_APP];

/** Derive a plausible battery % from the world's daily stamina consumption.
 *  Full stamina = high battery; spent stamina = draining battery.
 *  Falls back to a stable mid-value when no world state is available. */
function deriveBattery(stamina: number | undefined, staminaMax: number | undefined): number {
  if (stamina == null || staminaMax == null || staminaMax === 0) return 72;
  // Map stamina remaining onto 20–95 so the battery is never "dead" mid-day.
  return Math.round(20 + (stamina / staminaMax) * 75);
}

/** Battery fill level → tint class. Like a real phone: green when full, amber as
 *  it drains, red when low — a non-numeric read on the day's remaining energy. */
function batteryLevel(pct: number): 'is-high' | 'is-mid' | 'is-low' {
  if (pct >= 55) return 'is-high';
  if (pct >= 32) return 'is-mid';
  return 'is-low';
}

/** A warm, phase-aware home greeting — the cover line of the almanac. */
function greetingForPhase(phase: string | undefined): string {
  switch (phase) {
    case 'morning': return 'Good morning';
    case 'afternoon': return 'Good afternoon';
    case 'evening': return 'Good evening';
    case 'night': return 'Still awake?';
    default: return 'Good evening';
  }
}

export function Phone() {
  const { worldState, activeWorldId, activeWorld, dayTick, theme } = useAppData();
  const [app, setApp] = useState<AppId>('home');
  const [inbox, setInbox] = useState({ unreadTexts: 0, unreadEmails: 0, feedUnread: 0, landlordUnread: 0 });

  useEffect(() => {
    api.phoneInbox(activeWorldId ?? undefined).then(setInbox).catch(() => undefined);
  }, [app, activeWorldId, dayTick]);

  // If the active world disables the wealth app you're currently in, bounce home.
  useEffect(() => {
    if (app === 'property' && !activeWorld?.featureFlags?.property) setApp('home');
    if (app === 'market' && !activeWorld?.featureFlags?.stockMarket) setApp('home');
    if (app === 'gambling' && !activeWorld?.featureFlags?.gambling) setApp('home');
  }, [app, activeWorld]);

  const badgeFor = (id: AppId) =>
    id === 'messages'
      ? inbox.unreadTexts + inbox.landlordUnread
      : id === 'email'
        ? inbox.unreadEmails
        : id === 'faces'
          ? inbox.feedUnread
          : 0;

  const renderAppIcon = (a: AppDef) => {
    const count = badgeFor(a.id);
    return (
      <button key={a.id} className={`ph-app is-${a.tint}`} onClick={() => setApp(a.id)} title={a.label}>
        <span className="ph-app-icon">
          <span className="ph-app-tile">
            <span className="ph-app-glyph">
              <Icon name={a.icon as Parameters<typeof Icon>[0]['name']} size={26} />
            </span>
          </span>
          {count > 0 && <span className="ph-badge">{count}</span>}
        </span>
        <span className="ph-app-label">{a.label}</span>
      </button>
    );
  };

  // Per-world feature toggles: hide the wealth apps a world has disabled.
  const featureOk = (id: AppDef['id']): boolean => {
    if (id === 'property') return !!activeWorld?.featureFlags?.property;
    if (id === 'market') return !!activeWorld?.featureFlags?.stockMarket;
    if (id === 'gambling') return !!activeWorld?.featureFlags?.gambling;
    return true;
  };
  const gridApps = ALL_APPS.filter((a) => !DOCK_IDS.includes(a.id) && featureOk(a.id));
  const dockApps = DOCK_IDS.map((id) => ALL_APPS.find((a) => a.id === id)!).filter(Boolean);

  const phaseLabel = worldState ? PHASE_LABELS[worldState.phase] : 'Twilight';
  const phaseIcon = worldState ? PHASE_ICONS[worldState.phase] : '🌙';
  const batteryPct = deriveBattery(worldState?.stamina, worldState?.staminaMax);
  const greeting = worldState ? greetingForPhase(worldState.phase) : 'Welcome back';
  // Footer hint reacts to what's actually waiting: unread mail/texts first, then a
  // low-energy nudge, otherwise the ambient "letters arrive in time" line.
  const totalUnread = inbox.unreadTexts + inbox.unreadEmails + inbox.landlordUnread + inbox.feedUnread;
  const lowEnergy = batteryPct <= 30;
  const homeHint =
    totalUnread > 0
      ? `${totalUnread} ${totalUnread === 1 ? 'thing is' : 'things are'} waiting for you.`
      : lowEnergy
        ? 'The lamp runs low — end the day to rest.'
        : 'Texts and mail arrive as the days pass.';

  return (
    <div className="phone-wrap">
      <div className="phone-device">
        <div className="phone-statusbar">
          <div className="ph-status">
            <div className="ph-status-left">
              <span className="ph-status-time">{phaseIcon} {worldState ? `Day ${worldState.day}` : 'The Almanac'}</span>
              <span className="ph-status-phase">{phaseLabel}</span>
            </div>
            <div className="ph-status-right">
              <span className="ph-signal" aria-hidden="true">
                <i /><i /><i /><i />
              </span>
              <span className="ph-batt" aria-label={`Energy ${batteryPct}%`}>
                <span className="ph-batt-pct">{batteryPct}</span>
                <span className="ph-batt-body">
                  <span className={`ph-batt-fill ${batteryLevel(batteryPct)}`} style={{ flex: `0 0 ${batteryPct}%` }} />
                </span>
                <span className="ph-batt-cap" />
              </span>
            </div>
          </div>
        </div>
        <div className="phone-screen">
          {app === 'home' ? (
            <>
              <div className={`phone-home${theme.wallpaper ? ' has-wallpaper' : ''}`}>
                <div className="ph-home">
                  <div className="ph-greeting">
                    <div className="ph-greeting-eyebrow">
                      Pocket <span className="ph-amp">&</span> Lamplight · {phaseLabel}
                    </div>
                    <h1 className="ph-greeting-title">{greeting}</h1>
                  </div>
                  <div className="ph-grid">
                    {gridApps.map(renderAppIcon)}
                  </div>
                  <div className="ph-hint">{homeHint}</div>
                </div>
              </div>
              <div className="ph-dock">
                {dockApps.map(renderAppIcon)}
              </div>
            </>
          ) : (
            <div className="phone-appwrap">
              {app === 'messages' && <MessagesApp />}
              {app === 'email' && <EmailApp />}
              {app === 'faces' && <FacesApp />}
              {app === 'moments' && <MomentsApp />}
              {app === 'social' && <SocialApp />}
              {app === 'weather' && <WeatherApp />}
              {app === 'calendar' && <CalendarApp />}
              {app === 'endings' && <EndingsApp />}
              {app === 'work' && <WorkApp />}
              {app === 'together' && <TogetherApp />}
              {app === 'property' && <PropertyApp />}
              {app === 'market' && <MarketApp />}
              {app === 'gambling' && <GamblingApp />}
              {app === 'settings' && <SettingsApp />}
              {app === 'shop' && (
                <div className="phone-embed">
                  <Shop />
                </div>
              )}
              {app === 'games' && (
                <div className="phone-embed">
                  <Minigames />
                </div>
              )}
              {app === 'bag' && (
                <div className="phone-embed">
                  <Inventory />
                </div>
              )}
            </div>
          )}
        </div>
        <button className="ph-homebtn" onClick={() => setApp('home')} aria-label="Home" title="Home" />
      </div>
    </div>
  );
}
