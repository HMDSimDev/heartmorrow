import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DAYS_OF_WEEK,
  SEASON_ICONS,
  SEASON_LENGTH,
  deriveCalendar,
  type CalendarEntry,
  type DayRecordBeat,
  type WorldCalendar,
} from '@dsim/shared';
import { api } from '../../lib/api';
import { useAppData } from '../../state/app-context';
import { seasonLabel, weatherLabel, weekday2, weekdayLabel } from '../../i18n/labels';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Empty, Spinner } from '../ui';
import './phone-almanac.css';

/** Which 28-day season-block a day falls in (0-based from day 1). */
const blockOf = (day: number) => Math.floor((day - 1) / SEASON_LENGTH);
const yearOf = (day: number) => Math.floor((day - 1) / (SEASON_LENGTH * 4)) + 1;

/** Beats longer than this (≈3 lines) collapse behind a "show more" so a fuller
 *  date recap doesn't bloat the day's "what happened" list. */
const BEAT_CLAMP_CHARS = 150;

/** One "what happened" beat. Long beats (e.g. a fuller date recap) clamp to a few
 *  lines with an inline expand toggle; short beats render plain. Remounted per day
 *  (keyed by day) so the expanded state never leaks between days. */
function DayBeat({ beat }: { beat: DayRecordBeat }) {
  const { t } = useTranslation(['phone', 'common']);
  const [expanded, setExpanded] = useState(false);
  const long = beat.text.length > BEAT_CLAMP_CHARS;
  return (
    <div className={`pal-beat tone-${beat.tone}`}>
      <span className="pal-beat-icon" aria-hidden="true">
        {beat.icon}
      </span>
      <div className="pal-beat-body">
        <span className={`pal-beat-text${long && !expanded ? ' clamped' : ''}`}>{beat.text}</span>
        {long && (
          <button type="button" className="pal-beat-more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? t('calendar.showLess') : t('calendar.showMore')}
          </button>
        )}
      </div>
    </div>
  );
}

