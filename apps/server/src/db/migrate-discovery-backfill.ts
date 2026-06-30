import { settingsRepo, worldsRepo } from './repositories';
import { getLlmSettings } from '../services/settings-service';
import { seedDiscoveryAcquaintances } from '../services/character-service';

/** Marker key (in app_settings) so this one-time backfill runs at most once. */
const MARKER = 'discovery_default_backfill_v1';

/**
 * One-time data migration for the day discovery became ON by default.
 *
 * `discoveryMode` flipped from off to on as the product default, so on an EXISTING save
 * everyone would suddenly read as ??? (no acquaintance flags were ever written in the
 * classic game). This backfills each world the same way enabling the toggle does — every
 * character the player has already interacted with becomes an acquaintance, so people you
 * dated/married stay visible — WITHOUT the toggle's day_records wipe, to preserve calendar
 * history. People you never met stay ??? (and a brand-new world, having no interaction
 * history and startKnownCount 0, correctly starts you knowing no one).
 *
 * No-op on a fresh install (no worlds) or when the player has turned discovery off. Self
 * -gated by {@link MARKER}; runs only at real-server startup (not in tests).
 */
export function migrateDiscoveryBackfill(): void {
  if (settingsRepo.getRaw(MARKER)) return; // already run
  if (getLlmSettings().discoveryMode) {
    for (const w of worldsRepo.list()) seedDiscoveryAcquaintances(w.id);
  }
  settingsRepo.set(MARKER, '1');
}
