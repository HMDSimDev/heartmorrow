import { buildApp } from './app';
import { config, ensureDirectories } from './config';
import { closeDatabase, initDatabase } from './db/index';
import { migratePlayerIdentity } from './db/migrate-player-identity';
import { backfillAssetHashes } from './services/asset-service';

async function main(): Promise<void> {
  ensureDirectories();
  initDatabase();
  migratePlayerIdentity(); // move a legacy global player onto the oldest world (one-time)

  const app = await buildApp();

  // Graceful shutdown on Ctrl-C / `docker stop`: stop accepting connections,
  // then close SQLite so the WAL is checkpointed instead of killed mid-write.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info(`Received ${signal}, shutting down`);
      void app
        .close()
        .catch((err) => app.log.error(err, 'Error while closing the server'))
        .finally(() => {
          closeDatabase();
          process.exit(0);
        });
    });
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`DSim server listening on http://${config.host}:${config.port}`);
  app.log.info(`Uploads served from ${config.uploadsDir}`);
  app.log.info(`Database at ${config.dbPath}`);

  // Stamp content hashes onto assets uploaded before dedup existed. Deferred so
  // it never delays the port opening; idempotent, so a crash mid-pass is fine.
  setImmediate(() => {
    try {
      const stamped = backfillAssetHashes();
      if (stamped > 0) app.log.info(`Backfilled content hashes for ${stamped} asset(s)`);
    } catch (err) {
      app.log.warn(err, 'Asset hash backfill failed');
    }
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start DSim server:', err);
  process.exit(1);
});
