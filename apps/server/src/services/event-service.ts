import type { GameEvent } from '@dsim/shared';
import { GameEventSchema } from '@dsim/shared';
import { charactersRepo, eventsRepo } from '../db/repositories';
import { newId } from '../lib/ids';

/**
 * Resolve the world an event belongs to. Most producers already carry a worldId
 * (world-clock, world-sim); the date/relationship pipeline carries a characterId
 * (or subjectId/aId for gossip/world-sim pair events) from which the world is
 * derived via the character. Genuinely world-less events (import/reset, or a money
 * change with no world context) resolve to null and are excluded from per-world reads.
 */
function resolveWorldId(payload: Record<string, unknown>): string | null {
  const direct = payload.worldId;
  if (typeof direct === 'string' && direct) return direct;
  for (const key of ['characterId', 'subjectId', 'aId', 'bId'] as const) {
    const cid = payload[key];
    if (typeof cid === 'string' && cid) {
      const world = charactersRepo.get(cid)?.worldId;
      if (world) return world;
    }
  }
  // Per-world player ids carry the world: `player:${worldId}` (money/purchase events).
  const pid = payload.playerId;
  if (typeof pid === 'string' && pid.startsWith('player:')) return pid.slice('player:'.length);
  return null;
}

/** Record a game event for auditing / debugging. All stat mutations record one. */
export function recordEvent(type: string, payload: Record<string, unknown> = {}): GameEvent {
  const event = GameEventSchema.parse({
    id: newId('evt'),
    type,
    worldId: resolveWorldId(payload),
    payload,
    createdAt: Date.now(),
  });
  return eventsRepo.insert(event);
}

export function listEvents(limit = 100): GameEvent[] {
  return eventsRepo.list(limit);
}
