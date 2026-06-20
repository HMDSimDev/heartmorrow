import { useEffect, useState } from 'react';
import type { Character, CharacterEnding } from '@dsim/shared';
import { api } from '../../lib/api';
import { useAppData } from '../../state/app-context';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Portrait } from '../Portrait';
import { Empty } from '../ui';
import './phone-keepsakes.css';

/** The "happy endings" gallery — keepsake epilogues of relationships you've seen through. */
export function EndingsApp() {
  const { activeWorldId, dayTick } = useAppData();
  const [endings, setEndings] = useState<CharacterEnding[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.listEndings(activeWorldId ?? undefined), api.listCharacters()])
      .then(([e, c]) => {
        if (cancelled) return;
        setEndings(e);
        setCharacters(c);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeWorldId, dayTick]);

  const charOf = (id: string) => characters.find((c) => c.id === id) ?? null;

  return (
    <div className="phone-app">
      <PhoneAppBar title="Endings" kicker="Happy Endings" icon="endings" />
      <div className="end-shell">
        {endings.length === 0 ? (
          <Empty icon={<Icon name="trophy" size={36} />} title="No endings yet">
            <p className="muted">
              See a relationship all the way through — move in together and stay deeply in love — to reach a happy ending.
              It's a celebration, not a finish: you can always keep playing.
            </p>
          </Empty>
        ) : (
          <>
            <div className="end-plate">
              <div className="kicker">Happy Endings</div>
              <h2 className="end-plate-title">Treasured Epilogues</h2>
              <div className="end-plate-rule">✦ ✦ ✦</div>
            </div>
            {endings.map((e) => {
              const c = charOf(e.characterId);
              return (
                <div className="end-keepsake" key={e.characterId}>
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
                      <div className="end-title">{e.title}</div>
                      <span className="end-by">
                        {c?.name ?? 'Someone'} · Day {e.day}
                      </span>
                    </div>
                  </div>
                  <div className="end-thread" />
                  <p className="end-prose">{e.epilogue}</p>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
