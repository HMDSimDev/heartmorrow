import { z } from 'zod';
import { PromptOverrideMapSchema } from './prompts';
import { StructuredOutputModeSchema } from './settings';

/**
 * Heartmorrow Bench — the model-evaluation harness.
 *
 * The bench runs the REAL prompts the game sends (judges, date dialogue, creator
 * generation) against a FIXED, self-contained sample dataset, so a player can see
 * how their configured local model performs at the tasks this game actually asks
 * of it — and compare runs across models/settings. Where there's a "right answer"
 * (the scoring judges) the human sets their own baseline first and the bench
 * reports how close the model got. These types are shared by the server (which
 * owns the fixtures, executes cases, and scores against baselines) and the web
 * Bench page (which renders the catalog, collects baselines, and draws the run).
 */

/** What kind of work a bench case exercises. */
export const BenchCaseKindSchema = z.enum([
  'judge', // a structured scoring/decision the human can baseline (turn judge, evaluator, walkout…)
  'dialogue', // a multi-turn generated conversation (date/chat/text) — watch for repetition / losing the plot
  'generation', // a one-shot structured generation (world, shop items, day recap…) — validity + cost
]);
export type BenchCaseKind = z.infer<typeof BenchCaseKindSchema>;

/**
 * Cross-cutting tags that group cases into run presets BEYOND `kind` (which only
 * separates judge/dialogue/generation). A single `generation` case can be a
 * structured content generator or a pure-prose writer; tags let the UI offer
 * "run all the generators" / "run all the prose" quick-selects. A case may carry
 * zero tags (e.g. the extraction cases fit neither bucket).
 */
export const BenchCaseTagSchema = z.enum([
  'generator', // structured world/content generators (world, locations, items, companies, characters, quizzes…)
  'prose', // free-form narrative/flavor prose (recaps, color passes, dispatches, chronicles, feed posts…)
]);
export type BenchCaseTag = z.infer<typeof BenchCaseTagSchema>;

/**
 * Describes the human-baseline control a judge case exposes in the UI. The bench
 * shows the case's sample context, the human enters their own judgment via this
 * control, and the per-case scorer compares it to the model's output.
 */
export const BenchBaselineSpecSchema = z.discriminatedUnion('kind', [
  /** A single engagement read on a -3..+3 scale (turn/text judges); `hostile` adds a flag toggle. */
  z.object({ kind: z.literal('engagement'), hostile: z.boolean().default(false) }),
  /** A set of relationship-stat deltas, each in [-max, +max] (the session evaluator / gift reaction). */
  z.object({
    kind: z.literal('deltas'),
    stats: z.array(z.string()).min(1),
    max: z.number().int().positive(),
  }),
  /** One choice from a fixed list (DTR accept/deflect/backfire, breakup reaction…). */
  z.object({
    kind: z.literal('choice'),
    options: z.array(z.object({ value: z.string(), label: z.string() })).min(2),
  }),
  /** A yes/no decision (does the character walk out? is this genuinely a breakup?). */
  z.object({ kind: z.literal('boolean'), label: z.string() }),
]);
export type BenchBaselineSpec = z.infer<typeof BenchBaselineSpecSchema>;

/** A human baseline (or a model's extracted judgment) as a flat record of scalars. */
export const BenchBaselineValueSchema = z.record(z.string(), z.union([z.number(), z.string(), z.boolean()]));
export type BenchBaselineValue = z.infer<typeof BenchBaselineValueSchema>;

/** A saved human baseline for one case, persisted independently of any run. */
export const BenchBaselineSchema = z.object({
  caseId: z.string().min(1),
  value: BenchBaselineValueSchema,
  note: z.string().max(400).default(''),
  updatedAt: z.number(),
});
export type BenchBaseline = z.infer<typeof BenchBaselineSchema>;

/** One line of a sample transcript shown to the human (for context / ranking). */
export const BenchTranscriptLineSchema = z.object({
  speaker: z.enum(['player', 'character', 'narrator', 'system']),
  name: z.string().default(''),
  text: z.string(),
});
export type BenchTranscriptLine = z.infer<typeof BenchTranscriptLineSchema>;

