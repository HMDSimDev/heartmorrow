import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, ScriptedAdapter } from '../../test/helpers';
import { setAdapterOverride } from '../../llm/provider';
import { buildBenchCatalog, getBenchCase, BENCH_CASES, BENCH_GROUPS } from './cases';
import { runBenchCase, computeAggregate, buildRunSummary } from './runner';
import { benchRunsStore, benchBaselinesStore } from './store';

describe('bench catalog', () => {
  it('exposes every case across the declared groups', () => {
    const cat = buildBenchCatalog('test-model');
    expect(cat.model).toBe('test-model');
    expect(cat.cases.length).toBe(BENCH_CASES.length);
    expect(cat.cases.length).toBeGreaterThanOrEqual(30);
    // every case belongs to a declared group
    for (const c of cat.cases) expect(BENCH_GROUPS).toContain(c.group);
    // ids are unique
    const ids = new Set(cat.cases.map((c) => c.id));
    expect(ids.size).toBe(cat.cases.length);
  });

  it('every judge case has a baseline spec + scorer + built-in default; every case is runnable', () => {
    for (const def of BENCH_CASES) {
      if (def.kind === 'judge') {
        expect(def.baselineSpec, `${def.id} baselineSpec`).toBeTruthy();
        expect(def.score, `${def.id} score`).toBeTypeOf('function');
        expect(def.defaultBaseline, `${def.id} defaultBaseline`).toBeTruthy();
      }
      // runnable: structured OR dialogue
      expect(Boolean(def.structured) || Boolean(def.dialogue), `${def.id} runnable`).toBe(true);
    }
  });

  it('the four headline judges have the requested hardcoded default baselines', () => {
    expect(getBenchCase('judge_turn_good')!.defaultBaseline).toEqual({ engagement: 2 });
    expect(getBenchCase('judge_turn_bad')!.defaultBaseline).toEqual({ engagement: -3 });
    expect(getBenchCase('judge_text_warm')!.defaultBaseline).toEqual({ engagement: 2, hostile: false });
    expect(getBenchCase('judge_text_hostile')!.defaultBaseline).toEqual({ engagement: -3, hostile: true });
  });

  it('builds real prompts for a representative structured case', () => {
    const def = getBenchCase('judge_turn_good')!;
    const spec = def.structured!();
    expect(spec.messages.length).toBeGreaterThan(0);
    expect(spec.messages[0]!.role).toBe('system');
    // the sample transcript ends on the player's line (what the judge scores)
    expect(def.setup.transcript?.at(-1)?.speaker).toBe('player');
  });
});

describe('bench scoring', () => {
  it('engagement closeness is continuous; pure turn judges report agree=null', () => {
    const score = getBenchCase('judge_turn_good')!.score!;
    expect(score({ engagement: 2 }, { engagement: 2 }).closeness).toBe(1);
    const half = score({ engagement: 2 }, { engagement: -1 });
    expect(half.closeness).toBeCloseTo(0.5, 5);
    // continuous score → no categorical "same/different call" (matches the contract)
    expect(half.agree).toBeNull();
  });

  it('text judge folds the hostile flag into BOTH agreement and closeness', () => {
    const score = getBenchCase('judge_text_hostile')!.score!;
    const match = score({ engagement: -3, hostile: true }, { engagement: -3, hostile: true });
    expect(match.agree).toBe(true);
    expect(match.closeness).toBe(1);
    // engagement matches but hostility is missed → closeness must drop below 1
    const miss = score({ engagement: -3, hostile: true }, { engagement: -3, hostile: false });
    expect(miss.agree).toBe(false);
    expect(miss.closeness).toBeLessThan(1);
    expect(miss.closeness).toBeCloseTo(0.5, 5);
  });

  it('deltas closeness rewards matching the human', () => {
    const score = getBenchCase('judge_eval_good')!.score!;
    const perfect = score({ affection: 4, trust: 2 }, { relationshipDeltas: { affection: 4, trust: 2 } });
    expect(perfect.closeness).toBe(1);
    const off = score({ affection: 0 }, { relationshipDeltas: { affection: 15 } });
    expect(off.closeness).toBeLessThan(1);
  });

  it('boolean + choice are exact-match', () => {
    const walk = getBenchCase('judge_walkout')!.score!;
    expect(walk({ value: true }, { walkout: true }).agree).toBe(true);
    expect(walk({ value: true }, { walkout: false }).agree).toBe(false);
    const dtr = getBenchCase('judge_dtr')!.score!;
    expect(dtr({ choice: 'accept' }, { decision: 'accept' }).agree).toBe(true);
    expect(dtr({ choice: 'accept' }, { decision: 'backfire' }).agree).toBe(false);
  });
});

