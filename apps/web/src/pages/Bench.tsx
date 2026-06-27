import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import i18n from '../i18n';
import { Banner, Spinner, ConfirmDialog } from '../components/ui';
import { Icon } from '../components/Icon';
import './bench.page.css';

type CaseStatus = 'idle' | 'queued' | 'running' | 'done' | 'error';

// --- small format helpers ---------------------------------------------------

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`);
const num = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString(i18n.language));
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
  const { t } = useTranslation('pages');
  const m = max ?? Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="muted bench-empty">{t('bench.noData')}</p>;
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
  const { t } = useTranslation('pages');
  const max = Math.max(1, ...rows.map((r) => r.prompt + r.completion));
  if (!rows.length) return <p className="muted bench-empty">{t('bench.noData')}</p>;
  return (
    <div className="bench-bars">
      {rows.map((r) => (
        <div className="bench-bar-row" key={r.key}>
          <div className="bench-bar-label" title={r.label}>{r.label}</div>
          <div className="bench-bar-track">
            <div className="bench-bar-fill" style={{ width: `${(r.prompt / max) * 100}%`, background: 'var(--moon)' }} title={t('bench.inTitle', { n: num(r.prompt) })} />
            <div className="bench-bar-fill" style={{ width: `${(r.completion / max) * 100}%`, background: 'var(--rose)' }} title={t('bench.outTitle', { n: num(r.completion) })} />
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
  const { t } = useTranslation('pages');
  if (spec.kind === 'engagement') {
    const eng = Number(value.engagement ?? 0);
    return (
      <div className="bench-bl">
        <label className="bench-bl-eng">
          <span className="bench-bl-engval" data-sign={Math.sign(eng)}>
            {eng > 0 ? `+${eng}` : eng}
          </span>
          <input type="range" min={-3} max={3} step={1} value={eng} onChange={(e) => onChange({ ...value, engagement: Number(e.target.value) })} />
          <span className="bench-bl-scale"><span>{t('bench.bombed')}</span><span>{t('bench.connected')}</span></span>
        </label>
        {spec.hostile && (
          <label className="bench-bl-check">
            <input type="checkbox" checked={Boolean(value.hostile)} onChange={(e) => onChange({ ...value, hostile: e.target.checked })} />
            <span>{t('bench.hostileCruel')}</span>
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
        {t('bench.yes')}
      </button>
      <button className={`btn sm ${value.value === false ? 'primary' : ''}`} onClick={() => onChange({ value: false })}>
        {t('bench.no')}
      </button>
    </div>
  );
}

// --- transcript + comparison + output views ---------------------------------

function TranscriptView({ result }: { result: BenchCaseResult }) {
  const { t: tr } = useTranslation('pages');
  return (
    <div className="bench-transcript">
      {result.transcript.map((t, i) => (
        <div key={i} className={`bench-turn ${t.role}`}>
          <div className="bench-turn-bubble">{t.text}</div>
          {t.role === 'character' && (
            <div className="bench-turn-meta">
              {t.latencyMs != null && <span>{fmtMs(t.latencyMs)}</span>}
              {t.completionTokens != null && <span>{num(t.completionTokens)} {tr('bench.tokUnit')}</span>}
              {t.repetitionVsPrev != null && (
                <span className="bench-rep" style={{ color: repetitionColor(t.repetitionVsPrev) }} title={tr('bench.repetitionTitle')}>
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
  const { t } = useTranslation('pages');
  const cmp = result.comparison;
  if (!cmp) return null;
  return (
    <div className="bench-cmp">
      <table className="bench-cmp-table">
        <thead>
          <tr>
            <th />
            <th>{t('bench.cmpYou')}</th>
            <th>{t('bench.cmpModel')}</th>
            <th>{t('bench.cmpDelta')}</th>
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
            {t('bench.agreement')}
            {cmp.pass === true ? t('bench.withinTolerance') : cmp.pass === false ? t('bench.offBaseline') : ''}
          </span>
        </div>
      ) : (
        <div className="muted bench-cmp-nobase">{t('bench.notScored')}</div>
      )}
    </div>
  );
}

function OutputBlock({ text }: { text: string }) {
  const { t } = useTranslation('pages');
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="bench-output">
      <button className="btn sm ghost" onClick={() => setOpen((o) => !o)}>
        {open ? t('bench.hideRaw') : t('bench.showRaw')}
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
  const { t } = useTranslation('pages');
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
      <span className="bench-dot running" title={t('bench.statusRunning')} />
    ) : status === 'done' ? (
      <span className="bench-dot done" title={t('bench.statusDone')} />
    ) : status === 'error' ? (
      <span className="bench-dot error" title={t('bench.statusFailed')} />
    ) : status === 'queued' ? (
      <span className="bench-dot queued" title={t('bench.statusQueued')} />
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
              <span className={`badge ${baseline ? 'good' : ''}`} title={baseline ? t('bench.baselineSavedTitle') : t('bench.baselineDefaultTitle')}>
                {baseline ? t('bench.custom') : t('bench.default')}
              </span>
            )}
            {result && result.comparison?.closeness != null && (
              <span className="badge" style={{ color: result.comparison.pass === false ? 'var(--ember)' : closenessColor(result.comparison.closeness) }}>{pct(result.comparison.closeness)}</span>
            )}
            {result?.structuredMode && result.structuredMode.final !== result.structuredMode.requested && (
              <span className="badge warn mono" title={t('bench.fallbackBadgeTitle')}>
                {result.structuredMode.requested} → {result.structuredMode.final}
              </span>
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
                <div className="kicker">{t('bench.scriptedTurns')}</div>
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
              <div className="kicker">{meta.baselinePrompt || t('bench.yourBaseline')}</div>
              <BaselineEditor spec={meta.baselineSpec} value={editing} onChange={(v) => setDraft(v)} />
              <div className="bench-baseline-actions">
                <button className="btn sm primary" onClick={save} disabled={savingBl}>
                  {savingBl ? t('bench.savingBl') : baseline ? t('bench.updateBaseline') : t('bench.saveBaseline')}
                </button>
                {baseline ? (
                  <button className="btn sm ghost" onClick={() => { setDraft(null); void onClearBaseline(); }} disabled={savingBl}>
                    {t('bench.resetDefault')}
                  </button>
                ) : (
                  <span className="muted bench-baseline-saved">{t('bench.usingDefault')}</span>
                )}
              </div>
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="bench-result">
              {!result.ok && <Banner kind="error">{result.error || t('bench.caseFailed')}</Banner>}
              <div className="bench-result-metrics">
                <Metric label={t('bench.mPrompt')} value={num(result.promptTokens)} unit={t('bench.tokUnit')} />
                <Metric label={t('bench.mReply')} value={num(result.completionTokens)} unit={t('bench.tokUnit')} />
                <Metric label={t('bench.mLatency')} value={fmtMs(result.totalLatencyMs)} />
                <Metric label={t('bench.mSpeed')} value={fmtTps(result.tokensPerSec)} />
                <Metric label={t('bench.mCalls')} value={String(result.attempts)} />
                {result.kind === 'dialogue' && result.repetitionMax != null && (
                  <Metric label={t('bench.mMaxRepeat')} value={pct(result.repetitionMax)} color={repetitionColor(result.repetitionMax)} />
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
  const { t } = useTranslation('pages');
  const ok = results.filter((r) => r.ok);
  const totalPrompt = results.reduce((n, r) => n + (r.promptTokens ?? 0), 0);
  const totalCompletion = results.reduce((n, r) => n + (r.completionTokens ?? 0), 0);
  const totalLatency = results.reduce((n, r) => n + r.totalLatencyMs, 0);
  const avgTps = totalLatency > 0 && totalCompletion > 0 ? totalCompletion / (totalLatency / 1000) : null;
  const judged = results.filter((r) => r.comparison?.closeness != null);
  const avgCloseness = judged.length ? judged.reduce((n, r) => n + (r.comparison!.closeness ?? 0), 0) / judged.length : null;
  const estimated = results.some((r) => r.tokensEstimated);
  // Cases whose structured-output mode downgraded from the one requested. A fallback
  // is NOT a failure — it shows the endpoint couldn't serve the requested mode.
  const fellBack = results.filter((r) => r.structuredMode && r.structuredMode.final !== r.structuredMode.requested);
  const fallbackByMode = fellBack.reduce<Record<string, number>>((acc, r) => {
    const f = r.structuredMode!.final;
    acc[f] = (acc[f] ?? 0) + 1;
    return acc;
  }, {});

  if (!results.length) return null;
  return (
    <div className="bench-dash">
      <div className="bench-dash-cards">
        <div className="bench-stat framed">
          <div className="bench-stat-num mono">{ok.length}/{results.length}</div>
          <div className="bench-stat-lbl">{t('bench.casesPassed')}</div>
        </div>
        <div className="bench-stat framed">
          <div className="bench-stat-num mono">{num(totalPrompt + totalCompletion)}</div>
          <div className="bench-stat-lbl">{t('bench.totalTokens')}{estimated ? ' *' : ''}</div>
        </div>
        <div className="bench-stat framed">
          <div className="bench-stat-num mono">{fmtMs(totalLatency)}</div>
          <div className="bench-stat-lbl">{t('bench.totalTime')}</div>
        </div>
        <div className="bench-stat framed">
          <div className="bench-stat-num mono">{avgTps != null ? avgTps.toFixed(1) : '—'}</div>
          <div className="bench-stat-lbl">{t('bench.avgTokSec')}</div>
        </div>
        {avgCloseness != null && (
          <div className="bench-stat framed bench-stat-ring">
            <RingGauge value={avgCloseness} label={t('bench.judgeAgreement')} sub={t('bench.nJudged', { count: judged.length })} />
          </div>
        )}
        {fellBack.length > 0 && (
          <div className="bench-stat framed" title={t('bench.fellBackTitle')}>
            <div className="bench-stat-num mono" style={{ color: 'var(--brass)' }}>{fellBack.length}</div>
            <div className="bench-stat-lbl">{t('bench.fellBack')}</div>
            <div className="bench-stat-sub mono">{Object.entries(fallbackByMode).map(([m, n]) => `${n} → ${m}`).join(' · ')}</div>
          </div>
        )}
      </div>

      <div className="bench-charts">
        <div className="card bench-chart">
          <div className="section-head"><div className="titles"><div className="kicker">{t('bench.perCase')}</div><h3>{t('bench.chTokens')}</h3></div><div className="trail" /></div>
          <StackedTokens rows={results.map((r) => ({ key: r.caseId, label: r.label, prompt: r.promptTokens ?? 0, completion: r.completionTokens ?? 0 }))} />
          <div className="bench-legend"><span><i style={{ background: 'var(--moon)' }} /> {t('bench.legendPrompt')}</span><span><i style={{ background: 'var(--rose)' }} /> {t('bench.legendReply')}</span></div>
        </div>
        <div className="card bench-chart">
          <div className="section-head"><div className="titles"><div className="kicker">{t('bench.perCase')}</div><h3>{t('bench.chLatency')}</h3></div><div className="trail" /></div>
          <Bars items={results.map((r) => ({ key: r.caseId, label: r.label, value: r.totalLatencyMs, display: fmtMs(r.totalLatencyMs), color: 'var(--brass)' }))} />
        </div>
        <div className="card bench-chart">
          <div className="section-head"><div className="titles"><div className="kicker">{t('bench.perCase')}</div><h3>{t('bench.chSpeed')}</h3></div><div className="trail" /></div>
          <Bars items={results.filter((r) => r.tokensPerSec != null).map((r) => ({ key: r.caseId, label: r.label, value: r.tokensPerSec ?? 0, display: fmtTps(r.tokensPerSec), color: 'var(--moon)' }))} />
        </div>
        {judged.length > 0 && (
          <div className="card bench-chart">
            <div className="section-head"><div className="titles"><div className="kicker">{t('bench.humanVsModel')}</div><h3>{t('bench.chJudge')}</h3></div><div className="trail" /></div>
            <Bars items={judged.map((r) => ({ key: r.caseId, label: r.label, value: r.comparison!.closeness ?? 0, display: pct(r.comparison!.closeness), color: closenessColor(r.comparison!.closeness ?? 0) }))} max={1} />
          </div>
        )}
      </div>
      {estimated && <p className="muted bench-foot">{t('bench.estFoot')}</p>}
    </div>
  );
}

// --- history ----------------------------------------------------------------

function History({ onOpen }: { onOpen: (run: BenchRunSummary) => void }) {
  const { t } = useTranslation('pages');
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
        <p className="muted">{t('bench.noRuns')}</p>
      ) : (
        <>
          {compareRuns.length === 2 && <CompareStrip a={compareRuns[0]!} b={compareRuns[1]!} />}
          <div className="bench-runlist">
            {runs.map((r) => (
              <div key={r.id} className="bench-runrow framed">
                <div className="bench-runrow-line">
                  <label className="bench-runrow-cmp" title={t('bench.comparePick')}>
                    <input type="checkbox" checked={compare.includes(r.id)} onChange={() => toggleCompare(r.id)} />
                  </label>
                  <button className="bench-runrow-main" onClick={() => void api.benchRun(r.id).then(onOpen).catch((e) => setError(errorMessage(e)))}>
                    <div className="bench-runrow-top">
                      <span className="bench-runrow-label">{r.label || t('bench.untitledRun')}</span>
                      <span className="badge mono">{r.model}</span>
                      {r.failures.length > 0 && <span className="badge danger">{t('bench.nFailed', { count: r.failures.length })}</span>}
                      {r.aggregate.structuredFallbacks > 0 && (
                        <span className="badge warn" title={t('bench.fellBackTitle')}>{t('bench.nFellBack', { count: r.aggregate.structuredFallbacks })}</span>
                      )}
                    </div>
                    <div className="bench-runrow-meta mono">
                      {new Date(r.createdAt).toLocaleString(i18n.language)} · {t('bench.passedOf', { passed: r.aggregate.passed, cases: r.aggregate.cases })} ·{' '}
                      {num(r.aggregate.totalPromptTokens + r.aggregate.totalCompletionTokens)} {t('bench.tokUnit')} ·{' '}
                      {r.aggregate.avgTokensPerSec != null ? `${r.aggregate.avgTokensPerSec.toFixed(1)} tok/s` : '—'}
                      {r.aggregate.avgCloseness != null ? t('bench.judgePct', { pct: pct(r.aggregate.avgCloseness) }) : ''}
                    </div>
                  </button>
                  <button className="btn sm danger ghost" aria-label={t('bench.deleteRun')} title={t('bench.deleteRun')} onClick={() => setConfirmId(r.id)}>
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
          title={t('bench.deleteRunTitle')}
          body={t('bench.deleteRunBody')}
          confirmLabel={t('bench.delete')}
          danger
          onConfirm={() => void del(confirmId)}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}

function CompareStrip({ a, b }: { a: BenchRunSummary; b: BenchRunSummary }) {
  const { t } = useTranslation('pages');
  const rows: Array<{ label: string; a: string; b: string }> = [
    { label: t('bench.csModel'), a: a.model, b: b.model },
    { label: t('bench.csPassed'), a: `${a.aggregate.passed}/${a.aggregate.cases}`, b: `${b.aggregate.passed}/${b.aggregate.cases}` },
    { label: t('bench.csTotalTokens'), a: num(a.aggregate.totalPromptTokens + a.aggregate.totalCompletionTokens), b: num(b.aggregate.totalPromptTokens + b.aggregate.totalCompletionTokens) },
    { label: t('bench.csTotalTime'), a: fmtMs(a.aggregate.totalLatencyMs), b: fmtMs(b.aggregate.totalLatencyMs) },
    { label: t('bench.csAvgTokS'), a: a.aggregate.avgTokensPerSec != null ? a.aggregate.avgTokensPerSec.toFixed(1) : '—', b: b.aggregate.avgTokensPerSec != null ? b.aggregate.avgTokensPerSec.toFixed(1) : '—' },
    { label: t('bench.csJudge'), a: pct(a.aggregate.avgCloseness), b: pct(b.aggregate.avgCloseness) },
  ];
  return (
    <div className="card bench-compare">
      <div className="section-head"><div className="titles"><div className="kicker">{t('bench.sideBySide')}</div><h3>{t('bench.compareRuns')}</h3></div><div className="trail" /></div>
      <table className="bench-cmp-table bench-compare-table">
        <thead>
          <tr>
            <th />
            <th>{a.label || t('bench.runA')}</th>
            <th>{b.label || t('bench.runB')}</th>
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
  const { t } = useTranslation('pages');
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
  /** Ephemeral Prompt-Editor overrides handed off from /prompts to preview here. Read
   *  once from sessionStorage; applied to every case run until the player dismisses it. */
  const [previewOverrides, setPreviewOverrides] = useState<Record<string, string> | null>(null);
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

  // One-shot handoff from the Prompt Editor's "Preview in Bench": consume the
  // sessionStorage entry so a later refresh doesn't silently keep previewing.
  useEffect(() => {
    const raw = sessionStorage.getItem('dsim.promptPreview'); // PromptEditor.PROMPT_PREVIEW_KEY
    if (!raw) return;
    sessionStorage.removeItem('dsim.promptPreview');
    try {
      const map = JSON.parse(raw) as Record<string, string>;
      if (map && typeof map === 'object' && Object.keys(map).length > 0) setPreviewOverrides(map);
    } catch {
      /* ignore a malformed handoff */
    }
  }, []);

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
        const r = await api.benchRunCase(
          { caseId: id, llmPlayer, dialogueTurns, runId, promptOverrides: previewOverrides ?? {} },
          ac.signal,
        );
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
            [id]: { caseId: id, label: m?.label ?? id, group: m?.group ?? '', kind: m?.kind ?? 'generation', ok: false, error: errorMessage(e), calls: [], promptTokens: null, completionTokens: null, totalLatencyMs: 0, attempts: 0, tokensPerSec: null, tokensEstimated: false, output: '', transcript: [], repetitionMax: null, repetitionAvg: null, comparison: null, structuredMode: null },
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
      setSavedNote(t('bench.runSaved'));
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
        <div className="kicker">{t('bench.proving')}</div>
        <h1>{t('bench.title')}</h1>
        <p>
          {t('bench.intro')}
          <br />
          <br />
          {t('bench.currentModel')}{' '}
          <strong className="mono">{catalog.model}</strong>.
        </p>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {savedNote && <Banner kind="ok">{savedNote}</Banner>}
      {previewOverrides && (
        <Banner kind="info">
          {t('bench.previewing', { count: Object.keys(previewOverrides).length })}{' '}
          <button className="btn sm" onClick={() => setPreviewOverrides(null)} style={{ marginLeft: 8 }}>
            {t('bench.previewClear')}
          </button>
        </Banner>
      )}

      <div className="bench-tabs">
        <button className={`btn sm ${view === 'run' ? 'primary' : ''}`} onClick={() => setView('run')}>
          {t('bench.tabRun')}
        </button>
        <button className={`btn sm ${view === 'history' ? 'primary' : ''}`} onClick={() => setView('history')}>
          {t('bench.tabHistory')}
        </button>
        <Link to="/settings" className="btn sm ghost bench-back">
          <Icon name="settings" size={14} /> {t('bench.settings')}
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
                <span className="kicker">{t('bench.select')}</span>
                <button className="btn sm" onClick={() => setSel(catalog.cases.map((c) => c.id))} disabled={running}>{t('bench.selAll')}</button>
                <button className="btn sm" onClick={() => setSel(catalog.cases.filter((c) => c.kind === 'judge').map((c) => c.id))} disabled={running}>{t('bench.selJudges')}</button>
                <button className="btn sm" onClick={() => setSel(catalog.cases.filter((c) => c.tags.includes('generator')).map((c) => c.id))} disabled={running}>{t('bench.selGenerators')}</button>
                <button className="btn sm" onClick={() => setSel(catalog.cases.filter((c) => c.tags.includes('prose')).map((c) => c.id))} disabled={running}>{t('bench.selProse')}</button>
                <button className="btn sm" onClick={() => setSel(catalog.cases.filter((c) => QUICK_IDS.includes(c.id)).map((c) => c.id))} disabled={running}>{t('bench.selQuick')}</button>
                <button className="btn sm" onClick={() => setSel([])} disabled={running}>{t('bench.selNone')}</button>
              </div>
              <div className="bench-opts">
                <label className="bench-opt">
                  <span>{t('bench.dialogueTurns', { n: dialogueTurns })}</span>
                  <input type="range" min={2} max={12} step={1} value={dialogueTurns} onChange={(e) => setDialogueTurns(Number(e.target.value))} disabled={running} />
                </label>
                <label className="bench-opt bench-opt-check" title={t('bench.llmPlayerTitle')}>
                  <input type="checkbox" checked={llmPlayer} onChange={(e) => setLlmPlayer(e.target.checked)} disabled={running} />
                  <span>{t('bench.llmPlayer')}</span>
                </label>
              </div>
            </div>
            <div className="bench-console-foot">
              <input className="bench-label-input" placeholder={t('bench.labelPlaceholder')} maxLength={80} value={label} onChange={(e) => setLabel(e.target.value.slice(0, 80))} disabled={running} />
              {running ? (
                <button className="btn danger" onClick={cancel}>{t('bench.cancel')}</button>
              ) : (
                <button className="btn primary" onClick={run} disabled={selectedCount === 0}>
                  <Icon name="play" size={15} /> {t('bench.runCases', { count: selectedCount })}
                </button>
              )}
              {doneCount > 0 && !running && (
                <button className="btn" onClick={save}>
                  <Icon name="save" size={15} /> {t('bench.saveRun')}
                </button>
              )}
            </div>
            {running && (
              <div className="bench-progress">
                <div className="bench-progress-track">
                  <div className="bench-progress-fill" style={{ width: `${(doneCount / Math.max(1, selectedCount)) * 100}%` }} />
                </div>
                <span className="muted mono">{t('bench.doneOf', { done: doneCount, total: selectedCount })}</span>
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
                    <div className="kicker">{t('bench.nCases', { count: cases.length })}</div>
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
                    {t('bench.toggleGroup')}
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
