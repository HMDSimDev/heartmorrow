import { describe, it, expect, beforeEach } from 'vitest';
import { APP_REQUEST_HEADER } from '@dsim/shared';
import { resetDb, seedWorldAndCharacter } from '../test/helpers';
import { buildApp } from '../app';

/**
 * The local-app CSRF defense (app.ts onRequest hook): every mutating request
 * must carry APP_REQUEST_HEADER. A cross-origin page can fire "simple" POSTs at
 * the local server but cannot attach a custom header without a CORS preflight
 * the origin allowlist refuses — so header-less mutations are refused as
 * cross-site, while reads stay open.
 */
describe('cross-site request guard', () => {
  beforeEach(() => resetDb());

  it('refuses a header-less mutation (403) and allows the same request with the header', async () => {
    const { world } = seedWorldAndCharacter();
    const app = await buildApp({ logger: false });
    try {
      const bare = await app.inject({ method: 'POST', url: `/api/worlds/${world.id}/sleep` });
      expect(bare.statusCode).toBe(403);
      expect((bare.json() as { error: string }).error).toMatch(/cross-site/i);

      const withHeader = await app.inject({
        method: 'POST',
        url: `/api/worlds/${world.id}/sleep`,
        headers: { [APP_REQUEST_HEADER]: '1' },
      });
      expect(withHeader.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('reads stay open — GET needs no header', async () => {
    seedWorldAndCharacter();
    const app = await buildApp({ logger: false });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/worlds' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as unknown[]).length).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
