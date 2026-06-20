import type { FeatureFlags } from '@dsim/shared';
import { worldsRepo } from '../db/repositories';
import { forbidden, notFound } from '../lib/errors';

/**
 * Server-side enforcement of per-world feature toggles. The client hides surfaces
 * for a feature that's off, but THIS is the actual gate — every property/market
 * route handler calls `requireFeature` first, so a URL-hopper can't trade on a
 * world that disabled the mechanic.
 */

export type FeatureKey = keyof FeatureFlags;

/** Whether a world has a given mechanic enabled (false for an unknown world). */
export function featureEnabled(worldId: string, key: FeatureKey): boolean {
  const world = worldsRepo.get(worldId);
  return !!world?.featureFlags?.[key];
}

/**
 * Throw unless the world exists AND has the given feature enabled. 404 for a
 * missing world, 403 for a real world that turned the mechanic off.
 */
export function requireFeature(worldId: string, key: FeatureKey): void {
  const world = worldsRepo.get(worldId);
  if (!world) throw notFound(`World ${worldId} not found.`);
  if (!world.featureFlags?.[key]) {
    throw forbidden(
      key === 'property'
        ? 'Property ownership is not enabled for this world.'
        : key === 'gambling'
          ? 'The casino is not enabled for this world.'
          : 'The stock market is not enabled for this world.',
    );
  }
}
