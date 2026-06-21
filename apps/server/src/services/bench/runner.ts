/**
 * Heartmorrow Bench — execution.
 *
 * Runs ONE case at a time (the client drives the loop, so each case is a normal
 * request and progress is naturally per-case). For each case it builds the REAL
 * prompt, calls the configured model, captures tokens-in/out + latency + attempts,
 * and — for the scoring judges — compares the model's verdict to the saved human
 * baseline. Dialogue cases play several turns and measure self-repetition so you
 * can see a model start to loop or lose the plot.
 */

import {
  BenchCaseResultSchema,
  BenchRunSummarySchema,
  MessageSchema,
  type BenchCaseResult,
  type BenchCallMetric,
  type BenchComparison,
  type BenchComparisonRow,
  type BenchAggregate,
  type BenchRunSummary,
  type BenchRunRequest,
  type BenchRunCaseRequest,
  type BenchSettingsSnapshot,
  type Message,
  type LlmSettings,
} from '@dsim/shared';
import type { TokenUsage } from '../../llm/types';
import type { ChatMessage } from '../../llm/types';
import { getAdapter } from '../../llm/provider';
import { callStructuredLlm } from '../../llm/structured';
import { getLlmSettings } from '../settings-service';
import { stripThink } from '../../lib/think-filter';
import { newId } from '../../lib/ids';
import { notFound, badRequest } from '../../lib/errors';
import { getBenchCase, type BenchCaseDef, type DialogueSpec } from './cases';
import { benchBaselinesStore } from './store';

const RUN_BASE_TS = 1_700_000_000_000;

/** A dialogue FAILS if any character reply is more than this similar (char-3gram
 *  Jaccard) to the model's PREVIOUS reply — i.e. it's looping / losing the plot.
 *  Normal distinct in-voice replies run well under this (~5–12%). */
export const REPETITION_FAIL_THRESHOLD = 0.25;

// --- metric helpers ---------------------------------------------------------

function estTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

function sumChars(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => {
    if (typeof m.content === 'string') return n + m.content.length;
    return n + m.content.reduce((a, p) => a + (p.type === 'text' ? p.text.length : 0), 0);
  }, 0);
}

/** Build one call metric, preferring the endpoint's reported usage and falling
 *  back to a chars/4 estimate (flagged) when it reports none. */
function buildMetric(
  label: string,
  latencyMs: number,
  usage: TokenUsage | undefined,
  promptChars: number,
  completionChars: number,
  ok: boolean,
): BenchCallMetric {
  const pt = usage?.promptTokens ?? null;
  const ct = usage?.completionTokens ?? null;
  const estimated = pt == null || ct == null;
  const promptTokens = pt ?? estTokens(promptChars);
  const completionTokens = ct ?? estTokens(completionChars);
  const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens;
  const tokensPerSec = latencyMs > 0 && completionTokens > 0 ? completionTokens / (latencyMs / 1000) : null;
  return { label, promptTokens, completionTokens, totalTokens, promptChars, completionChars, tokensEstimated: estimated, latencyMs, attempts: 1, ok, tokensPerSec };
}

/** Roll several calls (e.g. a dialogue turn's structured retries) into one metric. */
function combineCalls(label: string, calls: BenchCallMetric[]): BenchCallMetric {
  let pt = 0, ct = 0, lat = 0, est = false, ok = true;
  for (const c of calls) {
    pt += c.promptTokens ?? 0;
    ct += c.completionTokens ?? 0;
    lat += c.latencyMs;
    if (c.tokensEstimated) est = true;
    if (!c.ok) ok = false;
  }
  const tps = lat > 0 && ct > 0 ? ct / (lat / 1000) : null;
  return { label, promptTokens: pt, completionTokens: ct, totalTokens: pt + ct, promptChars: 0, completionChars: 0, tokensEstimated: est, latencyMs: lat, attempts: calls.length || 1, ok, tokensPerSec: tps };
}

/** Case-level rollup across every call the case made. */
function rollup(calls: BenchCallMetric[]): {
  promptTokens: number;
  completionTokens: number;
  totalLatency: number;
  attempts: number;
  tps: number | null;
  estimated: boolean;
} {
  let promptTokens = 0, completionTokens = 0, totalLatency = 0, estimated = false;
  for (const c of calls) {
    promptTokens += c.promptTokens ?? 0;
    completionTokens += c.completionTokens ?? 0;
    totalLatency += c.latencyMs;
    if (c.tokensEstimated) estimated = true;
  }
  const tps = totalLatency > 0 && completionTokens > 0 ? completionTokens / (totalLatency / 1000) : null;
  return { promptTokens, completionTokens, totalLatency, attempts: calls.length, tps, estimated };
}

