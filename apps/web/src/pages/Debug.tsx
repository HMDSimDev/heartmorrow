import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Character, GameEvent, PromptEstimateResult } from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import i18n from '../i18n';
import { Banner, Field } from '../components/ui';
import './creator.page.css';

const CONTEXT_WINDOW_KEY = 'dsim.debug.contextWindow';

export function Debug() {
  const { t } = useTranslation('pages');
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
      setNote(t('debug.importComplete'));
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
            <span className="kicker">{t('debug.console')}</span>
            <span className="creator-tool-tag">{t('debug.diagnostics')}</span>
          </div>
          <h1>{t('debug.title')}</h1>
          <p>{t('debug.intro')}</p>
        </div>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {note && <Banner kind="ok">{note}</Banner>}

      <div className="card">
        <div className="creator-sec">
          <span className="creator-index">01</span>
          <h2>{t('debug.secPromptPreview')}</h2>
          <span className="trail" />
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div className="flex-fill">
            <Field label={t('debug.character')}>
              <select value={previewId} onChange={(e) => setPreviewId(e.target.value)}>
                <option value="">{t('debug.choose')}</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <button className="btn" onClick={showPreview} disabled={!previewId}>
            {t('debug.buildPrompt')}
          </button>
        </div>
        {preview && <pre className="pre">{preview}</pre>}
      </div>

      <div className="card">
        <div className="creator-sec">
          <span className="creator-index">02</span>
          <h2>{t('debug.secEstimator')}</h2>
          <span className="trail" />
        </div>
        <p className="muted" style={{ marginTop: 0 }}>{t('debug.estimatorIntro')}</p>
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
          <div className="flex-fill">
            <Field label={t('debug.charDataSource')} hint={t('debug.charDataSourceHint')}>
              <select value={estCharId} onChange={(e) => setEstCharId(e.target.value)}>
                <option value="">{t('debug.autoFirst')}</option>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t('debug.contextWindow')} hint={t('debug.contextWindowHint')}>
            <input type="number" min={512} step={512} value={contextWindow} onChange={(e) => setCtxWindow(Number(e.target.value))} />
          </Field>
        </div>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={estLive} onChange={(e) => setEstLive(e.target.checked)} />
            <span>{t('debug.measureLive')}</span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={estFull} onChange={(e) => setEstFull(e.target.checked)} />
            <span>{t('debug.simulateFull')}</span>
          </label>
          <button className="btn primary" onClick={runEstimate} disabled={estimating}>
            {estimating ? t('debug.measuring') : t('debug.estimateSizes')}
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
              {t('debug.modelLabel')} <strong>{estimate.model}</strong>
              {estimate.characterName ? <> · {t('debug.characterLabel')} <strong>{estimate.characterName}</strong></> : null} ·{' '}
              {estimate.live ? t('debug.exactCounts') : t('debug.estimatedCounts')}
              {estimate.simulateFull ? t('debug.fullSim') : ''} ·{' '}
              {t('debug.contextWindowSuffix', { tokens: contextWindow.toLocaleString(i18n.language) })}
            </p>
            {estimate.estimates.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                      <th style={{ padding: '6px 8px' }}>{t('debug.thInteraction')}</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>{t('debug.thMsgs')}</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>{t('debug.thChars')}</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>{t('debug.thPrompt')}</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>{t('debug.thReply')}</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>{t('debug.thTotal')}</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>{t('debug.thFits')}</th>
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
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>{e.chars.toLocaleString(i18n.language)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {e.promptTokens.toLocaleString(i18n.language)}{' '}
                            <span className="badge" title={e.method === 'exact' ? t('debug.methodExactTitle') : t('debug.methodEstTitle')}>
                              {e.method}
                            </span>
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>+{e.maxResponseTokens.toLocaleString(i18n.language)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 600 }}>{total.toLocaleString(i18n.language)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                            <span className={`badge ${fits ? 'good' : 'danger'}`}>{fits ? t('debug.fits') : t('debug.exceeds')}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted" style={{ fontSize: '0.72rem', marginTop: 8 }}>{t('debug.totalNote')}</p>
          </div>
        )}
      </div>

      <div className="card">
        <div className="creator-sec">
          <span className="creator-index">03</span>
          <h2>{t('debug.secLocalData')}</h2>
          <span className="trail" />
        </div>
        <div className="creator-data-actions">
          <button className="btn" onClick={exportData}>
            {t('debug.exportJson')}
          </button>
          <label className="btn">
            {t('debug.importJson')}
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
          <span>{t('debug.importReplaces')}</span>
        </div>
      </div>

      <div className="card">
        <div className="creator-sec">
          <span className="creator-index">04</span>
          <h2>{t('debug.secRecentEvents')}</h2>
          <span className="trail" />
          <button className="btn sm ghost creator-sec-action" onClick={loadEvents}>
            {t('debug.refresh')}
          </button>
        </div>
        {events.length === 0 ? (
          <p className="muted">{t('debug.noEvents')}</p>
        ) : (
          events.slice(0, 60).map((e) => (
            <div className="list-item" key={e.id}>
              <span className="badge creator-event-type">{e.type}</span>
              <span className="flex-fill truncate dim" style={{ fontSize: '0.8rem' }}>
                {JSON.stringify(e.payload)}
              </span>
              <small className="creator-event-time">{new Date(e.createdAt).toLocaleTimeString(i18n.language)}</small>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
