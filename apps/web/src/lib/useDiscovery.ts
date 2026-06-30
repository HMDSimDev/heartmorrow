import { useMemo } from 'react';
import { api } from './api';
import { useAsync } from './hooks';
import { useAppData } from '../state/app-context';

/**
 * Discovery-aware visibility for player-facing character lists (pickers, rosters).
 *
 * When the global `discoveryMode` setting is on the player may only see people they have
 * MET; creator mode and discovery-off are unaffected. Fails SAFE: until the settings have
 * loaded (`!discoveryReady`), discovery is treated as ON so unmet names never flash before
 * the toggle is known.
 *
 * Usage: `const { visible } = useDiscoveryGate();` then `visible(characters)`, or use
 * `discoveryOn` + `metIds` directly inside a `useMemo` (both are stable across renders).
 */
export function useDiscoveryGate() {
  const { creatorMode, activeWorldId, discoveryMode, discoveryReady, dayTick } = useAppData();
  const discoveredQ = useAsync(() => api.listDiscovered(activeWorldId ?? undefined), [activeWorldId, dayTick]);
  const discoveryOn = !creatorMode && (!discoveryReady || discoveryMode);
  const metIds = useMemo(() => new Set(discoveredQ.data ?? []), [discoveredQ.data]);

  const isMet = (id: string): boolean => !discoveryOn || metIds.has(id);
  const visible = <T extends { id: string }>(chars: T[]): T[] =>
    discoveryOn ? chars.filter((c) => metIds.has(c.id)) : chars;

  return { discoveryOn, metIds, isMet, visible };
}
