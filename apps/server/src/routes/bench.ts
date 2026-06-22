import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BenchRunCaseRequestSchema, BenchSaveRunRequestSchema, BenchBaselineValueSchema, BenchCancelRequestSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
import { docSchema } from '../lib/openapi-schema';
import { notFound } from '../lib/errors';
import { getLlmSettings } from '../services/settings-service';
import { buildBenchCatalog } from '../services/bench/cases';
import { runBenchCase, buildRunSummary } from '../services/bench/runner';
import { benchRunsStore, benchBaselinesStore } from '../services/bench/store';

/**
 * Heartmorrow Bench API. The client fetches the catalog, optionally saves human
 * baselines, runs cases ONE AT A TIME (so progress is naturally per-case), then
 * posts the assembled results to persist a run (the server computes the aggregate
 * + snapshots the settings it ran under).
 */
export async function benchRoutes(app: FastifyInstance): Promise<void> {
  // Maps a client run id → the AbortController of its currently-running case, so
  // `POST /bench/cancel` can stop the in-flight model calls without relying on the
  // browser→proxy→server connection close actually propagating.
  const activeRuns = new Map<string, AbortController>();

  app.get('/bench/catalog', { schema: docSchema({ tags: ['bench'], summary: 'Get the bench case catalog' }) }, async () => buildBenchCatalog(getLlmSettings().model));

  app.get('/bench/baselines', { schema: docSchema({ tags: ['bench'], summary: 'List saved human baselines' }) }, async () => ({ baselines: benchBaselinesStore.list() }));

  const BaselineBody = z.object({ value: BenchBaselineValueSchema, note: z.string().max(400).default('') });
  app.put('/bench/baselines/:caseId', { schema: docSchema({ tags: ['bench'], summary: 'Upsert a baseline for a case', body: BaselineBody }) }, async (req) => {
    const { caseId } = req.params as { caseId: string };
    const body = parseInput(BaselineBody, req.body ?? {});
    return benchBaselinesStore.upsert(caseId, body.value, body.note, Date.now());
  });
  app.delete('/bench/baselines/:caseId', { schema: docSchema({ tags: ['bench'], summary: 'Delete a baseline for a case' }) }, async (req) => {
    const { caseId } = req.params as { caseId: string };
    benchBaselinesStore.remove(caseId);
    return { ok: true };
  });

  // Execute a single case. May be slow on a local model (a dialogue case plays
  // several turns), so abort the server-side work when the client disconnects or
  // cancels. We listen on the RESPONSE socket (reply.raw) — req.raw's 'close'
  // fires once the request body is consumed and would abort the call prematurely.
  app.post('/bench/run-case', { schema: docSchema({ tags: ['bench'], summary: 'Run a single bench case', body: BenchRunCaseRequestSchema }) }, async (req, reply) => {
    const input = parseInput(BenchRunCaseRequestSchema, req.body ?? {});
    const ac = new AbortController();
    // Two abort paths, whichever fires first: (1) the explicit /bench/cancel
    // endpoint (reliable), and (2) the client disconnecting (best-effort — listen
    // on the RESPONSE socket; req.raw 'close' would fire as soon as the body is read).
    if (input.runId) activeRuns.set(input.runId, ac);
    let done = false;
    reply.raw.on('close', () => {
      if (!done) ac.abort();
    });
    try {
      return await runBenchCase(input, ac.signal);
    } finally {
      done = true;
      if (input.runId && activeRuns.get(input.runId) === ac) activeRuns.delete(input.runId);
    }
  });

  // Abort the in-flight case for a run. Idempotent; safe to call when nothing runs.
  app.post('/bench/cancel', { schema: docSchema({ tags: ['bench'], summary: 'Cancel the in-flight case for a run', body: BenchCancelRequestSchema }) }, async (req) => {
    const { runId } = parseInput(BenchCancelRequestSchema, req.body ?? {});
    const ac = activeRuns.get(runId);
    if (ac) ac.abort();
    return { ok: true, cancelled: Boolean(ac) };
  });

  app.post('/bench/runs', { schema: docSchema({ tags: ['bench'], summary: 'Persist a completed bench run', body: BenchSaveRunRequestSchema }) }, async (req) => {
    const input = parseInput(BenchSaveRunRequestSchema, req.body ?? {});
    const run = buildRunSummary(input.label, input.request, input.results, input.settings);
    benchRunsStore.save(run);
    return run;
  });

  app.get('/bench/runs', { schema: docSchema({ tags: ['bench'], summary: 'List saved bench runs' }) }, async () => ({ runs: benchRunsStore.list() }));

  app.get('/bench/runs/:id', { schema: docSchema({ tags: ['bench'], summary: 'Get a saved bench run by id' }) }, async (req) => {
    const { id } = req.params as { id: string };
    const run = benchRunsStore.get(id);
    if (!run) throw notFound('Bench run not found.');
    return run;
  });

  app.delete('/bench/runs/:id', { schema: docSchema({ tags: ['bench'], summary: 'Delete a saved bench run by id' }) }, async (req) => {
    const { id } = req.params as { id: string };
    benchRunsStore.remove(id);
    return { ok: true };
  });
}
