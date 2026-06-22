import type { FastifyInstance } from 'fastify';
import { docSchema } from '../lib/openapi-schema';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    { schema: docSchema({ tags: ['health'], summary: 'Server health and liveness check' }) },
    async () => ({ ok: true, service: 'dsim-server', time: Date.now() }),
  );
}
