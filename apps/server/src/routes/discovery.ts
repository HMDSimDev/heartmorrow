import type { FastifyInstance } from 'fastify';
import { badRequest, notFound } from '../lib/errors';
import { getWorld } from '../services/world-service';
import { requireFeature } from '../services/world-feature-service';
import { ensureWorldState } from '../services/world-clock-service';
import { composeLocationScene, getPlacements, isLocationOpen } from '../services/placement-service';
import { isRedacted, stampGlimpsed } from '../services/discovery-service';
import { enterRoom, roomSay, getActiveRoom, leaveRoom } from '../services/room-service';
import { docSchema, WorldScopedQuerySchema } from '../lib/openapi-schema';

/**
 * Location-based discovery reads — the "Around Town" tab. All gated by
 * `featureFlags.discovery`. Placement is derived live from the world's current
 * time-block, so the views always reflect "right now"; the client refetches on the
 * phase tick. Occupants are returned as ids + templated activities (never names), so
 * the client redacts unmet people to ??? itself.
 */
export async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  // The town this time-block: discoverable venues (closed ones flagged) + who's present.
  app.get(
    '/around-town',
    {
      schema: docSchema({
        tags: ['discovery'],
        summary: "List a world's locations and who is present this time-block",
        querystring: WorldScopedQuerySchema,
      }),
    },
    async (req) => {
      const { worldId } = req.query as { worldId?: string };
      if (!worldId) throw badRequest('worldId is required.');
      requireFeature(worldId, 'discovery');
      const world = getWorld(worldId);
      const state = ensureWorldState(worldId);
      const placements = getPlacements(worldId, state.day, state.phase);
      const byLoc = new Map<string, string[]>();
      for (const [id, p] of placements) {
        if (!p.locationId) continue;
        const arr = byLoc.get(p.locationId);
        if (arr) arr.push(id);
        else byLoc.set(p.locationId, [id]);
      }
      const locations = world.locations
        .filter((l) => l.discoverable)
        .map((l) => ({ location: l, open: isLocationOpen(l, state.phase), occupantIds: (byLoc.get(l.id) ?? []).sort() }));
      return { day: state.day, phase: state.phase, locations };
    },
  );

  // One location's scene: occupants (with a templated activity) + "together" clusters.
  // Entering leaves a `glimpsed` breadcrumb for unmet occupants (the one write-on-entry).
  app.get(
    '/around-town/scene',
    {
      schema: docSchema({
        tags: ['discovery'],
        summary: "Get a location's scene (occupants, activities, clusters) this time-block",
        querystring: WorldScopedQuerySchema,
      }),
    },
    async (req) => {
      const { worldId, locationId } = req.query as { worldId?: string; locationId?: string };
      if (!worldId || !locationId) throw badRequest('worldId and locationId are required.');
      requireFeature(worldId, 'discovery');
      const world = getWorld(worldId);
      const loc = world.locations.find((l) => l.id === locationId);
      if (!loc || !loc.discoverable) throw notFound('That location is not part of this world.');
      const state = ensureWorldState(worldId);
      const scene = composeLocationScene(worldId, state.day, state.phase, locationId);
      for (const o of scene.occupants) {
        if (isRedacted(worldId, o.characterId)) stampGlimpsed(o.characterId, locationId);
      }
      return { location: loc, day: state.day, phase: state.phase, occupants: scene.occupants, clusters: scene.clusters };
    },
  );

  // The world's live, resumable room session (if any) — for auto-resume on the tab,
  // and the "you're out around town" lock that mirrors a live date.
  app.get(
    '/around-town/active-room',
    {
      schema: docSchema({
        tags: ['discovery'],
        summary: 'Get the in-progress Around Town room for a world',
        querystring: WorldScopedQuerySchema,
      }),
    },
    async (req) => {
      const { worldId } = req.query as { worldId?: string };
      if (!worldId) throw badRequest('worldId is required.');
      requireFeature(worldId, 'discovery');
      return { room: getActiveRoom(worldId) };
    },
  );

  // Enter a location's CHAT: costs one action (or resumes an open room). Returns the
  // persisted, pinned room session.
  app.post(
    '/around-town/enter',
    { schema: docSchema({ tags: ['discovery'], summary: "Enter a location's chat (costs one action)" }) },
    async (req) => {
      const { worldId, locationId } = req.body as { worldId?: string; locationId?: string };
      if (!worldId || !locationId) throw badRequest('worldId and locationId are required.');
      requireFeature(worldId, 'discovery');
      return enterRoom(worldId, locationId);
    },
  );

  // One turn of the live room: server-truth history. Flagged introductions unlock people.
  app.post(
    '/around-town/say',
    { schema: docSchema({ tags: ['discovery'], summary: 'Send a line to the live location chat' }) },
    async (req) => {
      const { worldId, text } = req.body as { worldId?: string; text?: string };
      if (!worldId || !text?.trim()) throw badRequest('worldId and text are required.');
      requireFeature(worldId, 'discovery');
      return roomSay(worldId, text);
    },
  );

  // Leave the room (ends the visit) — clears the lock. Idempotent.
  app.post(
    '/around-town/leave',
    { schema: docSchema({ tags: ['discovery'], summary: 'Leave the live location chat' }) },
    async (req) => {
      const { worldId } = req.body as { worldId?: string };
      if (!worldId) throw badRequest('worldId is required.');
      requireFeature(worldId, 'discovery');
      leaveRoom(worldId);
      return { ok: true as const };
    },
  );
}
