import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type WorldWeather } from '@dsim/shared';
import { api } from '../../lib/api';
import { useAppData } from '../../state/app-context';
import { weatherLabel, weekdayAbbr } from '../../i18n/labels';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Empty, Spinner } from '../ui';
import './phone-life.css';

/** Today's weather, a forecast, and how each character feels about it. */
export function WeatherApp() {
  const { t } = useTranslation(['phone', 'common']);
  const { activeWorldId, creatorMode, dayTick } = useAppData();
  const [data, setData] = useState<WorldWeather | null>(null);

  // Re-keyed on dayTick so the weather/forecast/moods refresh after End day; the
  // cancelled flag drops out-of-order responses on a rapid world switch.
  useEffect(() => {
    if (!activeWorldId) return;
    let cancelled = false;
    void api
      .worldWeather(activeWorldId)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData(null));
    return () => {
      cancelled = true;
    };
  }, [activeWorldId, dayTick]);

  if (!activeWorldId) {
    return (
      <div className="phone-app">
        <PhoneAppBar title={t('weather.title')} kicker={t('weather.today')} icon="weather" />
        <div className="weather-app">
          <Empty icon={<Icon name="weather" size={36} />} title={t('weather.noWorldTitle')}>
            <p className="muted">{t('weather.noWorldBody')}</p>
          </Empty>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="phone-app">
        <PhoneAppBar title={t('weather.title')} kicker={t('weather.today')} icon="weather" />
        <div className="weather-app"><Spinner /></div>
      </div>
    );
  }

  const loves = data.characters.filter((c) => c.reaction === 'loves');
  const dislikes = data.characters.filter((c) => c.reaction === 'dislikes');

  return (
    <div className="phone-app">
      <PhoneAppBar title={t('weather.title')} kicker={t('weather.today')} icon="weather" />
      <div className="weather-app">
        <div className="weather-today pl-sky" data-weather={data.today.kind}>
          <div className="weather-today-icon">{data.today.icon}</div>
          <div className="pl-sky-meta">
            <div className="pl-sky-kicker">{t('weather.todayOverWorld')}</div>
            <div className="weather-today-label">{t('weather.itsLabel', { label: weatherLabel(data.today.kind) })}</div>
            <div className="pl-sky-day">{t('weather.day', { day: data.day })}</div>
          </div>
        </div>

        <h3 className="weather-h pl-eyebrow">{t('weather.weekAhead')}</h3>
        <div className="weather-forecast">
          {data.forecast.map((f) => (
            <div className={`weather-fc${f.day === data.day ? ' today' : ''}`} key={f.day}>
              <span className="weather-fc-day">{f.day === data.day ? t('weather.todayShort') : weekdayAbbr(f.dayOfWeek)}</span>
              <span className="weather-fc-icon">{f.weather.icon}</span>
              <span className="weather-fc-label">{weatherLabel(f.weather.kind)}</span>
              {f.holiday && <span className="weather-fc-holiday" title={f.holiday}>🎉</span>}
            </div>
          ))}
        </div>

        <h3 className="weather-h pl-eyebrow">{t('weather.feeling')}</h3>
        {data.characters.length === 0 ? (
          <p className="muted">{t('weather.noOne')}</p>
        ) : (
          <div className="weather-moods">
            {data.characters.map((c) => (
              <div
                className={`weather-mood${
                  c.reaction === 'loves' ? ' pl-loves' : c.reaction === 'dislikes' ? ' pl-dislikes' : ''
                }`}
                key={c.id}
              >
                <span className="weather-mood-icon">{c.moodIcon}</span>
                <span className="flex-fill">
                  <strong>{c.name}</strong> — {c.mood}
                </span>
                {c.reaction === 'loves' && <span className="badge good" title={t('weather.lovesTitle')}>{t('weather.lovesIt')}</span>}
                {c.reaction === 'dislikes' && <span className="badge" title={t('weather.dislikesTitle')}>{t('weather.notAFan')}</span>}
              </div>
            ))}
          </div>
        )}

        {/* "Weather tastes" grid removed — the mood row above already shows reactions. */}
        {(loves.length > 0 || dislikes.length > 0) && creatorMode && (
          <p className="hint">
            {t('weather.creatorHint')}
          </p>
        )}
        {loves.length === 0 && dislikes.length === 0 && !creatorMode && null}
      </div>
    </div>
  );
}
