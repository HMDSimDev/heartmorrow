import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { PromptCatalogEntry, PromptCategory } from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { Banner, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import './prompt-editor.page.css';

/** Category display order (left-hand list sectioning). */
const CATEGORY_ORDER: PromptCategory[] = ['roleplay', 'judge', 'phone', 'social', 'memory', 'creator', 'safety'];

/** sessionStorage handoff so "Preview in Bench" carries the (possibly unsaved) edit. */
export const PROMPT_PREVIEW_KEY = 'dsim.promptPreview';

/**
 * The local Prompt Editor: edit any system prompt / guardrail the game sends to the
 * model. Overrides are saved to the server's global `prompt_overrides` store (never
 * bundled into world/character share files). Two-panel: a categorized list on the
 * left, the editor on the right with the shipped default available for reference and
 * a "Preview in Bench" handoff to test an edit before committing it.
 */
export function PromptEditor() {
  const { t } = useTranslation(['pages', 'common']);
  const { advancedMode } = useAppData();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<PromptCatalogEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [showDefault, setShowDefault] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.listPrompts();
        if (cancelled) return;
        setEntries(res.entries);
        const first = res.entries[0];
        if (first) {
          setSelectedId(first.id);
          setDraft(first.currentText);
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = useMemo(() => entries?.find((e) => e.id === selectedId) ?? null, [entries, selectedId]);

  // Required `{{tokens}}` the override has dropped — Save is blocked until they return.
  const missing = useMemo(
    () => (selected ? selected.requiredTokens.filter((tok) => !draft.includes(`{{${tok}}}`)) : []),
    [selected, draft],
  );
  const dirty = selected ? draft !== selected.currentText : false;

  const pick = (e: PromptCatalogEntry) => {
    setSelectedId(e.id);
    setDraft(e.currentText);
    setShowDefault(false);
    setError(undefined);
    setNote(undefined);
  };

  const replaceEntry = (updated: PromptCatalogEntry) =>
    setEntries((es) => (es ? es.map((e) => (e.id === updated.id ? updated : e)) : es));

  const save = async () => {
    if (!selected || missing.length > 0) return;
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const updated = await api.savePromptOverride(selected.id, draft);
      replaceEntry(updated);
      setDraft(updated.currentText);
      setNote(t('settings.prompts.saved'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const updated = await api.resetPromptOverride(selected.id);
      replaceEntry(updated);
      setDraft(updated.currentText);
      setNote(t('settings.prompts.resetDone'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const previewInBench = () => {
    if (!selected) return;
    sessionStorage.setItem(PROMPT_PREVIEW_KEY, JSON.stringify({ [selected.id]: draft }));
    navigate('/bench');
  };

  const groups = useMemo(() => {
    const m = new Map<PromptCategory, PromptCatalogEntry[]>();
    for (const e of entries ?? []) {
      const arr = m.get(e.category) ?? [];
      arr.push(e);
      m.set(e.category, arr);
    }
    return CATEGORY_ORDER.filter((c) => m.has(c)).map((c) => ({ category: c, items: m.get(c)! }));
  }, [entries]);

  if (!entries) return <Spinner />;

  return (
    <div className="stack pe-page">
      <div className="page-head">
        <div className="kicker">{t('settings.prompts.page.kicker')}</div>
        <h1>{t('settings.prompts.page.title')}</h1>
        <p>{t('settings.prompts.page.blurb')}</p>
      </div>

      {!advancedMode && <Banner kind="info">{t('settings.prompts.enableAdvanced')}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      {note && <Banner kind="ok">{note}</Banner>}

      <div className="pe-layout">
        <aside className="pe-list">
          {groups.map((g) => (
            <div key={g.category} className="pe-group">
              <div className="pe-group-head">{t(`settings.prompts.categories.${g.category}`)}</div>
              {g.items.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`pe-row ${e.id === selectedId ? 'active' : ''}`}
                  onClick={() => pick(e)}
                >
                  <span className="pe-row-label">{e.label}</span>
                  {e.isOverridden && (
                    <span className="pe-dot" title={t('settings.prompts.editedBadge')} aria-label={t('settings.prompts.editedBadge')} />
                  )}
                </button>
              ))}
            </div>
          ))}
        </aside>

        <section className="pe-editor framed">
          {selected ? (
            <>
              <div className="pe-editor-head">
                <div className="pe-editor-titles">
                  <h2>{selected.label}</h2>
                  <p className="hint">{selected.purpose}</p>
                </div>
                <span className={`badge ${selected.isOverridden ? 'warn' : 'good'}`}>
                  {selected.isOverridden ? t('settings.prompts.custom') : t('settings.prompts.default')}
                </span>
              </div>

              {selected.safety && <Banner kind="error">{t('settings.prompts.safetyWarn')}</Banner>}

              {selected.requiredTokens.length > 0 && (
                <div className="pe-tokens">
                  <span className="pe-tokens-label">{t('settings.prompts.requiredTokens')}</span>
                  {selected.requiredTokens.map((tok) => (
                    <code key={tok} className={`pe-token ${missing.includes(tok) ? 'missing' : ''}`}>{`{{${tok}}}`}</code>
                  ))}
                </div>
              )}

              <textarea
                className="pe-textarea"
                value={draft}
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="pe-meta">{t('settings.prompts.charCount', { count: draft.length })}</div>

              {missing.length > 0 && (
                <Banner kind="error">
                  {t('settings.prompts.missingTokens', { tokens: missing.map((x) => `{{${x}}}`).join(', ') })}
                </Banner>
              )}

              <div className="pe-actions">
                <button className="btn primary" onClick={save} disabled={busy || !dirty || missing.length > 0}>
                  {busy ? t('settings.prompts.saving') : t('settings.prompts.save')}
                </button>
                <button className="btn" onClick={previewInBench} disabled={busy}>
                  <Icon name="refresh" size={14} /> {t('settings.prompts.previewInBench')}
                </button>
                {selected.isOverridden && (
                  <button className="btn danger" onClick={reset} disabled={busy}>
                    {t('settings.prompts.reset')}
                  </button>
                )}
                <button className="btn ghost" type="button" onClick={() => setShowDefault((s) => !s)}>
                  {showDefault ? t('settings.prompts.hideDefault') : t('settings.prompts.showDefault')}
                </button>
              </div>

              {showDefault && (
                <div className="pe-default">
                  <div className="pe-default-head">{t('settings.prompts.defaultPanelLabel')}</div>
                  <pre className="pe-default-text">{selected.defaultText}</pre>
                </div>
              )}
            </>
          ) : (
            <p className="hint">{t('settings.prompts.selectHint')}</p>
          )}
        </section>
      </div>

      <div className="row">
        <Link className="btn ghost" to="/settings">
          <Icon name="settings" size={14} /> {t('settings.prompts.backToSettings')}
        </Link>
      </div>
    </div>
  );
}