/** The readable setup the human sees for a case: who, the state, and any transcript. */
export const BenchCaseSetupSchema = z.object({
  characterName: z.string().default(''),
  characterBrief: z.string().default(''),
  relationshipLine: z.string().default(''),
  /** A scene/need note (e.g. the hidden "what they wanted tonight", or the gift given). */
  note: z.string().default(''),
  /** Sample transcript leading up to the judged moment (judges) or the empty stage (dialogue). */
  transcript: z.array(BenchTranscriptLineSchema).default([]),
  /** For dialogue cases: the fixed player lines that will drive the date when scripted. */
  playerScript: z.array(z.string()).default([]),
});
export type BenchCaseSetup = z.infer<typeof BenchCaseSetupSchema>;
/** Input shape (defaults optional) — used when authoring cases server-side. */
export type BenchCaseSetupInput = z.input<typeof BenchCaseSetupSchema>;

/** Catalog entry for one case — everything the UI needs before a run. */
export const BenchCaseMetaSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  description: z.string(),
  kind: BenchCaseKindSchema,
  /** UI grouping label (e.g. "Judges & scoring"). */
  group: z.string(),
  /** Cross-cutting tags for run presets ("Generators" / "Prose"); may be empty. */
  tags: z.array(BenchCaseTagSchema).default([]),
  /** The human-baseline control for judge cases; null when the case has no baseline. */
  baselineSpec: BenchBaselineSpecSchema.nullable().default(null),
  /** A short instruction shown above the baseline control ("Score the date as you'd judge it"). */
  baselinePrompt: z.string().default(''),
  /** A built-in default baseline for judge cases, so a run is scored out-of-the-box
   *  without the user entering anything. The user's saved baseline (if any) overrides it. */
  defaultBaseline: BenchBaselineValueSchema.nullable().default(null),
  setup: BenchCaseSetupSchema.default({}),
  /** True for structured (JSON-schema) tasks; false for free-text dialogue. */
  structured: z.boolean().default(true),
  /** Rough prompt size (chars) so the UI can show heft before running. */
  promptChars: z.number().int().default(0),
});
export type BenchCaseMeta = z.infer<typeof BenchCaseMetaSchema>;

/** The full catalog: every runnable case + the model it'll run against. */
export const BenchCatalogSchema = z.object({
  model: z.string(),
  /** Ordered group labels for sectioning the UI. */
  groups: z.array(z.string()),
  cases: z.array(BenchCaseMetaSchema),
});
export type BenchCatalog = z.infer<typeof BenchCatalogSchema>;

/** Options for executing cases. */
export const BenchRunRequestSchema = z.object({
  caseIds: z.array(z.string()).min(1),
  /** When true, a second "player persona" model drives the player side of dialogue
   *  cases (dynamic). When false, the fixed scripted player lines are used (reproducible). */
  llmPlayer: z.boolean().default(false),
  /** How many character turns to generate for dialogue cases. */
  dialogueTurns: z.number().int().min(1).max(20).default(8),
  /** Optional human-readable label for the saved run. */
  label: z.string().max(80).default(''),
});
export type BenchRunRequest = z.infer<typeof BenchRunRequestSchema>;

/** Per-case execution options (one case at a time; the client drives the loop). */
export const BenchRunCaseRequestSchema = z.object({
  caseId: z.string().min(1),
  llmPlayer: z.boolean().default(false),
  dialogueTurns: z.number().int().min(1).max(20).default(8),
  /** A client-generated id shared by every case in one run, so a single
   *  `POST /bench/cancel { runId }` can abort the in-flight case server-side
   *  (independent of connection-close detection through the dev proxy). */
  runId: z.string().default(''),
  /** Ephemeral Prompt-Editor overrides to PREVIEW for this run only (keyed by
   *  prompt id). Applied to the registry just for this case and restored after, so
   *  the player can test edits before saving them as installation defaults. Never
   *  persisted. Absent/empty → the run uses the saved overrides + shipped defaults. */
  promptOverrides: PromptOverrideMapSchema.default({}),
});
export type BenchRunCaseRequest = z.infer<typeof BenchRunCaseRequestSchema>;

/** Body for the cancel endpoint. */
export const BenchCancelRequestSchema = z.object({ runId: z.string().min(1) });
export type BenchCancelRequest = z.infer<typeof BenchCancelRequestSchema>;

