import type { FastifyInstance } from 'fastify';
import { ExportBundleSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { exportAll, importAll, resetProgress } from '../services/data-service';
import { listEvents } from '../services/event-service';
import { listEndings } from '../services/ending-service';
import { docSchema, WorldScopedQuerySchema } from '../lib/openapi-schema';

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  app.get('/events', { schema: docSchema({ tags: ['data'], summary: 'List recent game events' }) }, async () => listEvents(200));

  /** Every "happy ending" reached — the gallery (scoped to the active world if given). */
  app.get('/endings', { schema: docSchema({ tags: ['data'], summary: 'List endings reached, optionally per world', querystring: WorldScopedQuerySchema }) }, async (req) => {
    const { worldId } = req.query as { worldId?: string };
    return listEndings(worldId);
  });

  app.get('/export', { schema: docSchema({ tags: ['data'], summary: 'Export all save data as a bundle' }) }, async () => exportAll());

  app.post('/import', { schema: docSchema({ tags: ['data'], summary: 'Import save data from a bundle', body: ExportBundleSchema }) }, async (req) => {
    const bundle = parseInput(ExportBundleSchema, req.body);
    return importAll(bundle);
  });

  app.post('/reset', { schema: docSchema({ tags: ['data'], summary: 'Reset all progress' }) }, async () => resetProgress());
}