describe('bench runner', () => {
  beforeEach(() => {
    resetDb();
  });
  afterEach(() => {
    setAdapterOverride(null);
  });

  it('a saved user baseline overrides the built-in default', async () => {
    setAdapterOverride(new ScriptedAdapter(['{"engagement":2,"expression":"happy","note":"warm read"}']));
    // default for judge_turn_good is +2; save a DIFFERENT user baseline (0) to prove override
    benchBaselinesStore.upsert('judge_turn_good', { engagement: 0 }, '', 1);
    const res = await runBenchCase({ caseId: 'judge_turn_good', llmPlayer: false, dialogueTurns: 4 });
    expect(res.ok).toBe(true);
    expect(res.calls.length).toBeGreaterThan(0);
    expect(res.promptTokens).toBeGreaterThan(0); // chars/4 estimate (scripted adapter reports no usage)
    expect(res.tokensEstimated).toBe(true);
    expect(res.comparison?.human).toEqual({ engagement: 0 }); // the USER baseline, not the +2 default
    expect(res.comparison?.closeness).toBeCloseTo(1 - 2 / 6, 5); // |0 - 2| / 6
    expect(res.comparison?.agree).toBeNull(); // pure engagement judge → continuous, no categorical call
  });

  it('scores against the built-in default baseline when the user has not saved one', async () => {
    setAdapterOverride(new ScriptedAdapter(['{"engagement":-2,"expression":"uncomfortable","note":"x"}']));
    const res = await runBenchCase({ caseId: 'judge_turn_bad', llmPlayer: false, dialogueTurns: 4 });
    expect(res.ok).toBe(true);
    expect(res.comparison?.human).toEqual({ engagement: -3 }); // the hardcoded default
    expect(res.comparison?.closeness).toBeCloseTo(1 - 1 / 6, 5); // |−3 − (−2)| / 6 — scored without any user input
    expect(res.comparison?.llm).toEqual({ engagement: -2 });
  });

  it('FAILS a dialogue that loops (identical replies exceed the repetition threshold)', async () => {
    // identical canned reply every turn → maximal self-repetition → the case fails
    setAdapterOverride(new ScriptedAdapter(['{"body":"the fog is thick today","tone":"warm"}']));
    const res = await runBenchCase({ caseId: 'dialogue_text', llmPlayer: false, dialogueTurns: 2 });
    // 2 scripted player turns + 2 generated character turns
    expect(res.transcript.length).toBe(4);
    expect(res.transcript.filter((t) => t.role === 'character').length).toBe(2);
    expect(res.repetitionMax).toBeCloseTo(1, 5);
    expect(res.ok).toBe(false);
    expect(res.error.toLowerCase()).toContain('repetit');
  });

  it('PASSES a dialogue whose replies stay distinct (under the 25% threshold)', async () => {
    setAdapterOverride(
      new ScriptedAdapter([
        '{"body":"the fog finally lifted this morning, first real sun in days","tone":"warm"}',
        '{"body":"found that paperback you wanted, tucked behind the old atlases","tone":"playful"}',
        '{"body":"saturday suits me — swing by whenever, i will be around","tone":"warm"}',
      ]),
    );
    const res = await runBenchCase({ caseId: 'dialogue_text', llmPlayer: false, dialogueTurns: 3 });
    expect(res.ok).toBe(true);
    expect(res.repetitionMax).not.toBeNull();
    expect(res.repetitionMax!).toBeLessThan(0.25);
  });

  it('does not count failed/sentinel replies as self-repetition', async () => {
    // invalid JSON every time → every structured reply fails → no real replies
    setAdapterOverride(new ScriptedAdapter(['not valid json at all']));
    const res = await runBenchCase({ caseId: 'dialogue_text', llmPlayer: false, dialogueTurns: 3 });
    expect(res.ok).toBe(false);
    expect(res.repetitionMax).toBeNull(); // sentinels excluded, so no false 100% loop
    for (const turn of res.transcript.filter((t) => t.role === 'character')) {
      expect(turn.repetitionVsPrev).toBeNull();
    }
  });

  it('returns a failed result for an unknown case via the route helper path', async () => {
    await expect(runBenchCase({ caseId: 'does_not_exist', llmPlayer: false, dialogueTurns: 4 })).rejects.toThrow();
  });
});

