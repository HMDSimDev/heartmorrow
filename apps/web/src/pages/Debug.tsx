import { useEffect, useRef, useState } from 'react';
import type { Character, GameEvent, PromptEstimateResult } from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { Banner, Field } from '../components/ui';
import './creator.page.css';

const CONTEXT_WINDOW_KEY = 'dsim.debug.contextWindow';

export function Debug() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [previewId, setPreviewId] = useState('');
  const [preview, setPreview] = useState<string>();
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);

  // Prompt size estimator
  const [estCharId, setEstCharId] = useState('');
  const [estLive, setEstLive] = useState(true);
  const [estFull, setEstFull] = useState(false);
  const [contextWindow, setContextWindow] = useState<number>(() => {
    const v = Number(localStorage.getItem(CONTEXT_WINDOW_KEY));
    return Number.isFinite(v) && v > 0 ? v : 8192;
  });
  const [estimate, setEstimate] = useState<PromptEstimateResult | null>(null);
  const [estimating, setEstimating] = useState(false);

  const setCtxWindow = (v: number) => {
    setContextWindow(v);
    localStorage.setItem(CONTEXT_WINDOW_KEY, String(v));
  };

  const runEstimate = async () => {
    setEstimating(true);
    setError(undefined);
    try {
      setEstimate(await api.estimatePrompts({ characterId: estCharId || null, live: estLive, simulateFull: estFull }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setEstimating(false);
    }
  };

  const loadEvents = async () => {
    try {
      setEvents(await api.listEvents());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void api.listCharacters().then(setCharacters).catch(() => undefined);
    void loadEvents();
  }, []);

  const showPreview = async () => {
    if (!previewId) return;
    try {
      const p = await api.promptPreview(previewId);
      setPreview(`~${p.approxChars} chars\n\n${p.system}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const exportData = async () => {
    try {
      const bundle = await api.exportData();
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'dsim-export.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const importData = async (file: File) => {
    setError(undefined);
    setNote(undefined);
    try {
      const text = await file.text();
      await api.importData(JSON.parse(text));
      setNote('Import complete. Reload the app to see changes everywhere.');
      await loadEvents();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="stack">
      <div className="framed creator-head">
        <div className="creator-head-titles">
          <div className="creator-meta">
            <span className="kicker">Creator console</span>
            <span className="creator-tool-tag">diagnostics</span>
          </div>
          <h1>Debug</h1>
          <p>Inspect assembled prompts, recent game events, and import/export your local data.</p>
        </div>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {note && <Banner kind="ok">{note}</Banner>}

      <div className="card">
        <div className="creator-sec">
          <span className="creator-index">01</span>
          <h2>Prompt preview</h2>
          <span className="trail" />
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="flex-fill">
            <Field label="Character">
              <select value={previewId} onChange={(e) => setPreviewId(e.target.value)}>
                <option value="">— Choose —</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button className="btn" onClick={showPreview} disabled={!previewId}>
            Build prompt
          </button>
        </div>
        {preview && <pre className="pre">{preview}</pre>}
      </div>

      <div className="card">
        <div className="creator-sec">
          <span className="creator-index">02</span>
          <h2>Prompt size estimator</h2>
          <span className="trail" />
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Builds the <strong>real</strong> prompt for each common interaction and counts its tokens, so you can see how
          close each one runs to your model's context window. With <em>measure live</em> on, counts are your model's exact{' '}
          <code>usage.prompt_tokens</code>; otherwise they're a rough chars/4 estimate.
        </p>
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
          <div className="flex-fill">
            <Field label="Character (data source)" hint="Whose real world/relationship/history is used to assemble the prompts.">
              <select value={estCharId} onChange={(e) => setEstCharId(e.target.value)}>
                <option value="">— Auto (first character) —</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Context window (tokens)" hint="Your model's loaded context length. Rows whose prompt + reply exceed it are flagged.">
            <input type="number" min={512} step={512} value={contextWindow} onChange={(e) => setCtxWindow(Number(e.target.value))} />
          </Field>
        </div>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={estLive} onChange={(e) => setEstLive(e.target.checked)} />
            <span>Measure live (exact tokens — needs the endpoint up)</span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={estFull} onChange={(e) => setEstFull(e.target.checked)} />
            <span>Simulate a full conversation (worst case)</span>
          </label>
          <button className="btn primary" onClick={runEstimate} disabled={estimating}>
            {estimating ? 'Measuring…' : 'Estimate prompt sizes'}
          </button>
        </div>

        {estimate && (
          <div style={{ marginTop: 14 }}>
            {estimate.error && (
              <div className="creator-callout" style={{ marginBottom: 12 }}>
                <span className="creator-callout-mark">!</span>
                <span>{estimate.error}</span>
              </div>
            )}
            <p className="muted" style={{ margin: '0 0 8px' }}>
              Model <strong>{estimate.model}</strong>
              {estimate.characterName ? <> · character <strong>{estimate.characterName}</strong></> : null} ·{' '}
              {estimate.live ? 'exact token counts' : 'estimated token counts'}
              {estimate.simulateFull ? ' · full-window simulation' : ''} · context window{' '}
              {contextWindow.toLocaleString()} tokens
            </p>
            {estimate.estimates.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                      <th style={{ padding: '6px 8px' }}>Interaction</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Msgs</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Chars</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Prompt</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>+ Reply</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Total</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Fits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {estimate.estimates.map((e) => {
                      const total = e.promptTokens + e.maxResponseTokens;
                      const fits = total <= contextWindow;
                      return (
                        <tr key={e.key} style={{ borderTop: '1px solid var(--line, rgba(255,255,255,0.08))' }}>
                          <td style={{ padding: '6px 8px' }}>
                            <div>{e.label}</div>
                            <div className="muted" style={{ fontSize: '0.72rem' }}>{e.description}</div>
                            {e.note && (
                              <div className="muted" style={{ fontSize: '0.72rem', opacity: 0.8 }}>{e.note}</div>
                            )}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>{e.messageCount}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>{e.chars.toLocaleString()}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {e.promptTokens.toLocaleString()}{' '}
                            <span className="badge" title={e.method === 'exact' ? "model's usage.prompt_tokens" : 'chars / 4'}>
                              {e.method}
                            </span>
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>+{e.maxResponseTokens.toLocaleString()}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>{total.toLocaleString()}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                            <span className={`badge ${fits ? 'good' : 'danger'}`}>{fits ? 'fits' : 'exceeds'}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted" style={{ fontSize: '0.72rem', marginTop: 8 }}>
              <strong>Total</strong> = prompt tokens + the reply budget (your <em>Max tokens</em> setting). If Total exceeds the
              context window, the model will truncate the oldest context (or fail) during that interaction.
            </p>
          </div>
        )}
      </div>

      <div className="card">
        <div className="creator-sec">
          <span className="creator-index">03</span>
          <h2>Local data</h2>
          <span className="trail" />
        </div>
        <div className="creator-data-actions">
          <button className="btn" onClick={exportData}>
            ⬇ Export JSON
          </button>
          <label className="btn">
            ⬆ Import JSON
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importData(f);
              }}
            />
          </label>
        </div>
        <div className="creator-callout" style={{ marginTop: 12 }}>
          <span className="creator-callout-mark">!</span>
          <span>Import replaces all local game data with the file's contents.</span>
        </div>
      </div>

      <div className="card">
        <div className="creator-sec">
          <span className="creator-index">04</span>
          <h2>Recent events</h2>
          <span className="trail" />
          <button className="btn sm ghost creator-sec-action" onClick={loadEvents}>
            Refresh
          </button>
        </div>
        {events.length === 0 ? (
          <p className="muted">No events yet.</p>
        ) : (
          events.slice(0, 60).map((e) => (
            <div className="list-item" key={e.id}>
              <span className="badge creator-event-type">{e.type}</span>
              <span className="flex-fill truncate dim" style={{ fontSize: '0.8rem' }}>
                {JSON.stringify(e.payload)}
              </span>
              <small className="creator-event-time">{new Date(e.createdAt).toLocaleTimeString()}</small>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
