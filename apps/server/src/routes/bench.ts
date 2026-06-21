import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BenchRunCaseRequestSchema, BenchSaveRunRequestSchema, BenchBaselineValueSchema } from '@dsim/shared';
import { parseInput } from '../lib/validate';
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
  app.get('/bench/catalog', async () => buildBenchCatalog(getLlmSettings().model));

  app.get('/bench/baselines', async () => ({ baselines: benchBaselinesStore.list() }));

  const BaselineBody = z.object({ value: BenchBaselineValueSchema, note: z.string().max(400).default('') });
  app.put('/bench/baselines/:caseId', async (req) => {
    const { caseId } = req.params as { caseId: string };
    const body = parseInput(BaselineBody, req.body ?? {});
    return benchBaselinesStore.upsert(caseId, body.value, body.note, Date.now());
  });
  app.delete('/bench/baselines/:caseId', async (req) => {
    const { caseId } = req.params as { caseId: string };
    benchBaselinesStore.remove(caseId);
    return { ok: true };
  });

  // Execute a single case. May be slow on a local model (a dialogue case plays
  // several turns), so abort the server-side work when the client disconnects or
  // cancels. We listen on the RESPONSE socket (reply.raw) — req.raw's 'close'
  // fires once the request body is consumed and would abort the call prematurely.
  app.post('/bench/run-case', async (req, reply) => {
    const input = parseInput(BenchRunCaseRequestSchema, req.body ?? {});
    const ac = new AbortController();
    let done = false;
    reply.raw.on('close', () => {
      if (!done) ac.abort();
    });
    try {
      return await runBenchCase(input, ac.signal);
    } finally {
      done = true;
    }
  });

  app.post('/bench/runs', async (req) => {
    const input = parseInput(BenchSaveRunRequestSchema, req.body ?? {});
    const run = buildRunSummary(input.label, input.request, input.results, input.settings);
    benchRunsStore.save(run);
    return run;
  });

  app.get('/bench/runs', async () => ({ runs: benchRunsStore.list() }));

  app.get('/bench/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const run = benchRunsStore.get(id);
    if (!run) throw notFound('Bench run not found.');
    return run;
  });

  app.delete('/bench/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    benchRunsStore.remove(id);
    return { ok: true };
  });
}