/** Metrics for a single model call. */
export const BenchCallMetricSchema = z.object({
  label: z.string().default(''),
  promptTokens: z.number().nullable().default(null),
  completionTokens: z.number().nullable().default(null),
  totalTokens: z.number().nullable().default(null),
  promptChars: z.number().int().default(0),
  completionChars: z.number().int().default(0),
  /** True when token counts are a chars/4 estimate (endpoint reported no usage). */
  tokensEstimated: z.boolean().default(false),
  latencyMs: z.number(),
  attempts: z.number().int().default(1),
  ok: z.boolean(),
  tokensPerSec: z.number().nullable().default(null),
  /** The time (ms) `tokensPerSec` is computed over: the endpoint's reported
   *  GENERATION time when it provides per-response stats (decode only — excludes
   *  prompt prefill + transport), otherwise the full round-trip `latencyMs` as a
   *  fallback. 0 for calls that produced no tokens. Rollups sum this so a combined
   *  rate stays correct. */
  genTimeMs: z.number().default(0),
  /** True when `genTimeMs`/`tokensPerSec` came from endpoint-reported generation
   *  stats (a real decode rate) rather than the end-to-end latency fallback. */
  speedMeasured: z.boolean().default(false),
});
export type BenchCallMetric = z.infer<typeof BenchCallMetricSchema>;

/** One turn of a generated dialogue (for the transcript view + repetition read). */
export const BenchTranscriptTurnSchema = z.object({
  role: z.enum(['player', 'character']),
  text: z.string(),
  latencyMs: z.number().nullable().default(null),
  promptTokens: z.number().nullable().default(null),
  completionTokens: z.number().nullable().default(null),
  /** Similarity (0..1) to this speaker's PREVIOUS turn — high = repeating itself. */
  repetitionVsPrev: z.number().nullable().default(null),
});
export type BenchTranscriptTurn = z.infer<typeof BenchTranscriptTurnSchema>;

/** Side-by-side detail row for a judge comparison. */
export const BenchComparisonRowSchema = z.object({
  label: z.string(),
  human: z.string(),
  llm: z.string(),
  delta: z.string().default(''),
});
export type BenchComparisonRow = z.infer<typeof BenchComparisonRowSchema>;

/** How the model's judgment compared to the human baseline. */
export const BenchComparisonSchema = z.object({
  human: BenchBaselineValueSchema.nullable().default(null),
  llm: BenchBaselineValueSchema.nullable().default(null),
  /** 0..1 (1 = perfect agreement); null when no baseline was set. */
  closeness: z.number().nullable().default(null),
  /** Exact-match agreement for categorical/boolean cases; null for continuous ones. */
  agree: z.boolean().nullable().default(null),
  /** Did the model land within the baseline's tolerance? false → the case fails.
   *  null when there was no baseline to judge against. */
  pass: z.boolean().nullable().default(null),
  rows: z.array(BenchComparisonRowSchema).default([]),
});
export type BenchComparison = z.infer<typeof BenchComparisonSchema>;

/**
 * Which structured-output mode a case's calls actually used. `requested` is the
 * configured starting mode; `final` is the mode that produced output after any
 * response-format downgrades (json_schema → json_object → prompt_only). When
 * `final !== requested` the endpoint couldn't serve the requested mode and the case
 * FELL BACK — this is surfaced as a capability signal, never counted as a failure.
 * Null on cases that make no structured calls (the free-text dialogue cases).
 */
export const BenchStructuredModeSchema = z.object({
  requested: StructuredOutputModeSchema,
  final: StructuredOutputModeSchema,
});
export type BenchStructuredMode = z.infer<typeof BenchStructuredModeSchema>;

/** The full result of running one case. */
export const BenchCaseResultSchema = z.object({
  caseId: z.string(),
  label: z.string(),
  group: z.string(),
  kind: BenchCaseKindSchema,
  ok: z.boolean(),
  error: z.string().default(''),
  calls: z.array(BenchCallMetricSchema).default([]),
  /** Case-level rollups across all its calls. */
  promptTokens: z.number().nullable().default(null),
  completionTokens: z.number().nullable().default(null),
  totalLatencyMs: z.number().default(0),
  attempts: z.number().int().default(0),
  tokensPerSec: z.number().nullable().default(null),
  tokensEstimated: z.boolean().default(false),
  /** Total decode time (ms) `tokensPerSec` is computed over — Σ of the case's
   *  token-bearing calls' `genTimeMs` (endpoint-measured generation time when
   *  available, else round-trip latency). Lets the run aggregate compose a correct
   *  token-weighted rate across cases. */
  genTimeMs: z.number().default(0),
  /** True when this case's `tokensPerSec` is an endpoint-measured decode rate
   *  (every token-bearing call reported generation stats); false when it fell back
   *  to end-to-end latency (which includes prompt processing + transport, so it
   *  under-reports true generation speed). */
  speedMeasured: z.boolean().default(false),
  /** Pretty-printed structured output (judge/generation). */
  output: z.string().default(''),
  /** Generated dialogue (dialogue cases). */
  transcript: z.array(BenchTranscriptTurnSchema).default([]),
  repetitionMax: z.number().nullable().default(null),
  repetitionAvg: z.number().nullable().default(null),
  /** Human-vs-model scoring (judge cases with a baseline set). */
  comparison: BenchComparisonSchema.nullable().default(null),
  /** The structured-output mode this case ran at, and whether it had to fall back
   *  from the requested mode. Null for free-text dialogue cases (no structured call). */
  structuredMode: BenchStructuredModeSchema.nullable().default(null),
});
export type BenchCaseResult = z.infer<typeof BenchCaseResultSchema>;

