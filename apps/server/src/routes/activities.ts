import type { FastifyInstance } from 'fastify';
import { PerformActivitySchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { listActivities, performActivity } from '../services/activity-service';

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/activities', async () => listActivities());

  app.post('/activities/perform', async (req) => {
    const input = parseInput(PerformActivitySchema, req.body);
    return performActivity(input);
  });
}
