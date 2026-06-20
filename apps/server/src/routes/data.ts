import type { FastifyInstance } from 'fastify';
import { ExportBundleSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { exportAll, importAll, resetProgress } from '../services/data-service';
import { listEvents } from '../services/event-service';
import { listEndings } from '../services/ending-service';

export async function dataRoutes(app: FastifyInstance): Promise<void> {
  app.get('/events', async () => listEvents(200));

  /** Every "happy ending" reached — the gallery (scoped to the active world if given). */
  app.get('/endings', async (req) => {
    const { worldId } = req.query as { worldId?: string };
    return listEndings(worldId);
  });

  app.get('/export', async () => exportAll());

  app.post('/import', async (req) => {
    const bundle = parseInput(ExportBundleSchema, req.body);
    return importAll(bundle);
  });

  app.post('/reset', async () => resetProgress());
}
