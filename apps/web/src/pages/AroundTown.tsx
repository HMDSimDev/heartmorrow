import './aroundtown.page.css';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Character, Phase } from '@dsim/shared';
import { api, type RoomOccupantView } from '../lib/api';
import { useAsync, errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { useDiscoveryGate } from '../lib/useDiscovery';
import { Portrait } from '../components/Portrait';
import { Icon } from '../components/Icon';
import { Banner, Empty, Loader } from '../components/ui';

const KIND_ICON: Record<string, string> = {
  cafe: '☕', bar: '🍸', library: '📚', gym: '🏋', park: '🌳',
  restaurant: '🍽', shop: '🛍', workplace: '💼', campus: '🎓', other: '📍',
};

interface RoomState {
  locationId: string;
  name: string;
  day: number;
  phase: Phase;
  occupants: RoomOccupantView[];
  messages: { role: 'player' | 'room'; text: string }[];
  metNames: string[];
}

/**
 * Around Town — discovery's living-world view. The list of places is a free peek; stepping
 * into one (costs an action) opens it as a single freeform CHAT: a narrator + everyone
 * present. You introduce yourself / talk to anyone in natural language, and meeting someone
 * (the model flags it) reveals them in People. Unmet people stay anonymous.
 */
export function AroundTown() {
  const { t } = useTranslation(['pages', 'common']);
  const { activeWorldId, worldState, dayTick, refreshWorldState } = useAppData();
  const { isMet } = useDiscoveryGate();
  const [room, setRoom] = useState<RoomState | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const [input, setInput] = useState('');

  // Placement is per-phase, so the list refetches whenever the time-block turns over.
  const phaseKey = `${worldState?.day ?? 0}|${worldState?.phase ?? ''}|${dayTick}`;
  const town = useAsync(() => api.aroundTown(activeWorldId ?? ''), [activeWorldId, phaseKey]);
  const charsQ = useAsync(() => api.listCharacters(activeWorldId ?? undefined), [activeWorldId, dayTick]);
  const charById = new Map((charsQ.data ?? []).map((c) => [c.id, c]));
  const nameOf = (id: string) => charById.get(id)?.name ?? '';

  const enter = async (locationId: string, name: string) => {
    if (entering || !activeWorldId) return;
    setEntering(locationId);
    setErr(undefined);
    try {
      const res = await api.enterRoom(activeWorldId, locationId);
      setRoom({ locationId, name, day: res.day, phase: res.phase, occupants: res.occupants, messages: [{ role: 'room', text: res.reply }], metNames: [] });
      void refreshWorldState(); // entering cost an action (advances the clock)
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setEntering(null);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !room || busy || !activeWorldId) return;
    setInput('');
    const history = room.messages;
    setRoom((r) => (r ? { ...r, messages: [...r.messages, { role: 'player', text }] } : r));
    setBusy(true);
    try {
      const res = await api.roomSay(activeWorldId, room.locationId, room.day, room.phase, history, text);
      const newNames = res.introduced.map(nameOf).filter(Boolean);
      setRoom((r) =>
        r ? { ...r, occupants: res.occupants, messages: [...r.messages, { role: 'room', text: res.reply }], metNames: [...r.metNames, ...newNames] } : r,
      );
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // --- room chat view ---
  if (room) {
    const knownHere = room.occupants.filter((o) => o.known).map((o) => nameOf(o.characterId)).filter(Boolean);
    const unmetHere = room.occupants.length - room.occupants.filter((o) => o.known).length;
    const whoParts = [...knownHere];
    if (unmetHere > 0) whoParts.push(t('aroundTown.unmetCount', { count: unmetHere }));
    return (
      <div className="stack">
        <button className="btn ghost at-back" type="button" onClick={() => setRoom(null)}>‹ {t('aroundTown.back')}</button>
        <div className="card at-room">
          <div className="section-head">
            <div className="titles"><span className="kicker">{t('aroundTown.youArrive')}</span><h2>{room.name}</h2></div>
            <span className="trail" />
          </div>
          {whoParts.length > 0 && <p className="muted at-room-who">{t('aroundTown.hereNow', { who: whoParts.join(', ') })}</p>}

          <div className="at-room-reel">
            {room.messages.map((m, i) => (
              <div key={i} className={`at-room-msg ${m.role}`}>{m.text}</div>
            ))}
            {busy && (
              <div className="at-room-msg room at-room-typing" aria-label="…"><span /><span /><span /></div>
            )}
          </div>

          {room.metNames.length > 0 && (
            <Banner kind="ok">
              <Icon name="people" size={14} /> {t('aroundTown.metNote', { names: [...new Set(room.metNames)].join(', ') })}
            </Banner>
          )}
          {err && <Banner kind="error">{err}</Banner>}

          <div className="at-room-input">
            <textarea
              value={input}
              placeholder={t('aroundTown.sayPlaceholder')}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="btn primary" onClick={() => void send()} disabled={busy || !input.trim()}>
              <Icon name="send" size={15} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- location list view ---
  return (
    <div className="stack">
      <div className="page-head">
        <span className="kicker">{t('aroundTown.kicker')}</span>
        <h1>{t('aroundTown.title')}</h1>
        <p>{t('aroundTown.blurb')}</p>
      </div>
      {err && <Banner kind="error">{err}</Banner>}
      <Loader state={town}>
        {(data) =>
          data.locations.length === 0 ? (
            <Empty icon={<Icon name="location" size={34} />} title={t('aroundTown.emptyTitle')}>
              <p>{t('aroundTown.emptyBody')}</p>
            </Empty>
          ) : (
            <div className="at-grid">
              {data.locations.map(({ location, open, occupantIds }) => {
                const faces = occupantIds.map((id) => charById.get(id)).filter((c): c is Character => !!c && isMet(c.id));
                return (
                  <button
                    key={location.id}
                    type="button"
                    className={`at-card${open ? '' : ' at-closed'}`}
                    disabled={!open || entering === location.id}
                    onClick={() => open && void enter(location.id, location.name)}
                  >
                    <div className="at-card-head">
                      <span className="at-kind" aria-hidden="true">{KIND_ICON[location.kind] ?? '📍'}</span>
                      <h3 className="at-name">{location.name}</h3>
                      {!open && <span className="at-tag">{t('aroundTown.closed')}</span>}
                    </div>
                    {location.description && <p className="at-desc">{location.description}</p>}
                    <div className="at-who">
                      {occupantIds.length === 0 ? (
                        <span className="at-quiet">{t('aroundTown.quiet')}</span>
                      ) : (
                        <>
                          <div className="at-faces">
                            {faces.slice(0, 4).map((c) => (
                              <span className="at-face" key={c.id} title={c.name}>
                                <Portrait character={c} />
                              </span>
                            ))}
                          </div>
                          <span className="at-count">{t('aroundTown.present', { count: occupantIds.length })}</span>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )
        }
      </Loader>
    </div>
  );
}