/** A calendar / almanac of every day: weather, what happened, and the day's recap. */
export function CalendarApp() {
  const { t } = useTranslation(['phone', 'common']);
  const { activeWorldId, dayTick } = useAppData();
  const [data, setData] = useState<WorldCalendar | null>(null);
  const [loading, setLoading] = useState(true);
  const [block, setBlock] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  const baseRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // A world switch reuses this component — clear any open day-detail / closing
    // state so a stale day from the previous world can't surface as a phantom.
    setSelected(null);
    setClosing(false);
    if (!activeWorldId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    let live = true;
    void api
      .worldCalendar(activeWorldId)
      .then((d) => {
        if (!live) return;
        setData(d);
        setBlock(blockOf(d.currentDay)); // open on the current season
      })
      .catch(() => live && setData(null))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [activeWorldId, dayTick]);

  const byDay = useMemo(() => {
    const m = new Map<number, CalendarEntry>();
    for (const e of data?.entries ?? []) m.set(e.day, e);
    return m;
  }, [data]);

  // While the day-detail is open it is a modal takeover: make the calendar behind
  // it inert (out of the tab order + hidden from AT) so focus can't leak through.
  useEffect(() => {
    if (baseRef.current) baseRef.current.inert = selected != null;
  }, [selected]);

  const closeDay = useCallback(() => setClosing(true), []);
  const handleClosed = useCallback(() => {
    setSelected(null);
    setClosing(false);
  }, []);

  if (!activeWorldId) {
    return (
      <div className="phone-app">
        <PhoneAppBar title={t('calendar.title')} kicker={t('calendar.kicker')} icon="calendar" />
        <div className="pal-app">
          <Empty icon={<Icon name="calendar" size={36} />} title={t('calendar.noWorldTitle')}>
            <p className="muted">{t('calendar.noWorldBody')}</p>
          </Empty>
        </div>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="phone-app">
        <PhoneAppBar title={t('calendar.title')} kicker={t('calendar.kicker')} icon="calendar" />
        <div className="pal-app">{loading ? <Spinner /> : <p className="muted center">{t('calendar.loadError')}</p>}</div>
      </div>
    );
  }

  const currentBlock = blockOf(data.currentDay);
  const viewBlock = block ?? currentBlock;
  const firstDay = viewBlock * SEASON_LENGTH + 1;
  const headCal = deriveCalendar(firstDay);
  const days = Array.from({ length: SEASON_LENGTH }, (_, i) => firstDay + i);
  const hasYears = data.currentDay > SEASON_LENGTH * 4;

  const openDay = (d: number) => {
    setSelected(d);
    setClosing(false);
  };

  const goToToday = () => {
    setBlock(currentBlock);
    setSelected(null);
  };

  return (
    <div className="phone-app pal-host">
      <div className="pal-base" ref={baseRef}>
      <PhoneAppBar
        title={t('calendar.title')}
        kicker={t('calendar.kicker')}
        icon="calendar"
        right={
          viewBlock !== currentBlock ? (
            <button className="pal-today-btn" onClick={goToToday} title={t('calendar.jumpToToday')}>
              {t('calendar.today')}
            </button>
          ) : null
        }
      />

      <div className="pal-app">
        {/* Season header — navigate between the seasons you've lived. */}
        <div className="pal-season">
          <button
            className="pal-nav"
            onClick={() => setBlock(Math.max(0, viewBlock - 1))}
            disabled={viewBlock <= 0}
            aria-label={t('calendar.prevSeason')}
          >
            <Icon name="chevronRight" size={18} className="pal-flip" />
          </button>
          <div className="pal-season-mid">
            <span className="pal-season-icon">{SEASON_ICONS[headCal.season]}</span>
            <div className="pal-season-text">
              <span className="pal-season-name">{seasonLabel(headCal.season)}</span>
              <span className="pal-season-sub">
                {hasYears ? t('calendar.yearPrefix', { year: yearOf(firstDay) }) : ''}
                {t('calendar.daysRange', { from: firstDay, to: firstDay + SEASON_LENGTH - 1 })}
              </span>
            </div>
          </div>
          <button
            className="pal-nav"
            onClick={() => setBlock(Math.min(currentBlock, viewBlock + 1))}
            disabled={viewBlock >= currentBlock}
            aria-label={t('calendar.nextSeason')}
          >
            <Icon name="chevronRight" size={18} />
          </button>
        </div>

        {/* Weekday legend — every season starts on a Monday. */}
        <div className="pal-week">
          {DAYS_OF_WEEK.map((d, i) => (
            <span key={i} className={`pal-wd${i >= 5 ? ' is-weekend' : ''}`}>
              {weekday2(d)}
            </span>
          ))}
        </div>

        {/* The 4×7 grid. Keyed by block so the entrance stagger replays on season change. */}
        <div className="pal-grid" key={viewBlock}>
          {days.map((d, i) => {
            const entry = byDay.get(d);
            const cal = deriveCalendar(d);
            const isFuture = d > data.currentDay;
            const isToday = d === data.currentDay;
            const rec = entry?.record ?? null;
            const beatCount = rec?.beats.length ?? 0;
            const cls = [
              'pal-cell',
              isFuture ? 'is-future' : 'is-past',
              isToday ? 'is-today' : '',
              cal.isWeekend ? 'is-weekend' : '',
              beatCount > 0 ? 'has-events' : '',
              cal.holiday ? 'is-holiday' : '',
            ]
              .filter(Boolean)
              .join(' ');
            // Fold every aria-hidden cell signal (weather, holiday, event dots)
            // into one spoken label so AT users get what sighted users see.
            const ariaLabel = [
              t('calendar.dayN', { d }),
              weekdayLabel(cal.dayOfWeek),
              entry ? weatherLabel(entry.weather.kind) : null,
              cal.holiday ? t('calendar.holidayAria', { name: cal.holiday.name }) : null,
              beatCount > 0 ? t('calendar.eventCount', { count: beatCount }) : null,
              isToday ? t('calendar.today') : isFuture ? t('calendar.upcoming') : null,
            ]
              .filter(Boolean)
              .join(', ');
            return (
              <button
                key={d}
                className={cls}
                style={{ animationDelay: `${Math.min(i * 11, 260)}ms` }}
                disabled={isFuture}
                onClick={() => !isFuture && openDay(d)}
                aria-label={ariaLabel}
                title={t('calendar.cellTitle', { day: d, weekday: weekdayLabel(cal.dayOfWeek) }) + (cal.holiday ? ` · ${cal.holiday.name}` : '')}
              >
                <span className="pal-cell-day">{d}</span>
                <span className="pal-cell-wx" aria-hidden="true">
                  {entry?.weather.icon ?? ''}
                </span>
                {cal.holiday && (
                  <span className="pal-cell-holiday" aria-hidden="true">
                    ✦
                  </span>
                )}
                {beatCount > 0 && (
                  <span className="pal-cell-dots" aria-hidden="true">
                    {rec!.beats.slice(0, 3).map((b, bi) => (
                      <i key={bi} className={`tone-${b.tone}`} />
                    ))}
                  </span>
                )}
                {isToday && <span className="pal-cell-today">{t('calendar.today')}</span>}
              </button>
            );
          })}
        </div>

        <p className="pal-foot">
          {data.currentDay > 1 ? t('calendar.footPast') : t('calendar.footStart')}
        </p>
      </div>
      </div>

      {selected != null && byDay.has(selected) && (
        <DayDetail
          day={selected}
          entry={byDay.get(selected) ?? null}
          isToday={selected === data.currentDay}
          closing={closing}
          onClose={closeDay}
          onClosed={handleClosed}
        />
      )}
    </div>
  );
}

