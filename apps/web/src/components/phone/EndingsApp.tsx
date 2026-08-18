import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Character, CharacterEnding } from '@dsim/shared';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Portrait } from '../Portrait';
import { Banner, Empty, Spinner } from '../ui';
import './phone-keepsakes.css';

/** The "happy endings" gallery — keepsake epilogues of relationships you've seen through. */
export function EndingsApp() {
  const { t } = useTranslation(['phone', 'common']);
  const { activeWorldId, dayTick } = useAppData();
  const [endings, setEndings] = useState<CharacterEnding[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void Promise.all([api.listEndings(activeWorldId ?? undefined), api.listCharacters()])
      .then(([e, c]) => {
        if (cancelled) return;
        setEndings(e);
        setCharacters(c);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorldId, dayTick]);

  const charOf = (id: string) => characters.find((c) => c.id === id) ?? null;

  return (
    <div className="phone-app">
      <PhoneAppBar title={t('endings.title')} kicker={t('endings.kicker')} icon="endings" />
      <div className="end-shell">
        {loading && <Spinner />}
        {!loading && error && <Banner kind="error">{error}</Banner>}
        {!loading && !error && endings.length === 0 && (
          <Empty icon={<Icon name="trophy" size={36} />} title={t('endings.emptyTitle')}>
            <p className="muted">{t('endings.emptyBody')}</p>
          </Empty>
        )}
        {!loading && !error && endings.length > 0 && (
          <>
            <div className="end-plate">
              {/* The app bar already says "Happy Endings" — repeating it here read
                  as a stutter. Count the collection instead; that's news. */}
              <div className="kicker">{t('endings.plateCount', { count: endings.length })}</div>
              <h2 className="end-plate-title">{t('endings.plateTitle')}</h2>
              <div className="end-plate-rule">✦ ✦ ✦</div>
            </div>
            {endings.map((e) => {
              const c = charOf(e.characterId);
              return (
                <div className="ph-rise end-keepsake" key={e.characterId}>
                  <div className="end-seal" aria-hidden="true">
                    <Icon name="trophy" size={16} />
                  </div>
                  <div className="end-head">
                    {c && (
                      <div style={{ width: 44, flexShrink: 0 }}>
                        <Portrait character={c} />
                      </div>
                    )}
                    <div>
                  <div className="end-title" dir="auto">{e.title}</div>
                      <span className="end-by">
                        {t('endings.by', { name: c?.name ?? t('endings.someone'), day: e.day })}
                      </span>
                    </div>
                  </div>
                  <div className="end-thread" />
                  <p className="end-prose" dir="auto">{e.epilogue}</p>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