describe('bench persistence + aggregate', () => {
  beforeEach(() => {
    resetDb();
  });
  afterEach(() => {
    setAdapterOverride(null);
  });

  it('round-trips baselines', () => {
    expect(benchBaselinesStore.list()).toEqual([]);
    const saved = benchBaselinesStore.upsert('judge_walkout', { value: true }, 'crosses a boundary', 42);
    expect(saved.value).toEqual({ value: true });
    expect(benchBaselinesStore.get('judge_walkout')?.note).toBe('crosses a boundary');
    benchBaselinesStore.upsert('judge_walkout', { value: false }, '', 43);
    expect(benchBaselinesStore.get('judge_walkout')?.value).toEqual({ value: false });
    expect(benchBaselinesStore.list().length).toBe(1);
  });

  it('saves, lists, fetches, and deletes runs; aggregate rolls up', async () => {
    setAdapterOverride(new ScriptedAdapter(['{"engagement":1,"expression":"happy","note":"x"}']));
    const res = await runBenchCase({ caseId: 'judge_turn_good', llmPlayer: false, dialogueTurns: 4 });
    const summary = buildRunSummary('unit run', { caseIds: [res.caseId], llmPlayer: false, dialogueTurns: 4, label: 'unit run' }, [res]);
    expect(summary.aggregate.cases).toBe(1);
    expect(summary.aggregate.passed).toBe(1);
    benchRunsStore.save(summary);
    const list = benchRunsStore.list();
    expect(list.length).toBe(1);
    expect(list[0]!.label).toBe('unit run');
    expect(benchRunsStore.get(summary.id)?.results.length).toBe(1);
    benchRunsStore.remove(summary.id);
    expect(benchRunsStore.list().length).toBe(0);
  });

  it('surfaces failed cases (incl. repetition failures) in the saved-runs list', async () => {
    setAdapterOverride(new ScriptedAdapter(['{"body":"the fog is thick today","tone":"warm"}'])); // identical → repetition fail
    const res = await runBenchCase({ caseId: 'dialogue_text', llmPlayer: false, dialogueTurns: 2 });
    expect(res.ok).toBe(false);
    const summary = buildRunSummary('fail run', { caseIds: [res.caseId], llmPlayer: false, dialogueTurns: 2, label: 'fail run' }, [res]);
    benchRunsStore.save(summary);
    const row = benchRunsStore.list().find((x) => x.id === summary.id)!;
    expect(row.failures.length).toBe(1);
    expect(row.failures[0]!.caseId).toBe('dialogue_text');
    expect(row.failures[0]!.label).toBeTruthy();
    expect(row.failures[0]!.error.toLowerCase()).toContain('repetit');
  });

  it('computeAggregate averages judge closeness only over scored cases', () => {
    const base = {
      label: '', group: '', kind: 'judge' as const, calls: [], promptTokens: 10, completionTokens: 5,
      totalLatencyMs: 100, attempts: 1, tokensPerSec: null, tokensEstimated: false, output: '', transcript: [],
      repetitionMax: null, repetitionAvg: null,
    };
    const agg = computeAggregate([
      { ...base, caseId: 'a', ok: true, error: '', comparison: { human: { engagement: 2 }, llm: { engagement: 2 }, closeness: 1, agree: true, rows: [] } },
      { ...base, caseId: 'b', ok: true, error: '', comparison: { human: { engagement: 2 }, llm: { engagement: 0 }, closeness: 0.5, agree: false, rows: [] } },
      { ...base, caseId: 'c', ok: false, error: 'boom', comparison: null },
    ]);
    expect(agg.cases).toBe(3);
    expect(agg.passed).toBe(2);
    expect(agg.failed).toBe(1);
    expect(agg.judgeCases).toBe(2);
    expect(agg.avgCloseness).toBeCloseTo(0.75, 5);
  });
});