function DayDetail({
  day,
  entry,
  isToday,
  closing,
  onClose,
  onClosed,
}: {
  day: number;
  entry: CalendarEntry | null;
  isToday: boolean;
  closing: boolean;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { t } = useTranslation(['phone', 'common']);
  const cal = deriveCalendar(day);
  const rec = entry?.record ?? null;
  const hasSummary = !!(rec && (rec.headline || rec.narrative));
  const backRef = useRef<HTMLButtonElement>(null);

  // Move focus into the dialog when it opens (so keyboard/AT users land here).
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  // Commit the unmount on a timer rather than on `animationend` — the close
  // animation is disabled under prefers-reduced-motion (no event would ever
  // fire), which would otherwise trap the user in the overlay. The timer matches
  // the out-animation; under reduced motion it closes immediately.
  useEffect(() => {
    if (!closing) return;
    const reduce =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const t = window.setTimeout(onClosed, reduce ? 0 : 280);
    return () => window.clearTimeout(t);
  }, [closing, onClosed]);

  return (
    <div
      className={`pal-detail ${closing ? 'is-closing' : 'is-opening'}`}
      role="dialog"
      aria-modal="true"
      aria-label={t('calendar.detailAria', { day })}
    >
      <div className="pal-detail-bar">
        <button className="pal-back" onClick={onClose} aria-label={t('calendar.backToCalendar')} ref={backRef}>
          <Icon name="chevronRight" size={18} className="pal-flip" />
          <span>{t('calendar.calendarLabel')}</span>
        </button>
        {rec && rec.income > 0 && (
          <span className="pal-coin" title={t('calendar.dailyIncome')}>
            <Icon name="coin" size={13} /> +{rec.income}
          </span>
        )}
      </div>

      <div className="pal-detail-scroll">
        {/* Date plate */}
        <div className="pal-plate">
          <div className="pal-plate-day">{t('calendar.dayN', { d: day })}</div>
          <div className="pal-plate-when">
            {SEASON_ICONS[cal.season]} {weekdayLabel(cal.dayOfWeek)} · {seasonLabel(cal.season)} {cal.seasonDay}
            {cal.isWeekend ? t('calendar.weekendSuffix') : ''}
          </div>
          {entry && (
            <div className="pal-plate-wx">
              <span className="pal-plate-wx-icon">{entry.weather.icon}</span> {t('weather.itsLabel', { label: weatherLabel(entry.weather.kind) })}
            </div>
          )}
        </div>

        {cal.holiday && (
          <div className="pal-holiday-banner">
            <strong>✦ {cal.holiday.name}</strong>
            <span>{cal.holiday.blurb}</span>
          </div>
        )}

        {/* The generated summary of the day */}
        {hasSummary ? (
          <div className="pal-recap">
            {rec!.headline && <h3 className="pal-recap-head">{rec!.headline}</h3>}
            {rec!.narrative && <p className="pal-recap-body">{rec!.narrative}</p>}
            {!rec!.reconstructed && rec!.highlights.length > 0 && (
              <ul className="pal-highlights">
                {rec!.highlights.map((h, i) => (
                  <li key={i}>{h}</li>
                ))}
              </ul>
            )}
            {rec!.reconstructed && <div className="pal-recon">{t('calendar.reconstructed')}</div>}
          </div>
        ) : (
          <div className="pal-recap pal-recap-quiet">
            <p className="muted">
              {isToday ? t('calendar.stillUnfolding') : t('calendar.quietDay')}
            </p>
          </div>
        )}

        {/* What happened — the day's beats */}
        {rec && rec.beats.length > 0 && (
          <>
            <div className="pal-eyebrow">{t('calendar.whatHappened')}</div>
            <div className="pal-beats">
              {rec.beats.map((b, i) => (
                <DayBeat key={`${day}-${i}`} beat={b} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
