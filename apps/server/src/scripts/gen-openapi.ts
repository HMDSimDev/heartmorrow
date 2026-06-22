/**
 * Build-time OpenAPI generator.
 *
 * Boots the Fastify app with `@fastify/swagger` registered (via the
 * `withSwagger` build option) but never listens on a port, dumps the resulting
 * spec to `docs/openapi.json` at the repo root, and exits. Wired into the build
 * via `pnpm --filter @dsim/server run docs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Redirect all data/uploads access to the throwaway mock directory BEFORE the
// app/config modules are imported, so doc generation can never touch the real
// save database. (We never open the DB here anyway — no requests are served.)
process.env.DSIM_MOCK = '1';

async function main(): Promise<void> {
  const { buildApp } = await import('../app');
  const { config } = await import('../config');

  const app = await buildApp({ logger: false, withSwagger: true });
  await app.ready();

  const spec = (app as unknown as { swagger: () => unknown }).swagger();
  const docsDir = resolve(config.repoRoot, 'docs');
  mkdirSync(docsDir, { recursive: true });
  const outFile = resolve(docsDir, 'openapi.json');
  writeFileSync(outFile, `${JSON.stringify(spec, null, 2)}\n`);

  await app.close();
  const pathCount = Object.keys((spec as { paths?: Record<string, unknown> }).paths ?? {}).length;
  // eslint-disable-next-line no-console
  console.log(`Wrote ${outFile} (${pathCount} paths)`);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to generate OpenAPI spec:', err);
  process.exit(1);
});
