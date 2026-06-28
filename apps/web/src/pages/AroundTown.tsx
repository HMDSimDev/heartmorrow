import './aroundtown.page.css';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Character } from '@dsim/shared';
import { api, type DiscoverySceneOccupant } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { useDiscoveryGate } from '../lib/useDiscovery';
import { Portrait } from '../components/Portrait';
import { Icon } from '../components/Icon';
import { Banner, Empty, Loader } from '../components/ui';

const KIND_ICON: Record<string, string> = {
  cafe: '☕', bar: '🍸', library: '📚', gym: '🏋', park: '🌳',
  restaurant: '🍽', shop: '🛍', workplace: '💼', campus: '🎓', other: '📍',
};

/** The "Around Town" map — discovery's living-world view. Walk into a place to see who's
 *  out this time-block and what they're doing. Read-only in Phase 2 (no meeting yet);
 *  unmet people stay anonymous. Refetches when the time-block changes. */
export function AroundTown() {
  const { t } = useTranslation(['pages', 'common']);
  const { activeWorldId, worldState, dayTick } = useAppData();
  const { isMet } = useDiscoveryGate(); // !discoveryOn (e.g. creator mode) → everyone is "known"
  const [selected, setSelected] = useState<string | null>(null);

  // Placement is per-phase, so refetch whenever the time-block (or day) turns over.
  const phaseKey = `${worldState?.day ?? 0}|${worldState?.phase ?? ''}|${dayTick}`;
  const town = useAsync(
    () => api.aroundTown(activeWorldId ?? ''),
    [activeWorldId, phaseKey],
  );
  const charsQ = useAsync(() => api.listCharacters(activeWorldId ?? undefined), [activeWorldId, dayTick]);
  const charById = new Map((charsQ.data ?? []).map((c) => [c.id, c]));
  const known = isMet;

  if (selected && activeWorldId) {
    return (
      <LocationScene
        worldId={activeWorldId}
        locationId={selected}
        refetchKey={phaseKey}
        charById={charById}
        known={known}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <div className="stack">
      <div className="page-head">
        <span className="kicker">{t('aroundTown.kicker')}</span>
        <h1>{t('aroundTown.title')}</h1>
        <p>{t('aroundTown.blurb')}</p>
      </div>

      <Loader state={town}>
        {(data) =>
          data.locations.length === 0 ? (
            <Empty icon={<Icon name="location" size={34} />} title={t('aroundTown.emptyTitle')}>
              <p>{t('aroundTown.emptyBody')}</p>
            </Empty>
          ) : (
            <div className="at-grid">
              {data.locations.map(({ location, open, occupantIds }) => {
                const faces = occupantIds.map((id) => charById.get(id)).filter((c): c is Character => !!c && known(c.id));
                return (
                  <button
                    key={location.id}
                    type="button"
                    className={`at-card${open ? '' : ' at-closed'}`}
                    disabled={!open}
                    onClick={() => open && setSelected(location.id)}
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
      {town.error && <Banner kind="error">{town.error}</Banner>}
    </div>
  );
}

function LocationScene({
  worldId,
  locationId,
  refetchKey,
  charById,
  known,
  onBack,
}: {
  worldId: string;
  locationId: string;
  refetchKey: string;
  charById: Map<string, Character>;
  known: (id: string) => boolean;
  onBack: () => void;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const scene = useAsync(() => api.locationScene(worldId, locationId), [worldId, locationId, refetchKey]);

  return (
    <div className="stack">
      <button className="btn ghost at-back" type="button" onClick={onBack}>
        ‹ {t('aroundTown.back')}
      </button>
      <Loader state={scene}>
        {(data) => {
          // Group co-present friends ("together") into one block; everyone else is solo.
          const clusters = new Map<number, DiscoverySceneOccupant[]>();
          const solo: DiscoverySceneOccupant[] = [];
          for (const o of data.occupants) {
            if (o.clusterId == null) solo.push(o);
            else {
              const g = clusters.get(o.clusterId);
              if (g) g.push(o);
              else clusters.set(o.clusterId, [o]);
            }
          }
          return (
            <div className="card at-scene">
              <div className="section-head">
                <div className="titles">
                  <span className="kicker">{t('aroundTown.youArrive')}</span>
                  <h2>{data.location.name}</h2>
                </div>
                <span className="trail" />
              </div>
              {data.location.description && <p className="muted">{data.location.description}</p>}

              {data.occupants.length === 0 ? (
                <Empty icon={<Icon name="location" size={30} />} title={t('aroundTown.nobodyHere')}>
                  <p>{t('aroundTown.nobodyHereBody')}</p>
                </Empty>
              ) : (
                <div className="at-occupants">
                  {[...clusters.values()].map((members, i) => (
                    <div className="at-together" key={`c${i}`}>
                      <span className="at-together-tag">{t('aroundTown.together')}</span>
                      {members.map((o) => (
                        <Occupant key={o.characterId} o={o} char={known(o.characterId) ? charById.get(o.characterId) ?? null : null} />
                      ))}
                    </div>
                  ))}
                  {solo.map((o) => (
                    <Occupant key={o.characterId} o={o} char={known(o.characterId) ? charById.get(o.characterId) ?? null : null} />
                  ))}
                </div>
              )}
            </div>
          );
        }}
      </Loader>
      {scene.error && <Banner kind="error">{scene.error}</Banner>}
    </div>
  );
}

function Occupant({ o, char }: { o: DiscoverySceneOccupant; char: Character | null }) {
  const { t } = useTranslation(['pages']);
  return (
    <div className="at-occ">
      <span className="at-occ-face">
        <Portrait character={char ?? { name: '???', portraitAssetId: null, expressionAssets: {} }} />
      </span>
      <div className="at-occ-body">
        <span className="at-occ-name">{char ? char.name : t('aroundTown.aStranger')}</span>
        <span className="at-occ-act">{o.activity}</span>
      </div>
    </div>
  );
}
