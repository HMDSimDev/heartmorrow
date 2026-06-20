import { buildApp } from './app';
import { config, ensureDirectories } from './config';
import { initDatabase } from './db/index';
import { migratePlayerIdentity } from './db/migrate-player-identity';

async function main(): Promise<void> {
  ensureDirectories();
  initDatabase();
  migratePlayerIdentity(); // move a legacy global player onto the oldest world (one-time)

  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`DSim server listening on http://${config.host}:${config.port}`);
  app.log.info(`Uploads served from ${config.uploadsDir}`);
  app.log.info(`Database at ${config.dbPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start DSim server:', err);
  process.exit(1);
});
