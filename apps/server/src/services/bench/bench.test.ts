import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDb, ScriptedAdapter } from '../../test/helpers';
import { setAdapterOverride } from '../../llm/provider';
import type { ChatAdapter, ChatRequest, ChatResult, GenerationStats, LlmModelInfo, TokenUsage } from '../../llm/types';
import { buildBenchCatalog, getBenchCase, BENCH_CASES, BENCH_GROUPS } from './cases';
import { runBenchCase, computeAggregate, buildRunSummary } from './runner';
import { benchRunsStore, benchBaselinesStore } from './store';

/** Adapter that returns a fixed payload PLUS an endpoint usage block and/or
 *  generation stats — to exercise the bench's endpoint-measured tok/sec path. */
class StatsAdapter implements ChatAdapter {
  readonly name = 'stats';
  calls = 0;
  constructor(
    private readonly payload: string,
    private readonly extra: { usage?: TokenUsage; stats?: GenerationStats } = {},
  ) {}
  async chat(): Promise<ChatResult> {
    this.calls += 1;
    return { content: this.payload, usage: this.extra.usage, stats: this.extra.stats };
  }
  async streamChat(_req: ChatRequest, onDelta: (t: string) => void): Promise<ChatResult> {
    const r = await this.chat();
    onDelta(r.content);
    return r;
  }
  async listModels(): Promise<LlmModelInfo[]> {
    return [];
  }
}

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

  it('the Generators/Prose run-preset tags are sane', () => {
    const cat = buildBenchCatalog('test-model');
    const generators = cat.cases.filter((c) => c.tags.includes('generator'));
    const prose = cat.cases.filter((c) => c.tags.includes('prose'));
    // both presets actually select something
    expect(generators.length).toBeGreaterThan(0);
    expect(prose.length).toBeGreaterThan(0);
    // tags only ride on generation cases, and the two buckets never overlap
    for (const c of cat.cases) {
      if (c.tags.length) expect(c.kind, `${c.id} kind`).toBe('generation');
      expect(c.tags.includes('generator') && c.tags.includes('prose'), `${c.id} dual-tagged`).toBe(false);
    }
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

  it('the headline judges have the requested hardcoded default baselines', () => {
    expect(getBenchCase('judge_turn_good')!.defaultBaseline).toEqual({ engagement: 2 });
    expect(getBenchCase('judge_turn_bad')!.defaultBaseline).toEqual({ engagement: -2 }); // ordinary-rude, not heinous
    expect(getBenchCase('judge_turn_heinous')!.defaultBaseline).toEqual({ engagement: -3 }); // reserved −3 tier
    expect(getBenchCase('judge_turn_swoon')!.defaultBaseline).toEqual({ engagement: 3 }); // reserved +3 tier
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
  it('engagement: off-by-1 passes, off-by-2+ fails; pure turn judges report agree=null', () => {
    const score = getBenchCase('judge_turn_good')!.score!;
    expect(score({ engagement: 2 }, { engagement: 2 }).pass).toBe(true);
    expect(score({ engagement: 3 }, { engagement: 2 }).pass).toBe(true); // off by 1 → pass
    const off = score({ engagement: 2 }, { engagement: 0 });
    expect(off.pass).toBe(false); // off by 2 → fail
    const half = score({ engagement: 2 }, { engagement: -1 });
    expect(half.pass).toBe(false);
    expect(half.closeness).toBeCloseTo(0.5, 5);
    expect(half.agree).toBeNull(); // continuous → no categorical call (matches the contract)
  });

  it('text judge: a missed hostility call fails, and folds into closeness', () => {
    const score = getBenchCase('judge_text_hostile')!.score!;
    const match = score({ engagement: -3, hostile: true }, { engagement: -3, hostile: true });
    expect(match.agree).toBe(true);
    expect(match.closeness).toBe(1);
    expect(match.pass).toBe(true);
    // engagement matches but hostility is missed → fail (and closeness drops)
    const miss = score({ engagement: -3, hostile: true }, { engagement: -3, hostile: false });
    expect(miss.agree).toBe(false);
    expect(miss.pass).toBe(false);
    expect(miss.closeness).toBeCloseTo(0.5, 5);
    expect(miss.failReason.toLowerCase()).toContain('hostil');
  });

  it('deltas: close passes, a gross all-stats miss fails', () => {
    const score = getBenchCase('judge_eval_good')!.score!;
    const perfect = score({ affection: 4, trust: 2 }, { relationshipDeltas: { affection: 4, trust: 2 } });
    expect(perfect.closeness).toBe(1);
    expect(perfect.pass).toBe(true);
    const gross = score({ affection: 4, trust: 3, chemistry: 3 }, { relationshipDeltas: { affection: -10, trust: -10, chemistry: -10 } });
    expect(gross.pass).toBe(false);
  });

  it('boolean + choice fail on a flipped call', () => {
    const walk = getBenchCase('judge_walkout')!.score!;
    expect(walk({ value: true }, { walkout: true }).pass).toBe(true);
    expect(walk({ value: true }, { walkout: false }).pass).toBe(false);
    const dtr = getBenchCase('judge_dtr')!.score!;
    expect(dtr({ choice: 'accept' }, { decision: 'accept' }).pass).toBe(true);
    expect(dtr({ choice: 'accept' }, { decision: 'backfire' }).pass).toBe(false);
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
    // default for judge_turn_good is +2; save a DIFFERENT user baseline (+1, still within tolerance of the model's +2) to prove override
    benchBaselinesStore.upsert('judge_turn_good', { engagement: 1 }, '', 1);
    const res = await runBenchCase({ caseId: 'judge_turn_good', llmPlayer: false, dialogueTurns: 4 });
    expect(res.ok).toBe(true);
    expect(res.calls.length).toBeGreaterThan(0);
    expect(res.promptTokens).toBeGreaterThan(0); // chars/4 estimate (scripted adapter reports no usage)
    expect(res.tokensEstimated).toBe(true);
    expect(res.comparison?.human).toEqual({ engagement: 1 }); // the USER baseline, not the +2 default
    expect(res.comparison?.closeness).toBeCloseTo(1 - 1 / 6, 5); // |1 - 2| / 6
    expect(res.comparison?.pass).toBe(true); // off by 1 → within tolerance
  });

  it('reports endpoint-MEASURED decode speed when the endpoint provides generation stats', async () => {
    setAdapterOverride(
      new StatsAdapter('{"engagement":2,"expression":"happy","note":"x"}', {
        usage: { promptTokens: 800, completionTokens: 30 },
        // The endpoint says it decoded in 0.5s (excludes the big prompt's prefill).
        stats: { tokensPerSecond: 60, generationTimeSec: 0.5 },
      }),
    );
    const res = await runBenchCase({ caseId: 'judge_turn_good', llmPlayer: false, dialogueTurns: 4 });
    expect(res.ok).toBe(true);
    expect(res.speedMeasured).toBe(true);
    // 30 tokens over the reported 0.5s of DECODE time = 60 tok/s — NOT tokens/round-trip.
    expect(res.genTimeMs).toBeCloseTo(500, 5);
    expect(res.tokensPerSec).toBeCloseTo(60, 5);
  });

  it('falls back to end-to-end latency for tok/sec when the endpoint reports no generation stats', async () => {
    setAdapterOverride(
      new StatsAdapter('{"engagement":2,"expression":"happy","note":"x"}', {
        usage: { promptTokens: 800, completionTokens: 30 },
      }),
    );
    const res = await runBenchCase({ caseId: 'judge_turn_good', llmPlayer: false, dialogueTurns: 4 });
    expect(res.ok).toBe(true);
    // No stats → the speed is an end-to-end estimate, flagged so the UI can mark it.
    expect(res.speedMeasured).toBe(false);
    // Decode time falls back to the round-trip latency (never the 0.5s a stats block would give).
    expect(res.genTimeMs).toBe(res.totalLatencyMs);
  });

  it('scores against the built-in default baseline when the user has not saved one', async () => {
    setAdapterOverride(new ScriptedAdapter(['{"engagement":-2,"expression":"uncomfortable","note":"x"}']));
    const res = await runBenchCase({ caseId: 'judge_turn_bad', llmPlayer: false, dialogueTurns: 4 });
    expect(res.ok).toBe(true); // default −2 (ordinary-rude, not heinous) vs model −2 → exact match
    expect(res.comparison?.human).toEqual({ engagement: -2 }); // the hardcoded default
    expect(res.comparison?.pass).toBe(true);
    expect(res.comparison?.llm).toEqual({ engagement: -2 });
  });

  it('FAILS a judge when the model misjudges beyond tolerance', async () => {
    // default for judge_turn_good is +2; model reads it −1 → off by 3 → fail
    setAdapterOverride(new ScriptedAdapter(['{"engagement":-1,"expression":"cold","note":"x"}']));
    const res = await runBenchCase({ caseId: 'judge_turn_good', llmPlayer: false, dialogueTurns: 4 });
    expect(res.ok).toBe(false);
    expect(res.comparison?.pass).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('FAILS a text judge that misses real hostility (baseline hostile, model says no)', async () => {
    // default for judge_text_hostile is {engagement:-3, hostile:true}; model matches the
    // number but calls it NOT hostile → fail, per the requested rule
    setAdapterOverride(new ScriptedAdapter(['{"engagement":-3,"hostile":false,"note":"x"}']));
    const res = await runBenchCase({ caseId: 'judge_text_hostile', llmPlayer: false, dialogueTurns: 4 });
    expect(res.ok).toBe(false);
    expect(res.comparison?.pass).toBe(false);
    expect(res.error.toLowerCase()).toContain('hostil');
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

  it('FAILS a Faces post whose mood label is empty (extra validate gate)', async () => {
    setAdapterOverride(new ScriptedAdapter(['{"body":"a quiet day at the bindery","mood":""}']));
    const res = await runBenchCase({ caseId: 'gen_feed_post', llmPlayer: false, dialogueTurns: 4 });
    expect(res.ok).toBe(false);
    expect(res.error.toLowerCase()).toContain('mood');
  });

  it('PASSES a Faces post that has a mood label', async () => {
    setAdapterOverride(new ScriptedAdapter(['{"body":"a quiet day at the bindery","mood":"wistful"}']));
    const res = await runBenchCase({ caseId: 'gen_feed_post', llmPlayer: false, dialogueTurns: 4 });
    expect(res.ok).toBe(true);
  });

  it('FAILS a Faces comment whose tone label is empty', async () => {
    setAdapterOverride(new ScriptedAdapter(['{"body":"so proud of you","tone":""}']));
    const res = await runBenchCase({ caseId: 'gen_feed_comment', llmPlayer: false, dialogueTurns: 4 });
    expect(res.ok).toBe(false);
    expect(res.error.toLowerCase()).toContain('tone');
  });

  it('PASSES from-text character generation when a fleshed-out draft comes back', async () => {
    setAdapterOverride(
      new ScriptedAdapter([
        '{"name":"Bramwell Ashby","personality":"Stubborn and gruff, secretly romantic; lights up talking craft.","speechStyle":"clipped, warms up over tea"}',
      ]),
    );
    const res = await runBenchCase({ caseId: 'gen_character', llmPlayer: false, dialogueTurns: 4 });
    expect(res.ok).toBe(true);
  });

  it('FAILS from-text character generation when no usable character comes back (blank name)', async () => {
    // A model that ignored the brief still parses (every field .catch-defaults), but
    // leaves the name blank — the validate gate fails it as an unusable draft.
    setAdapterOverride(new ScriptedAdapter(['{"name":"","personality":"whatever"}']));
    const res = await runBenchCase({ caseId: 'gen_character', llmPlayer: false, dialogueTurns: 4 });
    expect(res.ok).toBe(false);
    expect(res.error.toLowerCase()).toContain('name');
  });

  it('honors an aborted signal — stops a dialogue before sending any turn', async () => {
    setAdapterOverride(new ScriptedAdapter(['{"body":"hi","tone":"warm"}']));
    const ac = new AbortController();
    ac.abort();
    const res = await runBenchCase({ caseId: 'dialogue_text', llmPlayer: false, dialogueTurns: 4 }, ac.signal);
    expect(res.transcript.length).toBe(0);
    expect(res.calls.length).toBe(0);
  });

  it('honors an aborted signal — a structured judge bails before any model call', async () => {
    setAdapterOverride(new ScriptedAdapter(['{"engagement":2,"expression":"happy","note":"x"}']));
    const ac = new AbortController();
    ac.abort();
    const res = await runBenchCase({ caseId: 'judge_turn_good', llmPlayer: false, dialogueTurns: 4 }, ac.signal);
    expect(res.ok).toBe(false);
    expect(res.calls.length).toBe(0);
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
      totalLatencyMs: 100, attempts: 1, tokensPerSec: null, tokensEstimated: false, genTimeMs: 0, speedMeasured: false, output: '', transcript: [],
      repetitionMax: null, repetitionAvg: null, structuredMode: null,
    };
    const agg = computeAggregate([
      { ...base, caseId: 'a', ok: true, error: '', comparison: { human: { engagement: 2 }, llm: { engagement: 2 }, closeness: 1, agree: null, pass: true, rows: [] } },
      { ...base, caseId: 'b', ok: true, error: '', comparison: { human: { engagement: 2 }, llm: { engagement: 0 }, closeness: 0.5, agree: null, pass: false, rows: [] } },
      { ...base, caseId: 'c', ok: false, error: 'boom', comparison: null },
    ]);
    expect(agg.cases).toBe(3);
    expect(agg.passed).toBe(2);
    expect(agg.failed).toBe(1);
    expect(agg.judgeCases).toBe(2);
    expect(agg.avgCloseness).toBeCloseTo(0.75, 5);
  });

  it('computeAggregate counts structured-output fallbacks by final mode (a fallback is not a failure)', () => {
    const base = {
      label: '', group: '', kind: 'generation' as const, calls: [], promptTokens: 10, completionTokens: 5,
      totalLatencyMs: 100, attempts: 1, tokensPerSec: null, tokensEstimated: false, genTimeMs: 0, speedMeasured: false, output: '', transcript: [],
      repetitionMax: null, repetitionAvg: null, comparison: null,
    };
    const agg = computeAggregate([
      // ran at the requested mode — no fallback
      { ...base, caseId: 'a', ok: true, error: '', structuredMode: { requested: 'json_schema', final: 'json_schema' } },
      // fell back one step, still passed
      { ...base, caseId: 'b', ok: true, error: '', structuredMode: { requested: 'json_schema', final: 'json_object' } },
      // fell back two steps, still passed
      { ...base, caseId: 'c', ok: true, error: '', structuredMode: { requested: 'json_schema', final: 'prompt_only' } },
      // another to prompt_only
      { ...base, caseId: 'd', ok: true, error: '', structuredMode: { requested: 'json_schema', final: 'prompt_only' } },
      // free-text dialogue — no structured call at all
      { ...base, caseId: 'e', ok: true, error: '', kind: 'dialogue' as const, structuredMode: null },
    ]);
    expect(agg.structuredFallbacks).toBe(3); // b, c, d
    expect(agg.fallbackByMode).toEqual({ json_object: 1, prompt_only: 2 });
    // fallbacks never inflate the failure count
    expect(agg.failed).toBe(0);
    expect(agg.passed).toBe(5);
  });

  it('computeAggregate bases avg tok/sec on decode time, not round-trip latency', () => {
    const base = {
      label: '', group: '', kind: 'generation' as const, calls: [], promptTokens: 200,
      attempts: 1, tokensPerSec: 100, tokensEstimated: false, output: '', transcript: [],
      repetitionMax: null, repetitionAvg: null, comparison: null, structuredMode: null,
    };
    // Two endpoint-measured cases. Round-trip latency is huge (prefill-heavy) but the
    // decode time is small — the aggregate rate must follow decode time, so latency
    // must NOT leak into avgTokensPerSec.
    const agg = computeAggregate([
      { ...base, caseId: 'a', ok: true, error: '', completionTokens: 100, totalLatencyMs: 9000, genTimeMs: 1000, speedMeasured: true },
      { ...base, caseId: 'b', ok: true, error: '', completionTokens: 50, totalLatencyMs: 4000, genTimeMs: 500, speedMeasured: true },
    ]);
    // 150 tokens over 1.5s of DECODE = 100 tok/s — not 150 / 13s of round-trip.
    expect(agg.avgTokensPerSec).toBeCloseTo(100, 5);
    expect(agg.speedEstimated).toBe(false);
  });

  it('computeAggregate flags speed as estimated when a token-bearing case fell back to latency', () => {
    const base = {
      label: '', group: '', kind: 'generation' as const, calls: [], promptTokens: 10,
      attempts: 1, tokensPerSec: null, tokensEstimated: false, output: '', transcript: [],
      repetitionMax: null, repetitionAvg: null, comparison: null, structuredMode: null,
    };
    const agg = computeAggregate([
      { ...base, caseId: 'a', ok: true, error: '', completionTokens: 40, totalLatencyMs: 800, genTimeMs: 800, tokensPerSec: 50, speedMeasured: false },
      // an all-failed case (no tokens) must NOT trip the estimate flag on its own
      { ...base, caseId: 'b', ok: false, error: 'boom', completionTokens: 0, totalLatencyMs: 500, genTimeMs: 0, speedMeasured: false },
    ]);
    expect(agg.speedEstimated).toBe(true);
    // rate from the one token-bearing case's decode time: 40 / 0.8s = 50
    expect(agg.avgTokensPerSec).toBeCloseTo(50, 5);
  });
});
