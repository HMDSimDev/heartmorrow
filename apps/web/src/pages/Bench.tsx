import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  BenchCatalog,
  BenchCaseMeta,
  BenchBaseline,
  BenchBaselineValue,
  BenchBaselineSpec,
  BenchCaseResult,
  BenchRunListItem,
  BenchRunSummary,
  BenchSettingsSnapshot,
} from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { Banner, Spinner, ConfirmDialog } from '../components/ui';
import { Icon } from '../components/Icon';
import './bench.page.css';

type CaseStatus = 'idle' | 'queued' | 'running' | 'done' | 'error';

// --- small format helpers ---------------------------------------------------

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`);
const num = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString());
const fmtMs = (n: number | null | undefined) => {
  if (n == null) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
};
const fmtTps = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(1)} tok/s`);

/** Closeness → a Nocturne light (sage good, brass mid, ember poor). */
function closenessColor(v: number): string {
  if (v >= 0.75) return 'var(--sage)';
  if (v >= 0.45) return 'var(--brass)';
  return 'var(--ember)';
}
/** Repetition → green when low (good), ember once it crosses the 25% failure
 *  threshold (a dialogue case fails when any reply is >25% similar to the last). */
const REPETITION_FAIL_THRESHOLD = 0.25;
function repetitionColor(v: number): string {
  if (v > REPETITION_FAIL_THRESHOLD) return 'var(--ember)';
  if (v >= 0.15) return 'var(--brass)';
  return 'var(--sage)';
}

// --- baseline value defaults / helpers --------------------------------------

function defaultBaseline(spec: BenchBaselineSpec): BenchBaselineValue {
  switch (spec.kind) {
    case 'engagement':
      return spec.hostile ? { engagement: 0, hostile: false } : { engagement: 0 };
    case 'deltas':
      return Object.fromEntries(spec.stats.map((s) => [s, 0]));
    case 'choice':
      return { choice: spec.options[0]?.value ?? '' };
    case 'boolean':
      return { value: false };
  }
}

// --- generic charts (hand-rolled, Nocturne-styled) --------------------------

interface BarItem {
  key: string;
  label: string;
  value: number;
  display: string;
  color?: string;
}
function Bars({ items, max }: { items: BarItem[]; max?: number }) {
  const m = max ?? Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="muted bench-empty">No data.</p>;
  return (
    <div className="bench-bars">
      {items.map((it) => (
        <div className="bench-bar-row" key={it.key}>
          <div className="bench-bar-label" title={it.label}>{it.label}</div>
          <div className="bench-bar-track">
            <div className="bench-bar-fill" style={{ width: `${clamp01(it.value / m) * 100}%`, background: it.color ?? 'var(--moon)' }} />
          </div>
          <div className="bench-bar-val">{it.display}</div>
        </div>
      ))}
    </div>
  );
}

interface StackRow {
  key: string;
  label: string;
  prompt: number;
  completion: number;
}
function StackedTokens({ rows }: { rows: StackRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.prompt + r.completion));
  if (!rows.length) return <p className="muted bench-empty">No data.</p>;
  return (
    <div className="bench-bars">
      {rows.map((r) => (
        <div className="bench-bar-row" key={r.key}>
          <div className="bench-bar-label" title={r.label}>{r.label}</div>
          <div className="bench-bar-track">
            <div className="bench-bar-fill" style={{ width: `${(r.prompt / max) * 100}%`, background: 'var(--moon)' }} title={`${num(r.prompt)} in`} />
            <div className="bench-bar-fill" style={{ width: `${(r.completion / max) * 100}%`, background: 'var(--rose)' }} title={`${num(r.completion)} out`} />
          </div>
          <div className="bench-bar-val">{num(r.prompt + r.completion)}</div>
        </div>
      ))}
    </div>
  );
}

function RingGauge({ value, label, sub }: { value: number; label: string; sub?: string }) {
  const r = 40;
  const c = 2 * Math.PI * r;
  const off = c * (1 - clamp01(value));
  return (
    <div className="bench-ring-wrap">
      <svg viewBox="0 0 100 100" className="bench-ring" role="img" aria-label={`${label}: ${pct(value)}`}>
        <circle cx="50" cy="50" r={r} className="bench-ring-bg" />
        <circle
          cx="50"
          cy="50"
          r={r}
          className="bench-ring-fg"
          style={{ stroke: closenessColor(value) }}
          strokeDasharray={c}
          strokeDashoffset={off}
          transform="rotate(-90 50 50)"
        />
        <text x="50" y="54" className="bench-ring-num">{pct(value)}</text>
      </svg>
      <div className="bench-ring-cap">
        <div className="bench-ring-lbl">{label}</div>
        {sub && <div className="muted bench-ring-sub">{sub}</div>}
      </div>
    </div>
  );
}

