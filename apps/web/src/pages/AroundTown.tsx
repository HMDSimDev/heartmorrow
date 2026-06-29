import './aroundtown.page.css';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Character, Location } from '@dsim/shared';
import { api, assetUrl } from '../lib/api';
import { useAsync, errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { useDiscoveryGate } from '../lib/useDiscovery';
import { Portrait } from '../components/Portrait';
import { Icon } from '../components/Icon';
import { Banner, ConfirmDialog, Empty, Loader } from '../components/ui';

const KIND_ICON: Record<string, string> = {
  cafe: '☕', bar: '🍸', library: '📚', gym: '🏋', park: '🌳',
  restaurant: '🍽', shop: '🛍', workplace: '💼', campus: '🎓', other: '📍',
};

/**
 * Around Town — discovery's living-world view. The list of places is a free peek; stepping
 * into one (costs an action) opens it as a single freeform CHAT: a narrator + everyone
 * present. You introduce yourself / talk to anyone in natural language, and meeting someone
 * (the model flags it) reveals them in People — surfaced inline as its own chat bubble.
 *
 * The room is SERVER-TRUTH + RESUMABLE: it lives in `activeRoom` (app context), so leaving
 * and returning to the tab drops you back into the same visit, and the same lock a date
 * uses blocks day-spending actions while you're out. Unmet people stay anonymous.
 */
export function AroundTown() {
  const { t } = useTranslation(['pages', 'common']);
  const { activeWorldId, worldState, dayTick, bumpDayTick, refreshWorldState, assetById, activeRoom, setActiveRoom } = useAppData();
  const { isMet } = useDiscoveryGate();
  const [entering, setEntering] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const [input, setInput] = useState('');

  // Placement is per-phase, so the list refetches whenever the time-block turns over.
  const phaseKey = `${worldState?.day ?? 0}|${worldState?.phase ?? ''}|${dayTick}`;
  const town = useAsync(() => api.aroundTown(activeWorldId ?? ''), [activeWorldId, phaseKey]);
  const charsQ = useAsync(() => api.listCharacters(activeWorldId ?? undefined), [activeWorldId, dayTick]);
  const charById = new Map((charsQ.data ?? []).map((c) => [c.id, c]));
  const nameOf = (id: string) => charById.get(id)?.name ?? '';
  const imageOf = (loc: Location) => assetById(loc.imageAssetId)?.path ?? null;

  const enter = async (loc: Location) => {
    if (entering || busy || !activeWorldId) return;
    setEntering(loc.id);
    setErr(undefined);
    try {
      const room = await api.enterRoom(activeWorldId, loc.id);
      setActiveRoom(room);
      void refreshWorldState(); // entering cost an action (advances the clock)
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setEntering(null);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !activeRoom || busy || !activeWorldId) return;
    setInput('');
    setBusy(true);
    setErr(undefined);
    // Echo the player's line immediately; the server returns the full room (this line +
    // the reply) which replaces the optimistic copy. Roll it back if the turn fails.
    const prev = activeRoom;
    setActiveRoom({ ...prev, messages: [...prev.messages, { role: 'player', text }] });
    try {
      setActiveRoom(await api.roomSay(activeWorldId, text));
    } catch (e) {
      setActiveRoom(prev);
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    if (!activeWorldId || leaving) return;
    setConfirmLeave(false);
    setLeaving(true);
    setErr(undefined);
    try {
      await api.leaveRoom(activeWorldId);
      setActiveRoom(null);
      // Back to the map: refetch occupancy + anyone newly met during the visit.
      bumpDayTick();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setLeaving(false);
    }
  };

  // --- room chat view (server-truth; resumes automatically) ---
  if (activeRoom) {
    const photo = assetById(activeRoom.imageAssetId)?.path ?? null;
    const knownHere = activeRoom.occupants.filter((o) => o.known).map((o) => nameOf(o.characterId)).filter(Boolean);
    const unmetHere = activeRoom.occupants.filter((o) => !o.known).length;
    const whoParts = [...knownHere];
    if (unmetHere > 0) whoParts.push(t('aroundTown.unmetCount', { count: unmetHere }));
    // The visit just ended on the server because the player got thrown out — show the
    // final beat, lock the composer, and let them step back to the map (no confirm).
    const ejected = activeRoom.ended;
    return (
      <div className="stack">
        {confirmLeave && !ejected && (
          <ConfirmDialog
            kicker={t('aroundTown.leaveConfirm.kicker')}
            title={t('aroundTown.leaveConfirm.title')}
            body={t('aroundTown.leaveConfirm.body')}
            confirmLabel={t('aroundTown.leaveConfirm.confirm')}
            busy={leaving}
            onConfirm={() => void leave()}
            onCancel={() => setConfirmLeave(false)}
          />
        )}
        <button
          className="btn ghost at-back"
          type="button"
          onClick={() => (ejected ? void leave() : setConfirmLeave(true))}
          disabled={leaving}
        >
          ‹ {ejected ? t('aroundTown.ejected.back') : t('aroundTown.leave')}
        </button>
        <div className="card flush at-room">
          {/* Cinematic scene header — the venue photo as a backdrop with a legible
              scrim, the place + who's-here floated over it as HUD chips (mirrors a date). */}
          <div className={`at-scene${photo ? ' has-photo' : ''}`}>
            {photo && (
              <div className="at-scene-backdrop" aria-hidden="true">
                <img src={assetUrl(photo)} alt="" />
              </div>
            )}
            <span className="at-scene-lead">
              <Icon name="location" size={16} className="ph" />
              <span className="loc">{activeRoom.locationName}</span>
            </span>
            {whoParts.length > 0 && (
              <span className="at-chip at-chip-who">
                <Icon name="people" size={13} /> {whoParts.join(', ')}
              </span>
            )}
          </div>

          <div className="at-room-reel">
            {activeRoom.messages.map((m, i) =>
              m.role === 'meet' ? (
                <div key={i} className="at-room-meet">
                  <Icon name="people" size={14} /> {t('aroundTown.metNote', { names: m.text })}
                </div>
              ) : m.role === 'eject' ? (
                <div key={i} className="at-room-eject">
                  <Icon name="leave" size={14} /> {t('aroundTown.ejected.beat')}
                </div>
              ) : (
                <div key={i} className={`at-room-msg ${m.role}`}>{m.text}</div>
              ),
            )}
            {busy && (
              <div className="at-room-msg room at-room-typing" aria-label="…"><span /><span /><span /></div>
            )}
          </div>

          <div className="at-room-foot">
            {err && <Banner kind="error">{err}</Banner>}
            {ejected ? (
              <div className="at-room-kicked">
                <Banner kind="error">{t('aroundTown.ejected.notice', { place: activeRoom.locationName, days: activeRoom.banDaysLeft })}</Banner>
                <button className="btn primary" onClick={() => void leave()} disabled={leaving}>
                  {t('aroundTown.ejected.back')}
                </button>
              </div>
            ) : (
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
                <button className="btn primary at-send" onClick={() => void send()} disabled={busy || !input.trim()}>
                  <Icon name="send" size={15} />
                </button>
              </div>
            )}
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
              {data.locations.map(({ location, open, occupantIds, bannedDays }) => {
                const faces = occupantIds.map((id) => charById.get(id)).filter((c): c is Character => !!c && isMet(c.id));
                const photo = imageOf(location);
                const isEntering = entering === location.id;
                const banned = bannedDays > 0;
                return (
                  <button
                    key={location.id}
                    type="button"
                    className={`at-card${open ? '' : ' at-closed'}${banned ? ' at-banned' : ''}${photo ? ' has-photo' : ''}${isEntering ? ' at-entering' : ''}`}
                    disabled={!open || banned || !!entering}
                    onClick={() => open && !banned && void enter(location)}
                  >
                    {photo && (
                      <div className="at-card-photo" aria-hidden="true">
                        <img src={assetUrl(photo)} alt="" />
                      </div>
                    )}
                    <div className="at-card-head">
                      <span className="at-kind" aria-hidden="true">{KIND_ICON[location.kind] ?? '📍'}</span>
                      <h3 className="at-name">{location.name}</h3>
                      {banned ? (
                        <span className="at-tag banned">{t('aroundTown.bannedTag', { days: bannedDays })}</span>
                      ) : (
                        !open && <span className="at-tag">{t('aroundTown.closed')}</span>
                      )}
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
                    {isEntering && (
                      <div className="at-entering-veil">
                        <span className="at-spinner" aria-hidden="true" />
                        <span>{t('aroundTown.entering')}</span>
                      </div>
                    )}
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
