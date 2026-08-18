import { afterEach, describe, expect, it, vi } from 'vitest';
import { LmStudioAdapter } from './lmstudio-adapter';

function makeAdapter() {
  return new LmStudioAdapter({
    baseUrl: 'http://localhost:1234/api/v0',
    apiKey: '',
    model: 'local-model',
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('LmStudioAdapter.listModels', () => {
  it('prefers the context allocated to the loaded instance over the architecture maximum', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'local-model',
                state: 'loaded',
                max_context_length: 262_144,
                loaded_context_length: 32_000,
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(makeAdapter().listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'local-model', loaded: true, contextLength: 32_000 }),
    ]);
  });

  it('falls back to the model maximum when the loaded allocation is unavailable', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'local-model', max_context_length: 65_536 }] }), {
          status: 200,
        }),
      ),
    );

    await expect(makeAdapter().listModels()).resolves.toEqual([
      expect.objectContaining({ id: 'local-model', contextLength: 65_536 }),
    ]);
  });
});
