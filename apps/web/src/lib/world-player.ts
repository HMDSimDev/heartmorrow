import type { PlayerProfile } from '@dsim/shared';
import { api } from './api';

export interface WorldPlayer {
  worldId: string;
  profile: PlayerProfile;
}

export async function loadWorldPlayer(worldId: string | null | undefined): Promise<WorldPlayer | null> {
  if (!worldId) return null;
  const profile = await api.getPlayer(worldId);
  return { worldId, profile };
}