// --- dialogue helpers -------------------------------------------------------

/** Character 3-gram Jaccard similarity (0..1) — high means the texts overlap heavily. */
function similarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = s.toLowerCase().replace(/\s+/g, ' ').trim();
    const set = new Set<string>();
    for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
    return set;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** Tidy a generated dialogue line: trim, drop a leading speaker prefix + wrapping quotes. */
function cleanLine(text: string): string {
  let t = (text ?? '').trim();
  t = t.replace(/^(Mara|Robin)\s*:\s*/i, '');
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** The "player persona" prompt for llmPlayer mode (the model plays Robin too). */
function buildPlayerTurnMessages(d: DialogueSpec, history: Message[]): ChatMessage[] {
  const convo = history.map((m) => `${m.role === 'player' ? 'Robin' : d.characterName}: ${m.text}`).join('\n');
  return [
    {
      role: 'system',
      content:
        `You are Robin (they/them), the person on the player's side of this conversation. ${d.sceneNote} ` +
        `Reply the way Robin naturally would — warm, curious, human — in ONE short message. ` +
        `Do not narrate, label the speaker, or use quotation marks; just write what Robin says.`,
    },
    {
      role: 'user',
      content: `Conversation so far:\n${convo || '(it has not started yet — open the conversation naturally)'}\n\nWrite Robin's next message.`,
    },
  ];
}

let runSeq = 0;
function makeMessage(role: Message['role'], text: string): Message {
  runSeq += 1;
  return MessageSchema.parse({ id: `bench-run-${runSeq}`, sessionId: 'bench-run', role, text, metadata: {}, createdAt: RUN_BASE_TS + runSeq });
}

// --- runners ----------------------------------------------------------------

async function runStructured(def: BenchCaseDef, settings: LlmSettings, signal?: AbortSignal): Promise<BenchCaseResult> {
  const spec = def.structured!();
  const calls: BenchCallMetric[] = [];
  const res = await callStructuredLlm(spec.schema, spec.messages, {
    settings,
    task: spec.task,
    schemaName: spec.schemaName,
    maxTokens: spec.maxTokens,
    signal,
    onAttempt: (info) => calls.push(buildMetric(`call ${info.call}`, info.latencyMs, info.usage, info.promptChars, info.completionChars, info.ok)),
  });
  const r = rollup(calls);

  let comparison: BenchComparison | null = null;
  let judgeFailReason = '';
  if (res.ok && def.score && def.baselineSpec) {
    // The user's saved baseline wins; otherwise fall back to the case's built-in
    // default so a run is scored out-of-the-box. Only when neither exists do we
    // show the model's verdict alone (uncompared).
    const baselineValue = benchBaselinesStore.get(def.id)?.value ?? def.defaultBaseline ?? null;
    if (baselineValue) {
      const scored = def.score(baselineValue, res.data);
      comparison = { human: baselineValue, llm: scored.llmValue, closeness: scored.closeness, agree: scored.agree, pass: scored.pass, rows: scored.rows };
      // A judge that lands outside the baseline's tolerance FAILS the case (the model
      // meaningfully misjudged) — even though it produced valid structured output.
      if (!scored.pass) judgeFailReason = scored.failReason || 'The model disagreed with the baseline.';
    } else {
      const scored = def.score({}, res.data);
      comparison = { human: null, llm: scored.llmValue, closeness: null, agree: null, pass: null, rows: scored.rows.map((row) => ({ ...row, human: '—', delta: '' })) };
    }
  }
  const ok = res.ok && comparison?.pass !== false;

  return BenchCaseResultSchema.parse({
    caseId: def.id,
    label: def.label,
    group: def.group,
    kind: def.kind,
    ok,
    error: res.ok ? judgeFailReason : res.error,
    calls,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalLatencyMs: r.totalLatency,
    attempts: r.attempts,
    tokensPerSec: r.tps,
    tokensEstimated: r.estimated,
    output: res.ok ? JSON.stringify(res.data, null, 2) : res.lastRaw ?? '',
    transcript: [],
    repetitionMax: null,
    repetitionAvg: null,
    comparison,
  });
}

async function runDialogue(
  def: BenchCaseDef,
  settings: LlmSettings,
  dialogueTurns: number,
  llmPlayer: boolean,
  signal?: AbortSignal,
): Promise<BenchCaseResult> {
  const d = def.dialogue!;
  const adapter = getAdapter(settings);
  const calls: BenchCallMetric[] = [];
  const transcript: BenchCaseResult['transcript'] = [];
  const history: Message[] = [];
  /** Only GENUINELY-generated character replies (failed/sentinel turns excluded),
   *  so the self-repetition metric never mistakes two identical error sentinels
   *  for the model looping. */
  let lastRealReply: string | null = null;
  const reps: number[] = [];
  let failed = false;
  let firstError = '';

  for (let i = 0; i < dialogueTurns; i++) {
    if (signal?.aborted) break; // honor cancellation between turns
    // --- player turn ---
    let playerLine: string;
    if (llmPlayer) {
      const pmsgs = buildPlayerTurnMessages(d, history);
      const started = Date.now();
      try {
        const pr = await adapter.chat({ messages: pmsgs, temperature: Math.min(1, settings.temperature), maxTokens: 220 }, signal);
        playerLine = cleanLine(stripThink(pr.content)) || (d.playerScript[i % d.playerScript.length] ?? '…');
        calls.push(buildMetric(`player ${i + 1}`, Date.now() - started, pr.usage, sumChars(pmsgs), pr.content.length, true));
      } catch (err) {
        playerLine = d.playerScript[i % d.playerScript.length] ?? '…';
        calls.push(buildMetric(`player ${i + 1}`, Date.now() - started, undefined, sumChars(pmsgs), 0, false));
        if (!failed) { failed = true; firstError = (err as Error).message; }
      }
    } else {
      if (i >= d.playerScript.length) break; // scripted: stop when the script is exhausted
      playerLine = d.playerScript[i]!;
    }
    history.push(makeMessage('player', playerLine));
    transcript.push({ role: 'player', text: playerLine, latencyMs: null, promptTokens: null, completionTokens: null, repetitionVsPrev: null });

    // --- character reply ---
    const cmsgs = d.buildMessages(history);
    let replyText: string;
    let replyOk: boolean;
    let turnMetric: BenchCallMetric;
    if (d.replySchema && d.extractReply) {
      const sub: BenchCallMetric[] = [];
      const res = await callStructuredLlm(d.replySchema, cmsgs, {
        settings,
        task: 'Write the character’s reply.',
        schemaName: 'BenchDialogueReply',
        maxTokens: d.maxTokens,
        signal,
        onAttempt: (info) => sub.push(buildMetric(`reply ${i + 1}.${info.call}`, info.latencyMs, info.usage, info.promptChars, info.completionChars, info.ok)),
      });
      replyOk = res.ok;
      replyText = res.ok ? cleanLine(d.extractReply(res.data)) : '(structured reply failed)';
      if (!res.ok && !failed) { failed = true; firstError = res.error; }
      calls.push(...sub);
      turnMetric = combineCalls(`reply ${i + 1}`, sub);
    } else {
      const started = Date.now();
      try {
        const cr = await adapter.chat({ messages: cmsgs, temperature: settings.temperature, maxTokens: d.maxTokens ?? settings.maxTokens }, signal);
        const cleaned = cleanLine(stripThink(cr.content));
        replyOk = cleaned.length > 0;
        replyText = cleaned || '(empty reply)';
        turnMetric = buildMetric(`reply ${i + 1}`, Date.now() - started, cr.usage, sumChars(cmsgs), cr.content.length, replyOk);
        calls.push(turnMetric);
      } catch (err) {
        replyOk = false;
        replyText = '(no reply — endpoint error)';
        turnMetric = buildMetric(`reply ${i + 1}`, Date.now() - started, undefined, sumChars(cmsgs), 0, false);
        calls.push(turnMetric);
        if (!failed) { failed = true; firstError = (err as Error).message; }
      }
    }
    history.push(makeMessage('character', replyText));
    // Repetition only compares REAL replies to the previous REAL reply, so a run of
    // error sentinels can't masquerade as the model looping.
    let rep: number | null = null;
    if (replyOk) {
      rep = lastRealReply != null ? similarity(replyText, lastRealReply) : null;
      if (rep != null) reps.push(rep);
      lastRealReply = replyText;
    }
    transcript.push({
      role: 'character',
      text: replyText,
      latencyMs: turnMetric.latencyMs,
      promptTokens: turnMetric.promptTokens,
      completionTokens: turnMetric.completionTokens,
      repetitionVsPrev: rep,
    });
    if (signal?.aborted) break; // a cancelled structured/chat call returns fast — stop now
  }

  const r = rollup(calls);
  const repetitionMax = reps.length ? Math.max(...reps) : null;
  const repetitionAvg = reps.length ? reps.reduce((a, b) => a + b, 0) / reps.length : null;
  // A dialogue that repeats itself is a FAILURE even when every call technically
  // succeeded — the whole point of these cases is to catch a model that loops.
  if (!failed && repetitionMax != null && repetitionMax > REPETITION_FAIL_THRESHOLD) {
    failed = true;
    firstError =
      `Repetitive: a reply was ${Math.round(repetitionMax * 100)}% similar to the model's previous line ` +
      `(limit ${Math.round(REPETITION_FAIL_THRESHOLD * 100)}%) — it's looping or losing the plot.`;
  }
  return BenchCaseResultSchema.parse({
    caseId: def.id,
    label: def.label,
    group: def.group,
    kind: def.kind,
    ok: !failed,
    error: firstError,
    calls,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalLatencyMs: r.totalLatency,
    attempts: r.attempts,
    tokensPerSec: r.tps,
    tokensEstimated: r.estimated,
    output: '',
    transcript,
    repetitionMax,
    repetitionAvg,
    comparison: null,
  });
}

function failedResult(def: BenchCaseDef, message: string): BenchCaseResult {
  return BenchCaseResultSchema.parse({
    caseId: def.id,
    label: def.label,
    group: def.group,
    kind: def.kind,
    ok: false,
    error: message,
  });
}

/** Run a single bench case end-to-end. Never throws — a bad case yields a failed result. */
export async function runBenchCase(req: BenchRunCaseRequest, signal?: AbortSignal): Promise<BenchCaseResult> {
  const def = getBenchCase(req.caseId);
  if (!def) throw notFound(`Unknown bench case: ${req.caseId}`);
  const settings = getLlmSettings();
  try {
    if (def.dialogue) return await runDialogue(def, settings, req.dialogueTurns, req.llmPlayer, signal);
    if (def.structured) return await runStructured(def, settings, signal);
    throw badRequest(`Bench case ${req.caseId} has no runnable spec.`);
  } catch (err) {
    return failedResult(def, (err as Error).message || 'Case failed.');
  }
}

// --- aggregation + persistence shape ---------------------------------------

export function computeAggregate(results: BenchCaseResult[]): BenchAggregate {
  let passed = 0, failed = 0, totalPrompt = 0, totalCompletion = 0, totalLatency = 0, estimated = false;
  let judgeCases = 0, closenessSum = 0;
  for (const res of results) {
    if (res.ok) passed += 1; else failed += 1;
    totalPrompt += res.promptTokens ?? 0;
    totalCompletion += res.completionTokens ?? 0;
    totalLatency += res.totalLatencyMs;
    if (res.tokensEstimated) estimated = true;
    if (res.comparison && res.comparison.closeness != null) {
      judgeCases += 1;
      closenessSum += res.comparison.closeness;
    }
  }
  const avgTps = totalLatency > 0 && totalCompletion > 0 ? totalCompletion / (totalLatency / 1000) : null;
  return {
    cases: results.length,
    passed,
    failed,
    totalPromptTokens: totalPrompt,
    totalCompletionTokens: totalCompletion,
    totalLatencyMs: totalLatency,
    avgTokensPerSec: avgTps,
    judgeCases,
    avgCloseness: judgeCases ? closenessSum / judgeCases : null,
    tokensEstimated: estimated,
  };
}

/**
 * Assemble a savable run summary from already-executed case results. Prefers the
 * client's run-time settings snapshot (captured when the run started) so editing
 * the model between running and saving can't mislabel the run; falls back to the
 * current settings when none was supplied.
 */
export function buildRunSummary(
  label: string,
  request: BenchRunRequest,
  results: BenchCaseResult[],
  snapshot?: BenchSettingsSnapshot | null,
): BenchRunSummary {
  const settings = getLlmSettings();
  const snap: BenchSettingsSnapshot = snapshot ?? {
    model: settings.model,
    baseUrl: settings.baseUrl,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    structuredMode: settings.structuredMode,
    nsfwEnabled: settings.nsfwEnabled,
  };
  return BenchRunSummarySchema.parse({
    id: newId('bench'),
    createdAt: Date.now(),
    label,
    model: snap.model,
    settings: snap,
    request,
    results,
    aggregate: computeAggregate(results),
  });
}
