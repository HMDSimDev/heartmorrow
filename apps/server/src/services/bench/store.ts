/**
 * Heartmorrow Bench — persistence. Saved runs (the full `BenchRunSummary` as JSON)
 * and the human baselines for the scoring judges (keyed by case id, reused across
 * runs). Kept self-contained in the bench module rather than bloating the big
 * shared repositories file.
 */

import {
  BenchRunSummarySchema,
  BenchBaselineSchema,
  type BenchRunSummary,
  type BenchRunListItem,
  type BenchBaseline,
  type BenchBaselineValue,
} from '@dsim/shared';
import { getDb } from '../../db';
import type { Row } from '../../db/sqlite';

export const benchRunsStore = {
  save(run: BenchRunSummary): void {
    getDb().run(
      `INSERT INTO bench_runs (id, created_at, label, model, data) VALUES (?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET label = excluded.label, model = excluded.model, data = excluded.data`,
      run.id,
      run.createdAt,
      run.label,
      run.model,
      JSON.stringify(run),
    );
  },

  list(): BenchRunListItem[] {
    return getDb()
      .all<Row>('SELECT id, data FROM bench_runs ORDER BY created_at DESC')
      .flatMap((r) => {
        const parsed = BenchRunSummarySchema.safeParse(safeJson(r.data));
        if (!parsed.success) {
          console.warn(`[bench] skipping unparseable saved run ${String(r.id)}: ${parsed.error.message}`);
          return [];
        }
        const run = parsed.data;
        return [
          {
            id: run.id,
            createdAt: run.createdAt,
            label: run.label,
            model: run.model,
            aggregate: run.aggregate,
            failures: run.results
              .filter((c) => !c.ok)
              .map((c) => ({ caseId: c.caseId, label: c.label, group: c.group, kind: c.kind, error: c.error })),
          },
        ];
      });
  },

  get(id: string): BenchRunSummary | undefined {
    const r = getDb().get<Row>('SELECT data FROM bench_runs WHERE id = ?', id);
    if (!r) return undefined;
    const parsed = BenchRunSummarySchema.safeParse(safeJson(r.data));
    if (!parsed.success) {
      console.warn(`[bench] saved run ${id} failed to parse: ${parsed.error.message}`);
      return undefined;
    }
    return parsed.data;
  },

  remove(id: string): void {
    getDb().run('DELETE FROM bench_runs WHERE id = ?', id);
  },
};

export const benchBaselinesStore = {
  list(): BenchBaseline[] {
    return getDb()
      .all<Row>('SELECT case_id, value, note, updated_at FROM bench_baselines')
      .flatMap((r) => {
        const parsed = BenchBaselineSchema.safeParse({
          caseId: String(r.case_id),
          value: safeJson(r.value),
          note: String(r.note ?? ''),
          updatedAt: Number(r.updated_at),
        });
        return parsed.success ? [parsed.data] : [];
      });
  },

  get(caseId: string): BenchBaseline | undefined {
    const r = getDb().get<Row>('SELECT case_id, value, note, updated_at FROM bench_baselines WHERE case_id = ?', caseId);
    if (!r) return undefined;
    const parsed = BenchBaselineSchema.safeParse({
      caseId: String(r.case_id),
      value: safeJson(r.value),
      note: String(r.note ?? ''),
      updatedAt: Number(r.updated_at),
    });
    return parsed.success ? parsed.data : undefined;
  },

  upsert(caseId: string, value: BenchBaselineValue, note: string, when: number): BenchBaseline {
    getDb().run(
      `INSERT INTO bench_baselines (case_id, value, note, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(case_id) DO UPDATE SET value = excluded.value, note = excluded.note, updated_at = excluded.updated_at`,
      caseId,
      JSON.stringify(value),
      note,
      when,
    );
    return BenchBaselineSchema.parse({ caseId, value, note, updatedAt: when });
  },

  remove(caseId: string): void {
    getDb().run('DELETE FROM bench_baselines WHERE case_id = ?', caseId);
  },
};

function safeJson(value: unknown): unknown {
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}
