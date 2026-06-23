import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, type IconName } from '../components/Icon';
import './help.page.css';

type HelpSection = { heading: string; body: string[]; bullets?: string[] };
type HelpCategory = { label: string; title: string; overview: string; sections: HelpSection[] };

// Topic order + rail icon. The ids key into the `help.cats.<id>` catalog tree;
// every label and paragraph comes from i18n so the whole guide stays translatable.
const TOPICS: { id: string; icon: IconName }[] = [
  { id: 'getting-started', icon: 'info' },
  { id: 'dates', icon: 'date' },
  { id: 'evaluation', icon: 'star' },
  { id: 'relationships', icon: 'commit' },
  { id: 'phone', icon: 'phone' },
  { id: 'life-money', icon: 'coin' },
  { id: 'building', icon: 'edit' },
  { id: 'tips', icon: 'sparkle' },
];

export function Help() {
  const { t } = useTranslation(['pages', 'common']);
  const [active, setActive] = useState(TOPICS[0]?.id ?? 'getting-started');
  const topRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  // Each category is one nested object in the catalog; cast through the i18n
  // return so the typed paragraphs/bullets stay ergonomic in the markup.
  const cats = t('help.cats', { returnObjects: true }) as Record<string, HelpCategory>;
  const activeIndex = TOPICS.findIndex((x) => x.id === active);
  const current = cats[active];

  // Switching topics should start you at the top of the new one, not stranded
  // mid-scroll in the previous topic's content. Skip the very first render.
  useEffect(() => {
    if (mounted.current) topRef.current?.scrollIntoView({ block: 'start' });
    mounted.current = true;
  }, [active]);

  return (
    <div className="stack help-page" ref={topRef}>
      <div className="page-head">
        <div className="kicker">{t('help.head.kicker')}</div>
        <h1>{t('help.head.title')}</h1>
        <p>{t('help.head.blurb')}</p>
      </div>

      <div className="help-layout">
        <nav className="help-rail" aria-label={t('help.nav.topics')}>
          <div className="help-rail-head">{t('help.nav.topics')}</div>
          {TOPICS.map((topic, i) => {
            const cat = cats[topic.id];
            const isActive = active === topic.id;
            return (
              <button
                key={topic.id}
                type="button"
                className={`help-tab${isActive ? ' active' : ''}`}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => setActive(topic.id)}
              >
                <span className="ico">
                  <Icon name={topic.icon} size={18} />
                </span>
                {cat?.label ?? topic.id}
                <span className="help-tab-n">{i + 1}</span>
              </button>
            );
          })}
        </nav>

        <div className="help-content">
          {current && (
            <>
              <div className="section-head">
                <div className="titles">
                  <div className="kicker">
                    {t('help.topicOf', { n: activeIndex + 1, total: TOPICS.length })}
                  </div>
                  <h2>{current.title}</h2>
                </div>
                <div className="trail" />
              </div>

              <p className="help-overview">{current.overview}</p>

              {current.sections.map((s, si) => (
                <section className="help-section" key={si}>
                  <h3>{s.heading}</h3>
                  {s.body.map((p, pi) => (
                    <p key={pi}>{p}</p>
                  ))}
                  {s.bullets && s.bullets.length > 0 && (
                    <ul className="help-bullets">
                      {s.bullets.map((b, bi) => (
                        <li key={bi}>{b}</li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
