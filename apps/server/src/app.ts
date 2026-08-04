import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { MAX_UPLOAD_BYTES, PACK_MAX_FILE_BYTES } from '@dsim/shared';
import { config, ensureDirectories } from './config';
import { AppError } from './lib/errors';
import { healthRoutes } from './routes/health';
import { settingsRoutes } from './routes/settings';
import { promptRoutes } from './routes/prompts';
import { hydratePromptOverrides } from './services/prompt-override-service';
import { worldRoutes } from './routes/worlds';
import { characterRoutes } from './routes/characters';
import { assetRoutes } from './routes/assets';
import { conversationRoutes } from './routes/conversations';
import { shopRoutes } from './routes/shop';
import { propertyRoutes } from './routes/property';
import { marketRoutes } from './routes/market';
import { gamblingRoutes } from './routes/gambling';
import { minigameRoutes } from './routes/minigames';
import { playerRoutes } from './routes/player';
import { dataRoutes } from './routes/data';
import { packRoutes } from './routes/packs';
import { benchRoutes } from './routes/bench';
import { phoneRoutes } from './routes/phone';
import { activityRoutes } from './routes/activities';
import './services/phone-bootstrap'; // registers world-clock → phone lifecycle hooks

export interface BuildAppOptions {
  logger?: boolean;
  /** Register @fastify/swagger before routes so the docs generator can read them. */
  withSwagger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  ensureDirectories();

  // Load any installation-local prompt overrides into the registry cache so the
  // very first prompt the game builds already reflects the player's customizations.
  hydratePromptOverrides();

  const app = Fastify({
    logger: options.logger ?? true,
    // Track the share-file cap so a max-size import can never be refused at the
    // body layer before the pack routes' own limits get to see it.
    bodyLimit: PACK_MAX_FILE_BYTES,
  });

  // CORS is intentionally permissive for LOCAL DEV only (explicit origin list).
  await app.register(cors, { origin: config.corsOrigins, credentials: true });

  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
  });

  // Serve uploaded assets from the controlled uploads directory only.
  await app.register(fastifyStatic, {
    root: config.uploadsDir,
    prefix: '/uploads/',
    decorateReply: false,
    index: false,
    list: false,
  });

  // Serve the built web client when it exists (single-container / production
  // image). Guarded by existsSync so local two-process dev — where Vite serves
  // the client on :5173 — skips this branch entirely and is unaffected.
  const webDist = path.resolve(config.serverRoot, '../web/dist');
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      // Register a route per built asset (no catch-all), so unmatched client
      // routes fall through to the SPA fallback below. This registration
      // decorates reply.sendFile (the uploads one above opted out).
      wildcard: false,
      index: 'index.html',
    });
    // SPA fallback: any non-API, non-upload GET that matched no asset returns
    // index.html so client-side deep links (e.g. /games) resolve.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/uploads')) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'Not found.' });
    });
  }

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof AppError) {
      reply.code(err.statusCode).send({ error: err.message, details: err.details });
      return;
    }
    if (err instanceof ZodError) {
      reply.code(400).send({ error: 'Validation failed.', details: err.flatten() });
      return;
    }
    // Fastify/AJV schema validation failures (from route `schema` options) —
    // normalise to the same shape the manual parseInput() path returns.
    const validation = (err as { validation?: unknown }).validation;
    if (validation) {
      reply.code(400).send({ error: 'Validation failed.', details: validation });
      return;
    }
    const statusCode = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 500;
    if (statusCode >= 500) req.log.error(err);
    reply.code(statusCode).send({ error: err.message || 'Internal server error.' });
  });

  if (options.withSwagger) {
    const { default: fastifySwagger } = await import('@fastify/swagger');
    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: 'DSim API',
          description: 'Local-first LLM-powered dating simulator — HTTP API.',
          version: '0.1.0',
        },
        servers: [{ url: `http://${config.host}:${config.port}` }],
      },
    });
    // Lift docSchema's DOC-ONLY body schemas into `schema.body` so the generator
    // documents them. Runtime servers never do this: a validating body schema
    // rejects bodiless POSTs ("must be object" for an undefined body), and
    // parseInput() is the authoritative validator either way.
    app.addHook('onRoute', (route) => {
      const s = route.schema as { docBody?: unknown; body?: unknown } | undefined;
      if (s?.docBody) {
        s.body = s.docBody;
        delete s.docBody;
      }
    });
  }

  await app.register(
    async (api) => {
      await healthRoutes(api);
      await settingsRoutes(api);
      await promptRoutes(api);
      await worldRoutes(api);
      await characterRoutes(api);
      await assetRoutes(api);
      await conversationRoutes(api);
      await shopRoutes(api);
      await propertyRoutes(api);
      await marketRoutes(api);
      await gamblingRoutes(api);
      await minigameRoutes(api);
      await playerRoutes(api);
      await phoneRoutes(api);
      await activityRoutes(api);
      await dataRoutes(api);
      await packRoutes(api);
      await benchRoutes(api);
    },
    { prefix: '/api' },
  );

  return app;
}