/** Aggregate rollup for a whole run. */
export const BenchAggregateSchema = z.object({
  cases: z.number().int().default(0),
  passed: z.number().int().default(0),
  failed: z.number().int().default(0),
  totalPromptTokens: z.number().default(0),
  totalCompletionTokens: z.number().default(0),
  totalLatencyMs: z.number().default(0),
  avgTokensPerSec: z.number().nullable().default(null),
  /** Number of judge cases that had a baseline + were scored. */
  judgeCases: z.number().int().default(0),
  /** Mean closeness (0..1) across scored judge cases. */
  avgCloseness: z.number().nullable().default(null),
  /** True when any case fell back to chars/4 token estimates. */
  tokensEstimated: z.boolean().default(false),
  /** True when any token-bearing case's tok/sec is an end-to-end-latency estimate
   *  rather than an endpoint-measured decode rate — so the UI can flag the speed
   *  numbers. Endpoints like LM Studio's native API report real per-response stats;
   *  configuring the best available API in Settings makes these numbers accurate. */
  speedEstimated: z.boolean().default(false),
  /** How many cases had to fall back from their requested structured-output mode
   *  (json_schema → json_object/prompt_only). A fallback is NOT a failure — it means
   *  the endpoint couldn't serve the requested mode, so the case still ran but at a
   *  looser structured contract. */
  structuredFallbacks: z.number().int().default(0),
  /** Of the fell-back cases, how many ended on each mode (e.g. { json_object: 2,
   *  prompt_only: 1 }) — keyed by `BenchStructuredMode.final`. */
  fallbackByMode: z.record(z.string(), z.number().int()).default({}),
});
export type BenchAggregate = z.infer<typeof BenchAggregateSchema>;

/** Redacted snapshot of the settings a run executed under (no API key). */
export const BenchSettingsSnapshotSchema = z.object({
  model: z.string().default(''),
  baseUrl: z.string().default(''),
  temperature: z.number().default(0),
  maxTokens: z.number().default(0),
  structuredMode: z.string().default(''),
  nsfwEnabled: z.boolean().default(false),
});
export type BenchSettingsSnapshot = z.infer<typeof BenchSettingsSnapshotSchema>;

/** A complete, saved bench run. */
export const BenchRunSummarySchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  label: z.string().default(''),
  model: z.string(),
  settings: BenchSettingsSnapshotSchema,
  request: BenchRunRequestSchema,
  results: z.array(BenchCaseResultSchema),
  aggregate: BenchAggregateSchema,
});
export type BenchRunSummary = z.infer<typeof BenchRunSummarySchema>;

/** A failed case summarized for the saved-runs list (so failures show without opening the run). */
export const BenchRunFailureSchema = z.object({
  caseId: z.string(),
  label: z.string(),
  group: z.string().default(''),
  kind: BenchCaseKindSchema.default('generation'),
  error: z.string().default(''),
});
export type BenchRunFailure = z.infer<typeof BenchRunFailureSchema>;

/** Lightweight row for the saved-runs list. */
export const BenchRunListItemSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  label: z.string().default(''),
  model: z.string(),
  aggregate: BenchAggregateSchema,
  /** The cases that failed in this run (label + error), for an at-a-glance History view. */
  failures: z.array(BenchRunFailureSchema).default([]),
});
export type BenchRunListItem = z.infer<typeof BenchRunListItemSchema>;

/** Body the client posts to persist an assembled run (server computes the aggregate). */
export const BenchSaveRunRequestSchema = z.object({
  label: z.string().max(80).default(''),
  request: BenchRunRequestSchema,
  results: z.array(BenchCaseResultSchema).min(1),
  /** The settings snapshot captured when the run STARTED (so editing the model
   *  between running and saving can't mislabel the run). Null → server reads current. */
  settings: BenchSettingsSnapshotSchema.nullable().default(null),
});
export type BenchSaveRunRequest = z.infer<typeof BenchSaveRunRequestSchema>;
