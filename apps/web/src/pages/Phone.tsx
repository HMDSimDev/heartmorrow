import { Fragment, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import { PHASE_ICONS } from '@dsim/shared';
import { api } from '../lib/api';
import './phone.page.css';
import { useAppData } from '../state/app-context';
import { phaseLabel } from '../i18n/labels';
import { Icon } from '../components/Icon';
import { MessagesApp } from '../components/phone/MessagesApp';
import { FacesApp } from '../components/phone/FacesApp';
import { EmailApp } from '../components/phone/EmailApp';
import { WorkApp } from '../components/phone/WorkApp';
import { TogetherApp } from '../components/phone/TogetherApp';
import { SettingsApp } from '../components/phone/SettingsApp';
import { MomentsApp } from '../components/phone/MomentsApp';
import { ConstellationApp } from '../components/phone/ConstellationApp';
import { WeatherApp } from '../components/phone/WeatherApp';
import { CalendarApp } from '../components/phone/CalendarApp';
import { EndingsApp } from '../components/phone/EndingsApp';
import { PropertyApp } from '../components/phone/PropertyApp';
import { MarketApp } from '../components/phone/MarketApp';
import { GamblingApp } from '../components/phone/GamblingApp';
import { Shop } from './Shop';
import { Minigames } from './Minigames';
import { Inventory } from './Inventory';

type AppId = 'home' | 'messages' | 'email' | 'faces' | 'moments' | 'constellation' | 'weather' | 'calendar' | 'endings' | 'work' | 'together' | 'property' | 'market' | 'gambling' | 'shop' | 'games' | 'bag' | 'settings';

type Tint = 'rose' | 'brass' | 'moon' | 'sage' | 'ember' | 'plum' | 'teal';

type CommonKey = ParseKeys<'common'>;
type AppDef = { id: Exclude<AppId, 'home'>; icon: string; labelKey: CommonKey; tint: Tint };

// Each app gets a vivid, distinct hue — like a real phone home screen. Tints are
// chosen for both theme (messages=rose, weather=sky, market=green…) and variety,
// so no two adjacent grid tiles share a color.
const APPS: AppDef[] = [
  { id: 'messages', icon: 'messages', labelKey: 'phone.app.messages', tint: 'rose' },
  { id: 'email', icon: 'mail', labelKey: 'phone.app.email', tint: 'moon' },
  { id: 'faces', icon: 'faces', labelKey: 'phone.app.faces', tint: 'plum' },
  { id: 'moments', icon: 'moments', labelKey: 'phone.app.moments', tint: 'ember' },
  { id: 'calendar', icon: 'calendar', labelKey: 'phone.app.calendar', tint: 'teal' },
  { id: 'constellation', icon: 'constellation', labelKey: 'phone.app.constellation', tint: 'plum' },
  { id: 'weather', icon: 'weather', labelKey: 'phone.app.weather', tint: 'moon' },
  { id: 'endings', icon: 'endings', labelKey: 'phone.app.endings', tint: 'brass' },
  { id: 'work', icon: 'work', labelKey: 'phone.app.work', tint: 'sage' },
  { id: 'together', icon: 'together', labelKey: 'phone.app.together', tint: 'rose' },
  { id: 'property', icon: 'property', labelKey: 'phone.app.property', tint: 'teal' },
  { id: 'market', icon: 'stocks', labelKey: 'phone.app.market', tint: 'sage' },
  { id: 'gambling', icon: 'gambling', labelKey: 'phone.app.gambling', tint: 'ember' },
  { id: 'shop', icon: 'shop', labelKey: 'phone.app.shop', tint: 'brass' },
  { id: 'games', icon: 'games', labelKey: 'phone.app.games', tint: 'plum' },
  { id: 'bag', icon: 'bag', labelKey: 'phone.app.bag', tint: 'sage' },
];

// Pinned to the dock, in order; the rest fill the home grid.
const DOCK_IDS: Array<AppDef['id']> = ['messages', 'email', 'moments', 'settings'];

const SETTINGS_APP: AppDef = { id: 'settings', icon: 'settings', labelKey: 'phone.app.settings', tint: 'moon' };
const ALL_APPS: AppDef[] = [...APPS, SETTINGS_APP];

// Every routable app id (for validating the ?app= URL param).
const APP_IDS = new Set<string>(['home', ...ALL_APPS.map((a) => a.id)]);

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

/** A warm, phase-aware home greeting — the cover line of the almanac. Returns a
 *  catalog key under `phone.greeting.*` so the line localizes with the UI. */
function greetingKeyForPhase(phase: string | undefined): CommonKey {
  switch (phase) {
    case 'morning': return 'phone.greeting.morning';
    case 'afternoon': return 'phone.greeting.afternoon';
    case 'evening': return 'phone.greeting.evening';
    case 'night': return 'phone.greeting.night';
    default: return 'phone.greeting.evening';
  }
}

export function Phone() {
  const { t } = useTranslation();
  const { worldState, activeWorldId, activeWorld, worldsLoaded, dayTick, theme } = useAppData();
  // The open app lives in the URL (?app=…) rather than component state, so a
  // refresh or a browser back after a tab excursion returns to the same app
  // instead of resetting to the home grid (and it makes apps deep-linkable).
  const [params, setParams] = useSearchParams();
  const rawApp = params.get('app') ?? 'home';
  const app: AppId = APP_IDS.has(rawApp) ? (rawApp as AppId) : 'home';
  const setApp = useCallback(
    (next: AppId, opts?: { replace?: boolean }) => {
      setParams(next === 'home' ? {} : { app: next }, { replace: opts?.replace ?? false });
    },
    [setParams],
  );
  const [inbox, setInbox] = useState({ unreadTexts: 0, unreadEmails: 0, feedUnread: 0, landlordUnread: 0 });

  useEffect(() => {
    // `live` drops a superseded fetch so a world switch mid-flight can't paint the
    // previous world's badge counts.
    let live = true;
    api
      .phoneInbox(activeWorldId ?? undefined)
      .then((r) => live && setInbox(r))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [app, activeWorldId, dayTick]);

  // If the active world disables the wealth app you're currently in, bounce home
  // (replace, so Back doesn't step through a URL the world can't render).
  // Only judge once the world list has actually LOADED: during the initial fetch
  // `activeWorld` is still undefined, and bouncing then ejected every deep link
  // and page refresh from these apps even in worlds that have them enabled.
  useEffect(() => {
    if (!worldsLoaded) return;
    if (app === 'property' && !activeWorld?.featureFlags?.property) setApp('home', { replace: true });
    if (app === 'market' && !activeWorld?.featureFlags?.stockMarket) setApp('home', { replace: true });
    if (app === 'gambling' && !activeWorld?.featureFlags?.gambling) setApp('home', { replace: true });
    // Mail/Faces are on-by-default (`?? true` guards the no-world moment).
    if (app === 'email' && !(activeWorld?.featureFlags?.email ?? true)) setApp('home', { replace: true });
    if (app === 'faces' && !(activeWorld?.featureFlags?.faces ?? true)) setApp('home', { replace: true });
  }, [app, activeWorld, worldsLoaded, setApp]);

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
      <button key={a.id} className={`ph-app is-${a.tint}`} onClick={() => setApp(a.id)} title={t(a.labelKey)}>
        <span className="ph-app-icon">
          <span className="ph-app-tile">
            <span className="ph-app-glyph">
              <Icon name={a.icon as Parameters<typeof Icon>[0]['name']} size={26} />
            </span>
          </span>
          {count > 0 && <span className="ph-badge">{count}</span>}
        </span>
        <span className="ph-app-label">{t(a.labelKey)}</span>
      </button>
    );
  };

  // Per-world feature toggles: hide the apps a world has disabled. The wealth
  // apps are opt-IN (off unless enabled); Mail and Faces are opt-OUT (on unless
  // a world switched them off — `?? true` keeps them present with no world).
  const featureOk = (id: AppId): boolean => {
    if (id === 'property') return !!activeWorld?.featureFlags?.property;
    if (id === 'market') return !!activeWorld?.featureFlags?.stockMarket;
    if (id === 'gambling') return !!activeWorld?.featureFlags?.gambling;
    if (id === 'email') return activeWorld?.featureFlags?.email ?? true;
    if (id === 'faces') return activeWorld?.featureFlags?.faces ?? true;
    return true;
  };
  const gridApps = ALL_APPS.filter((a) => !DOCK_IDS.includes(a.id) && featureOk(a.id));
  // Mail lives in the DOCK, so the dock must respect the toggles too.
  const dockApps = DOCK_IDS.map((id) => ALL_APPS.find((a) => a.id === id)!)
    .filter(Boolean)
    .filter((a) => featureOk(a.id));

  const phaseTxt = worldState ? phaseLabel(worldState.phase) : t('phone.twilight');
  const phaseIcon = worldState ? PHASE_ICONS[worldState.phase] : '🌙';
  const batteryPct = deriveBattery(worldState?.stamina, worldState?.staminaMax);
  const greeting = worldState ? t(greetingKeyForPhase(worldState.phase)) : t('phone.greeting.welcome');
  // Footer hint reacts to what's actually waiting — named and TAPPABLE ("5 texts
  // · 4 letters · 25 posts"), each segment opening its app — then a low-energy
  // nudge, otherwise the ambient "letters arrive in time" line.
  const waitingParts = [
    { id: 'messages' as AppId, count: inbox.unreadTexts + inbox.landlordUnread, key: 'phone.waiting.texts' },
    { id: 'email' as AppId, count: inbox.unreadEmails, key: 'phone.waiting.letters' },
    { id: 'faces' as AppId, count: inbox.feedUnread, key: 'phone.waiting.posts' },
    // A hint must never point at an app this world has hidden (stale unread
    // counts can outlive a toggle-off).
  ].filter((p) => p.count > 0 && featureOk(p.id));
  const lowEnergy = batteryPct <= 30;
  const homeHint = lowEnergy ? t('phone.hintLowEnergy') : t('phone.hintAmbient');

  return (
    <div className="phone-wrap">
      <div className="phone-device">
        <div className="phone-statusbar">
          <div className="ph-status">
            <div className="ph-status-left">
              <span className="ph-status-time">{phaseIcon} {worldState ? t('phone.day', { day: worldState.day }) : t('phone.almanac')}</span>
              <span className="ph-status-phase">{phaseTxt}</span>
            </div>
            <div className="ph-status-right">
              <span className="ph-signal" aria-hidden="true">
                <i /><i /><i /><i />
              </span>
              <span className="ph-batt" aria-label={t('phone.energyPct', { pct: batteryPct })}>
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
                      Pocket <span className="ph-amp">&</span> Lamplight · {phaseTxt}
                    </div>
                    <h1 className="ph-greeting-title">{greeting}</h1>
                  </div>
                  <div className="ph-grid">
                    {gridApps.map(renderAppIcon)}
                  </div>
                  {waitingParts.length > 0 ? (
                    <div className="ph-hint ph-waiting">
                      {waitingParts.map((p, i) => (
                        <Fragment key={p.id}>
                          {i > 0 && (
                            <span className="ph-waiting-sep" aria-hidden="true">
                              ·
                            </span>
                          )}
                          <button className="ph-waiting-link" onClick={() => setApp(p.id)}>
                            {t(p.key as ParseKeys, { count: p.count })}
                          </button>
                        </Fragment>
                      ))}
                    </div>
                  ) : (
                    <div className="ph-hint">{homeHint}</div>
                  )}
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
              {app === 'constellation' && <ConstellationApp />}
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
        <button className="ph-homebtn" onClick={() => setApp('home')} aria-label={t('phone.home')} title={t('phone.home')} />
      </div>
    </div>
  );
}
