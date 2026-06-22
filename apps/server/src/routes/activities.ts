import type { FastifyInstance } from 'fastify';
import { PerformActivitySchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { docSchema } from '../lib/openapi-schema';
import { listActivities, performActivity } from '../services/activity-service';

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/activities',
    { schema: docSchema({ tags: ['activities'], summary: 'List available activities' }) },
    async () => listActivities(),
  );

  app.post(
    '/activities/perform',
    {
      schema: docSchema({
        tags: ['activities'],
        summary: 'Perform an activity',
        body: PerformActivitySchema,
      }),
    },
    async (req) => {
      const input = parseInput(PerformActivitySchema, req.body);
      return performActivity(input);
    },
  );
}
