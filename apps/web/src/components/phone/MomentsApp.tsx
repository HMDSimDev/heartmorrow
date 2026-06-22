import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Character, Moment } from '@dsim/shared';
import { api } from '../../lib/api';
import { useAppData } from '../../state/app-context';
import { relativeTime } from '../../i18n/labels';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { PortraitPicker } from '../PortraitPicker';
import { Portrait } from '../Portrait';
import { Empty } from '../ui';
import './phone-keepsakes.css';

const KIND_ICON: Record<Moment['kind'], string> = {
  milestone: '💞',
  date: '💬',
  jealousy: '💔',
  walkout: '🚪',
  status: '💍',
  memory: '🧠',
};

/**
 * The face on each polaroid is keyed to what the moment was, so the scrapbook
 * reads emotionally — a beaming milestone, a hurt jealousy, a stony walkout.
 * These are canonical EXPRESSIONS; Portrait falls back to the base portrait when
 * a character has no asset authored for that expression, so this never breaks.
 */
const KIND_EXPRESSION: Record<Moment['kind'], string> = {
  milestone: 'happy',
  date: 'smiling',
  jealousy: 'hurt',
  walkout: 'angry',
  status: 'tender',
  memory: 'thoughtful',
};

/** A scrapbook of your story with one character — milestones, dates, and keepsakes. */
export function MomentsApp() {
  const { t } = useTranslation(['phone', 'common']);
  const { activeWorldId, dayTick } = useAppData();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [moments, setMoments] = useState<Moment[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void api
      .listCharacters()
      .then((cs) => {
        // Only this world's people have a scrapbook here.
        const inWorld = cs.filter((c) => !activeWorldId || c.worldId === activeWorldId);
        setCharacters(inWorld);
        setSelected((cur) => (cur && inWorld.some((c) => c.id === cur) ? cur : inWorld[0]?.id ?? null));
      })
      .catch(() => undefined);
  }, [activeWorldId, dayTick]);

  // The `live` flag drops an out-of-order response so switching from A to B
  // mid-fetch can't leave A's moments showing under B. Re-keyed on dayTick so a
  // new day's beats appear.
  useEffect(() => {
    if (!selected) return;
    let live = true;
    setLoading(true);
    void api
      .getMoments(selected)
      .then((m) => live && setMoments(m))
      .catch(() => live && setMoments([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [selected, dayTick]);

  const character = characters.find((c) => c.id === selected) ?? null;

  if (characters.length === 0) {
    return (
      <div className="phone-app">
        <PhoneAppBar title={t('moments.title')} kicker={t('moments.kicker')} icon="moments" />
        <div className="mom-shell">
          <Empty icon={<Icon name="moments" size={36} />} title={t('moments.noOneTitle')}>
            <p className="muted">{t('moments.noOneBody')}</p>
          </Empty>
        </div>
      </div>
    );
  }

  const pickerOptions = characters.map((c) => ({ id: c.id, character: c }));

  return (
    <div className="phone-app">
      <PhoneAppBar title={t('moments.title')} kicker={t('moments.kicker')} icon="moments" />
      <div className="mom-shell">
        <div className="mom-pick">
          <div className="kicker">{t('moments.chooseSomeone')}</div>
          <PortraitPicker
            options={pickerOptions}
            value={selected}
            onChange={(id) => setSelected(id)}
            compact
          />
        </div>

        {character && (
          <div className="mom-cover">
            <div className="mom-snap" style={{ width: 56 }}>
              <Portrait character={character} />
            </div>
            <div className="mom-cover-text">
              <h3 className="mom-name">{character.name}</h3>
              <span className="mom-since">{t('moments.storyTogether')}</span>
              {moments.length > 0 && (
                <span className="mom-count">
                  {t('moments.memoryCount', { count: moments.length })}
                </span>
              )}
            </div>
          </div>
        )}

        {loading ? null : moments.length === 0 ? (
          <Empty icon={<Icon name="moments" size={36} />} title={t('moments.emptyTitle')}>
            <p className="muted">{t('moments.emptyBody')}</p>
          </Empty>
        ) : (
          <div className="mom-reel">
            {moments.map((m) => (
              <div className={`ph-rise mom-clip kind-${m.kind}`} key={m.id}>
                {character && (
                  <div className="mom-clip-snap">
                    <Portrait character={character} expression={KIND_EXPRESSION[m.kind]} />
                    <span className="mom-clip-stamp">{KIND_ICON[m.kind]}</span>
                  </div>
                )}
                <div className="flex-fill">
                  <div className="mom-title">{m.title}</div>
                  {m.body && <div className="mom-body">{m.body}</div>}
                  <div className="mom-when">{m.day != null ? t('moments.day', { day: m.day }) : relativeTime(m.createdAt)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