// --- baseline editor --------------------------------------------------------

function BaselineEditor({
  spec,
  value,
  onChange,
}: {
  spec: BenchBaselineSpec;
  value: BenchBaselineValue;
  onChange: (v: BenchBaselineValue) => void;
}) {
  if (spec.kind === 'engagement') {
    const eng = Number(value.engagement ?? 0);
    return (
      <div className="bench-bl">
        <label className="bench-bl-eng">
          <span className="bench-bl-engval" data-sign={Math.sign(eng)}>
            {eng > 0 ? `+${eng}` : eng}
          </span>
          <input type="range" min={-3} max={3} step={1} value={eng} onChange={(e) => onChange({ ...value, engagement: Number(e.target.value) })} />
          <span className="bench-bl-scale"><span>bombed</span><span>connected</span></span>
        </label>
        {spec.hostile && (
          <label className="bench-bl-check">
            <input type="checkbox" checked={Boolean(value.hostile)} onChange={(e) => onChange({ ...value, hostile: e.target.checked })} />
            <span>Hostile / cruel</span>
          </label>
        )}
      </div>
    );
  }
  if (spec.kind === 'deltas') {
    return (
      <div className="bench-bl bench-bl-deltas">
        {spec.stats.map((s) => {
          const v = Number(value[s] ?? 0);
          return (
            <label key={s} className="bench-bl-delta">
              <span className="bench-bl-deltaname">{s}</span>
              <input
                type="range"
                min={-spec.max}
                max={spec.max}
                step={1}
                value={v}
                onChange={(e) => onChange({ ...value, [s]: Number(e.target.value) })}
              />
              <span className="bench-bl-deltaval" data-sign={Math.sign(v)}>{v > 0 ? `+${v}` : v}</span>
            </label>
          );
        })}
      </div>
    );
  }
  if (spec.kind === 'choice') {
    return (
      <div className="bench-bl bench-bl-choice">
        {spec.options.map((o) => (
          <button
            key={o.value}
            className={`btn sm ${value.choice === o.value ? 'primary' : ''}`}
            onClick={() => onChange({ choice: o.value })}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  // boolean
  return (
    <div className="bench-bl bench-bl-choice">
      <button className={`btn sm ${value.value === true ? 'primary' : ''}`} onClick={() => onChange({ value: true })}>
        Yes
      </button>
      <button className={`btn sm ${value.value === false ? 'primary' : ''}`} onClick={() => onChange({ value: false })}>
        No
      </button>
    </div>
  );
}

// --- transcript + comparison + output views ---------------------------------

function TranscriptView({ result }: { result: BenchCaseResult }) {
  return (
    <div className="bench-transcript">
      {result.transcript.map((t, i) => (
        <div key={i} className={`bench-turn ${t.role}`}>
          <div className="bench-turn-bubble">{t.text}</div>
          {t.role === 'character' && (
            <div className="bench-turn-meta">
              {t.latencyMs != null && <span>{fmtMs(t.latencyMs)}</span>}
              {t.completionTokens != null && <span>{num(t.completionTokens)} tok</span>}
              {t.repetitionVsPrev != null && (
                <span className="bench-rep" style={{ color: repetitionColor(t.repetitionVsPrev) }} title="Similarity to this character's previous line">
                  ↻ {pct(t.repetitionVsPrev)}
                </span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ComparisonTable({ result }: { result: BenchCaseResult }) {
  const cmp = result.comparison;
  if (!cmp) return null;
  return (
    <div className="bench-cmp">
      <table className="bench-cmp-table">
        <thead>
          <tr>
            <th />
            <th>You</th>
            <th>Model</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {cmp.rows.map((r, i) => (
            <tr key={i}>
              <td>{r.label}</td>
              <td>{r.human}</td>
              <td>{r.llm}</td>
              <td className={r.delta === 'match' ? 'bench-match' : r.delta === 'differ' ? 'bench-differ' : ''}>{r.delta}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cmp.closeness != null ? (
        <div className="bench-cmp-score">
          <span className="bench-cmp-pct" style={{ color: cmp.pass === false ? 'var(--ember)' : closenessColor(cmp.closeness) }}>{pct(cmp.closeness)}</span>
          <span className="muted">
            agreement with the baseline
            {cmp.pass === true ? ' · within tolerance ✓' : cmp.pass === false ? ' · off the baseline ✗' : ''}
          </span>
        </div>
      ) : (
        <div className="muted bench-cmp-nobase">Not scored.</div>
      )}
    </div>
  );
}

function OutputBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="bench-output">
      <button className="btn sm ghost" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : 'Show'} raw output
      </button>
      {open && <pre className="pre bench-pre">{text}</pre>}
    </div>
  );
}

// --- per-case card ----------------------------------------------------------

function CaseCard({
  meta,
  selected,
  onToggle,
  status,
  result,
  baseline,
  onSaveBaseline,
  onClearBaseline,
  busy,
}: {
  meta: BenchCaseMeta;
  selected: boolean;
  onToggle: () => void;
  status: CaseStatus;
  result?: BenchCaseResult;
  baseline?: BenchBaseline;
  onSaveBaseline: (value: BenchBaselineValue) => Promise<void>;
  onClearBaseline: () => Promise<void>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<BenchBaselineValue | null>(null);
  const [savingBl, setSavingBl] = useState(false);

  // What the editor shows: an unsaved draft, else the user's saved baseline, else the
  // case's built-in default (so the control is pre-filled and runs are scored as-is).
  const editing = draft ?? baseline?.value ?? meta.defaultBaseline ?? (meta.baselineSpec ? defaultBaseline(meta.baselineSpec) : null);

  const save = async () => {
    if (!editing) return;
    setSavingBl(true);
    try {
      await onSaveBaseline(editing);
      setDraft(null);
    } finally {
      setSavingBl(false);
    }
  };

  const statusDot =
    status === 'running' ? (
      <span className="bench-dot running" title="Running…" />
    ) : status === 'done' ? (
      <span className="bench-dot done" title="Done" />
    ) : status === 'error' ? (
      <span className="bench-dot error" title="Failed" />
    ) : status === 'queued' ? (
      <span className="bench-dot queued" title="Queued" />
    ) : null;

  return (
    <div className={`bench-case ${selected ? 'sel' : ''}`}>
      <div className="bench-case-head">
        <label className="bench-case-check">
          <input type="checkbox" checked={selected} onChange={onToggle} disabled={busy} />
        </label>
        <button className="bench-case-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="bench-case-title">
            <span className="bench-case-name">
              {meta.label}
              {statusDot}
            </span>
            <span className="bench-case-desc">{meta.description}</span>
          </span>
          <span className="bench-case-tags">
            <span className={`badge bench-kind bench-kind-${meta.kind}`}>{meta.kind}</span>
            {meta.baselineSpec && (
              <span className={`badge ${baseline ? 'good' : ''}`} title={baseline ? 'Your saved baseline' : 'Built-in default baseline (override it below)'}>
                {baseline ? 'custom ✓' : 'default'}
              </span>
            )}
            {result && result.comparison?.closeness != null && (
              <span className="badge" style={{ color: result.comparison.pass === false ? 'var(--ember)' : closenessColor(result.comparison.closeness) }}>{pct(result.comparison.closeness)}</span>
            )}
          </span>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={16} />
        </button>
      </div>

      {open && (
        <div className="bench-case-body">
          {/* Setup / sample */}
          <div className="bench-setup">
            {meta.setup.characterBrief && <div className="bench-setup-brief">{meta.setup.characterBrief}</div>}
            {meta.setup.relationshipLine && <div className="bench-setup-rel mono">{meta.setup.relationshipLine}</div>}
            {meta.setup.note && <div className="bench-setup-note">{meta.setup.note}</div>}
            {meta.setup.transcript.length > 0 && (
              <div className="bench-sample">
                {meta.setup.transcript.map((l, i) => (
                  <div key={i} className={`bench-sample-line ${l.speaker}`}>
                    {l.speaker !== 'narrator' && l.speaker !== 'system' && <span className="bench-sample-name">{l.name}</span>}
                    <span className="bench-sample-text">{l.text}</span>
                  </div>
                ))}
              </div>
            )}
            {meta.setup.playerScript.length > 0 && (
              <div className="bench-script">
                <div className="kicker">Scripted player turns</div>
                <ol>
                  {meta.setup.playerScript.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>

          {/* Baseline editor (judge cases) — pre-filled with a sensible default; override + save if you disagree. */}
          {meta.baselineSpec && editing && (
            <div className="bench-baseline">
              <div className="kicker">{meta.baselinePrompt || 'Your baseline'}</div>
              <BaselineEditor spec={meta.baselineSpec} value={editing} onChange={(v) => setDraft(v)} />
              <div className="bench-baseline-actions">
                <button className="btn sm primary" onClick={save} disabled={savingBl}>
                  {savingBl ? 'Saving…' : baseline ? 'Update baseline' : 'Save as my baseline'}
                </button>
                {baseline ? (
                  <button className="btn sm ghost" onClick={() => { setDraft(null); void onClearBaseline(); }} disabled={savingBl}>
                    Reset to default
                  </button>
                ) : (
                  <span className="muted bench-baseline-saved">Using the built-in default — runs score against this unless you save your own.</span>
                )}
              </div>
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="bench-result">
              {!result.ok && <Banner kind="error">{result.error || 'Case failed.'}</Banner>}
              <div className="bench-result-metrics">
                <Metric label="Prompt" value={num(result.promptTokens)} unit="tok" />
                <Metric label="Reply" value={num(result.completionTokens)} unit="tok" />
                <Metric label="Latency" value={fmtMs(result.totalLatencyMs)} />
                <Metric label="Speed" value={fmtTps(result.tokensPerSec)} />
                <Metric label="Calls" value={String(result.attempts)} />
                {result.kind === 'dialogue' && result.repetitionMax != null && (
                  <Metric label="Max repeat" value={pct(result.repetitionMax)} color={repetitionColor(result.repetitionMax)} />
                )}
              </div>
              {result.transcript.length > 0 && <TranscriptView result={result} />}
              {result.comparison && <ComparisonTable result={result} />}
              <OutputBlock text={result.output} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, unit, color }: { label: string; value: string; unit?: string; color?: string }) {
  return (
    <div className="bench-metric">
      <div className="bench-metric-val mono" style={color ? { color } : undefined}>
        {value}
        {unit && <span className="bench-metric-unit"> {unit}</span>}
      </div>
      <div className="bench-metric-lbl">{label}</div>
    </div>
  );
}

// --- results dashboard ------------------------------------------------------

function Dashboard({ results }: { results: BenchCaseResult[] }) {
  const ok = results.filter((r) => r.ok);
  const totalPrompt = results.reduce((n, r) => n + (r.promptTokens ?? 0), 0);
  const totalCompletion = results.reduce((n, r) => n + (r.completionTokens ?? 0), 0);
  const totalLatency = results.reduce((n, r) => n + r.totalLatencyMs, 0);
  const avgTps = totalLatency > 0 && totalCompletion > 0 ? totalCompletion / (totalLatency / 1000) : null;
  const judged = results.filter((r) => r.comparison?.closeness != null);
  const avgCloseness = judged.length ? judged.reduce((n, r) => n + (r.comparison!.closeness ?? 0), 0) / judged.length : null;
  const estimated = results.some((r) => r.tokensEstimated);

  if (!results.length) return null;
  return (
    <div className="bench-dash">
      <div className="bench-dash-cards">
        <div className="bench-stat framed">
          <div className="bench-stat-num mono">{ok.length}/{results.length}</div>
          <div className="bench-stat-lbl">cases passed</div>
        </div>
        <div className="bench-stat framed">
          <div className="bench-stat-num mono">{num(totalPrompt + totalCompletion)}</div>
          <div className="bench-stat-lbl">total tokens{estimated ? ' *' : ''}</div>
        </div>
        <div className="bench-stat framed">
          <div className="bench-stat-num mono">{fmtMs(totalLatency)}</div>
          <div className="bench-stat-lbl">total time</div>
        </div>
        <div className="bench-stat framed">
          <div className="bench-stat-num mono">{avgTps != null ? avgTps.toFixed(1) : '—'}</div>
          <div className="bench-stat-lbl">avg tok/sec</div>
        </div>
        {avgCloseness != null && (
          <div className="bench-stat framed bench-stat-ring">
            <RingGauge value={avgCloseness} label="judge agreement" sub={`${judged.length} judged`} />
          </div>
        )}
      </div>

      <div className="bench-charts">
        <div className="card bench-chart">
          <div className="section-head"><div className="titles"><div className="kicker">Per case</div><h3>Tokens (in / out)</h3></div><div className="trail" /></div>
          <StackedTokens rows={results.map((r) => ({ key: r.caseId, label: r.label, prompt: r.promptTokens ?? 0, completion: r.completionTokens ?? 0 }))} />
          <div className="bench-legend"><span><i style={{ background: 'var(--moon)' }} /> prompt</span><span><i style={{ background: 'var(--rose)' }} /> reply</span></div>
        </div>
        <div className="card bench-chart">
          <div className="section-head"><div className="titles"><div className="kicker">Per case</div><h3>Latency</h3></div><div className="trail" /></div>
          <Bars items={results.map((r) => ({ key: r.caseId, label: r.label, value: r.totalLatencyMs, display: fmtMs(r.totalLatencyMs), color: 'var(--brass)' }))} />
        </div>
        <div className="card bench-chart">
          <div className="section-head"><div className="titles"><div className="kicker">Per case</div><h3>Speed (tok/sec)</h3></div><div className="trail" /></div>
          <Bars items={results.filter((r) => r.tokensPerSec != null).map((r) => ({ key: r.caseId, label: r.label, value: r.tokensPerSec ?? 0, display: fmtTps(r.tokensPerSec), color: 'var(--moon)' }))} />
        </div>
        {judged.length > 0 && (
          <div className="card bench-chart">
            <div className="section-head"><div className="titles"><div className="kicker">Human vs model</div><h3>Judge agreement</h3></div><div className="trail" /></div>
            <Bars items={judged.map((r) => ({ key: r.caseId, label: r.label, value: r.comparison!.closeness ?? 0, display: pct(r.comparison!.closeness), color: closenessColor(r.comparison!.closeness ?? 0) }))} max={1} />
          </div>
        )}
      </div>
      {estimated && <p className="muted bench-foot">* Some token counts are chars/4 estimates (your endpoint didn’t report usage).</p>}
    </div>
  );
}

// --- history ----------------------------------------------------------------

function History({ onOpen }: { onOpen: (run: BenchRunSummary) => void }) {
  const [runs, setRuns] = useState<BenchRunListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [compareRuns, setCompareRuns] = useState<BenchRunSummary[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      setRuns((await api.benchRuns()).runs);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const toggleCompare = (id: string) => {
    setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length < 2 ? [...c, id] : [c[1]!, id]));
  };

  useEffect(() => {
    // Guard against out-of-order responses clobbering a newer selection.
    let cancelled = false;
    void (async () => {
      const loaded = await Promise.all(compare.map((id) => api.benchRun(id).catch(() => null)));
      if (cancelled) return;
      setCompareRuns(loaded.filter((r): r is BenchRunSummary => r !== null));
    })();
    return () => {
      cancelled = true;
    };
  }, [compare]);

  const del = async (id: string) => {
    try {
      await api.benchDeleteRun(id);
      setConfirmId(null);
      setCompare((c) => c.filter((x) => x !== id));
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (loading) return <Spinner />;
  return (
    <div className="bench-history">
      {error && <Banner kind="error">{error}</Banner>}
      {runs.length === 0 ? (
        <p className="muted">No saved runs yet. Run a bench and save it to compare later.</p>
      ) : (
        <>
          {compareRuns.length === 2 && <CompareStrip a={compareRuns[0]!} b={compareRuns[1]!} />}
          <div className="bench-runlist">
            {runs.map((r) => (
              <div key={r.id} className="bench-runrow framed">
                <div className="bench-runrow-line">
                  <label className="bench-runrow-cmp" title="Compare (pick two)">
                    <input type="checkbox" checked={compare.includes(r.id)} onChange={() => toggleCompare(r.id)} />
                  </label>
                  <button className="bench-runrow-main" onClick={() => void api.benchRun(r.id).then(onOpen).catch((e) => setError(errorMessage(e)))}>
                    <div className="bench-runrow-top">
                      <span className="bench-runrow-label">{r.label || 'Untitled run'}</span>
                      <span className="badge mono">{r.model}</span>
                      {r.failures.length > 0 && <span className="badge danger">{r.failures.length} failed</span>}
                    </div>
                    <div className="bench-runrow-meta mono">
                      {new Date(r.createdAt).toLocaleString()} · {r.aggregate.passed}/{r.aggregate.cases} passed ·{' '}
                      {num(r.aggregate.totalPromptTokens + r.aggregate.totalCompletionTokens)} tok ·{' '}
                      {r.aggregate.avgTokensPerSec != null ? `${r.aggregate.avgTokensPerSec.toFixed(1)} tok/s` : '—'}
                      {r.aggregate.avgCloseness != null ? ` · judge ${pct(r.aggregate.avgCloseness)}` : ''}
                    </div>
                  </button>
                  <button className="btn sm danger ghost" aria-label="Delete run" title="Delete run" onClick={() => setConfirmId(r.id)}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
                {r.failures.length > 0 && (
                  <ul className="bench-runrow-fails">
                    {r.failures.map((f) => (
                      <li key={f.caseId} className="bench-runrow-fail">
                        <span className={`badge bench-kind bench-kind-${f.kind}`}>{f.kind}</span>
                        <span className="bench-fail-label">{f.label}</span>
                        {f.error && <span className="bench-fail-err" title={f.error}>{f.error}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {confirmId && (
        <ConfirmDialog
          title="Delete this run?"
          body="This permanently removes the saved bench run."
          confirmLabel="Delete"
          danger
          onConfirm={() => void del(confirmId)}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}

function CompareStrip({ a, b }: { a: BenchRunSummary; b: BenchRunSummary }) {
  const rows: Array<{ label: string; a: string; b: string }> = [
    { label: 'Model', a: a.model, b: b.model },
    { label: 'Passed', a: `${a.aggregate.passed}/${a.aggregate.cases}`, b: `${b.aggregate.passed}/${b.aggregate.cases}` },
    { label: 'Total tokens', a: num(a.aggregate.totalPromptTokens + a.aggregate.totalCompletionTokens), b: num(b.aggregate.totalPromptTokens + b.aggregate.totalCompletionTokens) },
    { label: 'Total time', a: fmtMs(a.aggregate.totalLatencyMs), b: fmtMs(b.aggregate.totalLatencyMs) },
    { label: 'Avg tok/s', a: a.aggregate.avgTokensPerSec != null ? a.aggregate.avgTokensPerSec.toFixed(1) : '—', b: b.aggregate.avgTokensPerSec != null ? b.aggregate.avgTokensPerSec.toFixed(1) : '—' },
    { label: 'Judge agreement', a: pct(a.aggregate.avgCloseness), b: pct(b.aggregate.avgCloseness) },
  ];
  return (
    <div className="card bench-compare">
      <div className="section-head"><div className="titles"><div className="kicker">Side by side</div><h3>Compare runs</h3></div><div className="trail" /></div>
      <table className="bench-cmp-table bench-compare-table">
        <thead>
          <tr>
            <th />
            <th>{a.label || 'A'}</th>
            <th>{b.label || 'B'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td className="mono">{r.a}</td>
              <td className="mono">{r.b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- main page --------------------------------------------------------------

const QUICK_IDS = ['judge_turn_good', 'judge_turn_bad', 'judge_eval_good', 'judge_text_hostile', 'dialogue_text', 'gen_day_recap'];

export function Bench() {
  const [catalog, setCatalog] = useState<BenchCatalog | null>(null);
  const [baselines, setBaselines] = useState<Record<string, BenchBaseline>>({});
  const [error, setError] = useState<string>();
  const [view, setView] = useState<'run' | 'history'>('run');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialogueTurns, setDialogueTurns] = useState(6);
  const [llmPlayer, setLlmPlayer] = useState(false);
  const [label, setLabel] = useState('');

  const [status, setStatus] = useState<Record<string, CaseStatus>>({});
  const [results, setResults] = useState<Record<string, BenchCaseResult>>({});
  const [running, setRunning] = useState(false);
  const [savedNote, setSavedNote] = useState<string>();
  const abortRef = useRef<AbortController | null>(null);
  /** Id shared by every case in the current run, so Cancel can abort the in-flight
   *  case server-side via /bench/cancel (not just the local fetch). */
  const runIdRef = useRef<string>('');
  /** Settings snapshot captured when the current results' run STARTED, so saving
   *  records what the run actually executed under (not what's configured now). */
  const runSnapshotRef = useRef<BenchSettingsSnapshot | null>(null);

  const loadBaselines = async () => {
    const { baselines: list } = await api.benchBaselines();
    setBaselines(Object.fromEntries(list.map((b) => [b.caseId, b])));
  };

  useEffect(() => {
    void (async () => {
      try {
        const cat = await api.benchCatalog();
        setCatalog(cat);
        setSelected(new Set(cat.cases.map((c) => c.id))); // default: everything selected
        await loadBaselines();
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, []);

  const casesByGroup = useMemo(() => {
    const map = new Map<string, BenchCaseMeta[]>();
    for (const g of catalog?.groups ?? []) map.set(g, []);
    for (const c of catalog?.cases ?? []) {
      if (!map.has(c.group)) map.set(c.group, []);
      map.get(c.group)!.push(c);
    }
    return map;
  }, [catalog]);

  const orderedResults = useMemo(() => {
    const order = catalog?.cases.map((c) => c.id) ?? [];
    return order.map((id) => results[id]).filter((r): r is BenchCaseResult => Boolean(r));
  }, [catalog, results]);

  if (!catalog) {
    return (
      <div className="stack bench-page">
        {error ? <Banner kind="error">{error}</Banner> : <Spinner />}
      </div>
    );
  }

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const setSel = (ids: string[]) => setSelected(new Set(ids));

  const saveBaseline = async (caseId: string, value: BenchBaselineValue) => {
    const saved = await api.benchSaveBaseline(caseId, value);
    setBaselines((b) => ({ ...b, [caseId]: saved }));
  };

  const clearBaseline = async (caseId: string) => {
    await api.benchClearBaseline(caseId);
    setBaselines((b) => {
      const next = { ...b };
      delete next[caseId];
      return next;
    });
  };

  const run = async () => {
    const ids = catalog.cases.map((c) => c.id).filter((id) => selected.has(id));
    if (!ids.length) return;
    setRunning(true);
    setSavedNote(undefined);
    setError(undefined);
    setResults({});
    setStatus(Object.fromEntries(ids.map((id) => [id, 'queued' as CaseStatus])));
    // Snapshot the settings this run executes under (so a later model change can't
    // mislabel it). Best-effort: a failure just falls back to server-side capture.
    try {
      const s = await api.getSettings();
      runSnapshotRef.current = { model: s.model, baseUrl: s.baseUrl, temperature: s.temperature, maxTokens: s.maxTokens, structuredMode: s.structuredMode, nsfwEnabled: s.nsfwEnabled };
    } catch {
      runSnapshotRef.current = null;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    for (const id of ids) {
      if (ac.signal.aborted) {
        setStatus((s) => ({ ...s, [id]: 'idle' }));
        continue;
      }
      setStatus((s) => ({ ...s, [id]: 'running' }));
      try {
        const r = await api.benchRunCase({ caseId: id, llmPlayer, dialogueTurns, runId }, ac.signal);
        setResults((prev) => ({ ...prev, [id]: r }));
        setStatus((s) => ({ ...s, [id]: r.ok ? 'done' : 'error' }));
      } catch (e) {
        if (ac.signal.aborted) {
          setStatus((s) => ({ ...s, [id]: 'idle' }));
        } else {
          setStatus((s) => ({ ...s, [id]: 'error' }));
          const m = catalog.cases.find((c) => c.id === id);
          setResults((prev) => ({
            ...prev,
            [id]: { caseId: id, label: m?.label ?? id, group: m?.group ?? '', kind: m?.kind ?? 'generation', ok: false, error: errorMessage(e), calls: [], promptTokens: null, completionTokens: null, totalLatencyMs: 0, attempts: 0, tokensPerSec: null, tokensEstimated: false, output: '', transcript: [], repetitionMax: null, repetitionAvg: null, comparison: null },
          }));
        }
      }
    }
    setRunning(false);
    abortRef.current = null;
  };

  const cancel = () => {
    // Tell the server to abort the in-flight case (reliable), then abort the local
    // fetch + stop the client loop.
    if (runIdRef.current) void api.benchCancel(runIdRef.current).catch(() => undefined);
    abortRef.current?.abort();
    setRunning(false);
  };

  const save = async () => {
    const done = orderedResults;
    if (!done.length) return;
    try {
      const ids = done.map((r) => r.caseId);
      const runReq = { caseIds: ids, llmPlayer, dialogueTurns, label };
      await api.benchSaveRun(label, runReq, done, runSnapshotRef.current);
      setSavedNote('Run saved — find it under History.');
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const openHistoricalRun = (rsum: BenchRunSummary) => {
    setResults(Object.fromEntries(rsum.results.map((r) => [r.caseId, r])));
    setStatus(Object.fromEntries(rsum.results.map((r) => [r.caseId, r.ok ? 'done' : 'error'])));
    setLabel(rsum.label);
    // Restore the run's options so the controls reflect (and a re-save records) the
    // settings this run actually executed under, not the live defaults.
    setLlmPlayer(rsum.request.llmPlayer);
    setDialogueTurns(rsum.request.dialogueTurns);
    runSnapshotRef.current = rsum.settings;
    setView('run');
  };

  const selectedCount = selected.size;
  const doneCount = orderedResults.length;

  return (
    <div className="stack bench-page">
      <div className="page-head">
        <div className="kicker">Diagnostics · the proving bench</div>
        <h1>Heartmorrow Benchmark</h1>
        <p>
          Run the real prompts this game asks of your model - the rapport judges, the date evaluator, the texting
          replies, the world &amp; creator generators - against a fixed sample cast in <strong>Lanternford</strong>.
          The point of this is to measure whether or not your model is, on a technical level, able to produce the structured output needed,
		  and on a subjective level, produce interesting and fun prose which is not repetitive and does not go off the rails. Some models can easily produce the structured output but
		  also produce very dry or bad prose.
		  <br />
		  <br />Current Model:{' '}
          <strong className="mono">{catalog.model}</strong>.
        </p>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {savedNote && <Banner kind="ok">{savedNote}</Banner>}

      <div className="bench-tabs">
        <button className={`btn sm ${view === 'run' ? 'primary' : ''}`} onClick={() => setView('run')}>
          Run
        </button>
        <button className={`btn sm ${view === 'history' ? 'primary' : ''}`} onClick={() => setView('history')}>
          History
        </button>
        <Link to="/settings" className="btn sm ghost bench-back">
          <Icon name="settings" size={14} /> Settings
        </Link>
      </div>

      {view === 'history' ? (
        <History onOpen={openHistoricalRun} />
      ) : (
        <>
          {/* Control desk */}
          <div className="framed bench-console">
            <div className="bench-console-row">
              <div className="bench-presets">
                <span className="kicker">Select</span>
                <button className="btn sm" onClick={() => setSel(catalog.cases.map((c) => c.id))} disabled={running}>All</button>
                <button className="btn sm" onClick={() => setSel(catalog.cases.filter((c) => c.kind === 'judge').map((c) => c.id))} disabled={running}>Judges</button>
                <button className="btn sm" onClick={() => setSel(catalog.cases.filter((c) => QUICK_IDS.includes(c.id)).map((c) => c.id))} disabled={running}>Quick</button>
                <button className="btn sm" onClick={() => setSel([])} disabled={running}>None</button>
              </div>
              <div className="bench-opts">
                <label className="bench-opt">
                  <span>Dialogue turns: {dialogueTurns}</span>
                  <input type="range" min={2} max={12} step={1} value={dialogueTurns} onChange={(e) => setDialogueTurns(Number(e.target.value))} disabled={running} />
                </label>
                <label className="bench-opt bench-opt-check" title="Let a second model play the player side of dialogue (dynamic but less comparable).">
                  <input type="checkbox" checked={llmPlayer} onChange={(e) => setLlmPlayer(e.target.checked)} disabled={running} />
                  <span>LLM plays the player</span>
                </label>
              </div>
            </div>
            <div className="bench-console-foot">
              <input className="bench-label-input" placeholder="Run label (optional, e.g. “Llama-3 8B @ temp 0.8”)" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value.slice(0, 80))} disabled={running} />
              {running ? (
                <button className="btn danger" onClick={cancel}>Cancel</button>
              ) : (
                <button className="btn primary" onClick={run} disabled={selectedCount === 0}>
                  <Icon name="play" size={15} /> Run {selectedCount} case{selectedCount === 1 ? '' : 's'}
                </button>
              )}
              {doneCount > 0 && !running && (
                <button className="btn" onClick={save}>
                  <Icon name="save" size={15} /> Save run
                </button>
              )}
            </div>
            {running && (
              <div className="bench-progress">
                <div className="bench-progress-track">
                  <div className="bench-progress-fill" style={{ width: `${(doneCount / Math.max(1, selectedCount)) * 100}%` }} />
                </div>
                <span className="muted mono">{doneCount}/{selectedCount} done</span>
              </div>
            )}
          </div>

          {/* Dashboard (after results exist) */}
          {orderedResults.length > 0 && <Dashboard results={orderedResults} />}

          {/* Case list, grouped */}
          {[...casesByGroup.entries()].map(([group, cases]) =>
            cases.length === 0 ? null : (
              <div key={group} className="bench-group">
                <div className="section-head">
                  <div className="titles">
                    <div className="kicker">{cases.length} case{cases.length === 1 ? '' : 's'}</div>
                    <h2>{group}</h2>
                  </div>
                  <div className="trail" />
                  <button
                    className="btn sm ghost"
                    disabled={running}
                    onClick={() => {
                      const ids = cases.map((c) => c.id);
                      const allSel = ids.every((id) => selected.has(id));
                      setSelected((s) => {
                        const next = new Set(s);
                        ids.forEach((id) => (allSel ? next.delete(id) : next.add(id)));
                        return next;
                      });
                    }}
                  >
                    Toggle group
                  </button>
                </div>
                <div className="bench-caselist">
                  {cases.map((meta) => (
                    <CaseCard
                      key={meta.id}
                      meta={meta}
                      selected={selected.has(meta.id)}
                      onToggle={() => toggle(meta.id)}
                      status={status[meta.id] ?? 'idle'}
                      result={results[meta.id]}
                      baseline={baselines[meta.id]}
                      onSaveBaseline={(v) => saveBaseline(meta.id, v)}
                      onClearBaseline={() => clearBaseline(meta.id)}
                      busy={running}
                    />
                  ))}
                </div>
              </div>
            ),
          )}
        </>
      )}
    </div>
  );
}
