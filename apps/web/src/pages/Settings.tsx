import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  GENDER_LABELS,
  SEXUALITY_LABELS,
  type Gender,
  type Sexuality,
  type LlmHealthResult,
  type StructuredOutputMode,
  type EndpointMode,
} from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { Banner, Field, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { CrisisResources } from '../components/CrisisResources';
import './settings.page.css';

interface Form {
  baseUrl: string;
  apiKey: string;
  model: string;
  visionModel: string;
  temperature: number;
  maxTokens: number;
  topP: number | null;
  topK: number | null;
  minP: number | null;
  frequencyPenalty: number | null;
  presencePenalty: number | null;
  repeatPenalty: number | null;
  structuredMode: StructuredOutputMode;
  omitSchemaInPrompt: boolean;
  endpointMode: EndpointMode;
  maxRetries: number;
  nsfwEnabled: boolean;
  rapportCadence: 'every' | 'periodic';
  tragicOutcomesEnabled: boolean;
}

interface PlayerForm {
  name: string;
  pronouns: string;
  gender: Gender;
  sexuality: Sexuality;
  personaNotes: string;
}

export function Settings() {
  const { reloadPlayer, creatorMode, setCreatorMode, activeWorldId } = useAppData();
  const [player, setPlayer] = useState<PlayerForm | null>(null);
  const [playerSaved, setPlayerSaved] = useState(false);
  const [playerSaving, setPlayerSaving] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [health, setHealth] = useState<LlmHealthResult | null>(null);
  const [error, setError] = useState<string>();
  const [savedNote, setSavedNote] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [nsfwModalOpen, setNsfwModalOpen] = useState(false);
  const [ackContent, setAckContent] = useState(false);
  const [ackAge, setAckAge] = useState(false);
  const [nsfwSaving, setNsfwSaving] = useState(false);
  const [tragicModalOpen, setTragicModalOpen] = useState(false);
  const [ackTragic, setAckTragic] = useState(false);
  const [tragicSaving, setTragicSaving] = useState(false);

  useEffect(() => {
    // A `cancelled` flag drops a superseded world's persona so a slow
    // getPlayer(A) can't overwrite (and then be saved over) getPlayer(B).
    let cancelled = false;
    void (async () => {
      try {
        const p = await api.getPlayer(activeWorldId ?? undefined);
        if (cancelled) return;
        setPlayer({ name: p.name, pronouns: p.pronouns, gender: p.gender, sexuality: p.sexuality, personaNotes: p.personaNotes });
      } catch {
        /* ignore */
      }
    })();
    void (async () => {
      try {
        const s = await api.getSettings();
        if (cancelled) return;
        setApiKeySet(s.apiKeySet);
        setForm({
          baseUrl: s.baseUrl,
          apiKey: '',
          model: s.model,
          visionModel: s.visionModel,
          temperature: s.temperature,
          maxTokens: s.maxTokens,
          topP: s.topP,
          topK: s.topK,
          minP: s.minP,
          frequencyPenalty: s.frequencyPenalty,
          presencePenalty: s.presencePenalty,
          repeatPenalty: s.repeatPenalty,
          structuredMode: s.structuredMode,
          omitSchemaInPrompt: s.omitSchemaInPrompt,
          endpointMode: s.endpointMode,
          maxRetries: s.maxRetries,
          nsfwEnabled: s.nsfwEnabled,
          rapportCadence: s.rapportCadence,
          tragicOutcomesEnabled: s.tragicOutcomesEnabled,
        });
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeWorldId]);

  if (!form) return <Spinner />;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  // Nullable sampling inputs: blank → null (field omitted from the request);
  // any other value parses to a number (NaN guarded so partial typing is kept null).
  const setNullable = (k: 'topP' | 'topK' | 'minP' | 'frequencyPenalty' | 'presencePenalty' | 'repeatPenalty', raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') return set(k, null);
    const n = Number(trimmed);
    set(k, Number.isFinite(n) ? n : null);
  };

  const buildUpdate = () => {
    const update: Record<string, unknown> = {
      baseUrl: form.baseUrl,
      model: form.model,
      visionModel: form.visionModel,
      temperature: form.temperature,
      maxTokens: form.maxTokens,
      topP: form.topP,
      topK: form.topK,
      minP: form.minP,
      frequencyPenalty: form.frequencyPenalty,
      presencePenalty: form.presencePenalty,
      repeatPenalty: form.repeatPenalty,
      structuredMode: form.structuredMode,
      omitSchemaInPrompt: form.omitSchemaInPrompt,
      endpointMode: form.endpointMode,
      maxRetries: form.maxRetries,
      nsfwEnabled: form.nsfwEnabled,
      rapportCadence: form.rapportCadence,
      tragicOutcomesEnabled: form.tragicOutcomesEnabled,
    };
    if (form.apiKey) update.apiKey = form.apiKey;
    return update;
  };

  const save = async () => {
    setSaving(true);
    setSavedNote(undefined);
    setError(undefined);
    try {
      const s = await api.updateSettings(buildUpdate());
      setApiKeySet(s.apiKeySet);
      setForm((f) => (f ? { ...f, apiKey: '' } : f));
      setSavedNote('Settings saved.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  // Persist the NSFW toggle on its own (a minimal PATCH) so enabling/disabling is
  // atomic with the acknowledgment and never depends on the main Save button.
  const persistNsfw = async (enabled: boolean): Promise<boolean> => {
    setNsfwSaving(true);
    setError(undefined);
    try {
      const s = await api.updateSettings({ nsfwEnabled: enabled });
      setApiKeySet(s.apiKeySet);
      setForm((f) => (f ? { ...f, nsfwEnabled: s.nsfwEnabled } : f));
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setNsfwSaving(false);
    }
  };

  const closeNsfwModal = () => {
    setNsfwModalOpen(false);
    setAckContent(false);
    setAckAge(false);
  };

  // Only close (and clear the acknowledgments) when the server actually accepted
  // the change — on failure keep the modal open with both boxes still checked.
  const confirmEnableNsfw = async () => {
    if (await persistNsfw(true)) closeNsfwModal();
  };

  // The dark "tragic outcomes" subtoggle persists on its own, atomically.
  const persistTragic = async (enabled: boolean): Promise<boolean> => {
    setTragicSaving(true);
    setError(undefined);
    try {
      const s = await api.updateSettings({ tragicOutcomesEnabled: enabled });
      setForm((f) => (f ? { ...f, tragicOutcomesEnabled: s.tragicOutcomesEnabled } : f));
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setTragicSaving(false);
    }
  };
  const closeTragicModal = () => {
    setTragicModalOpen(false);
    setAckTragic(false);
  };
  const confirmEnableTragic = async () => {
    if (await persistTragic(true)) closeTragicModal();
  };

  const savePlayer = async () => {
    if (!player) return;
    setPlayerSaving(true);
    setPlayerSaved(false);
    setError(undefined);
    try {
      await api.updatePlayer(player, activeWorldId ?? undefined);
      await reloadPlayer();
      setPlayerSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPlayerSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setHealth(null);
    setError(undefined);
    try {
      setHealth(await api.testLlm(buildUpdate()));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  const loadModels = async () => {
    if (loadingModels) return;
    setLoadingModels(true);
    setError(undefined);
    setSavedNote(undefined);
    try {
      // Use the values currently typed into the form (like Test connection) so the
      // user doesn't have to Save first to list against a freshly-entered endpoint.
      const res = await api.listModels(buildUpdate());
      setModels(res.models);
      if (!res.ok && res.error) {
        setError(res.error);
      } else if (res.models.length === 0) {
        setSavedNote('Connected, but the endpoint returned no models.');
      } else {
        setSavedNote(`Loaded ${res.models.length} model${res.models.length === 1 ? '' : 's'} — pick one in the Model field.`);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <div className="stack set-page">
      <div className="page-head">
        <div className="kicker">The control desk</div>
        <h1>Settings</h1>
        <p>
          Configure your local OpenAI-compatible endpoint (LM Studio, Ollama, llama.cpp, …). The browser never calls
          the model directly — the local server does.
        </p>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {savedNote && <Banner kind="ok">{savedNote}</Banner>}

      <div className="card set-section">
        <div className="section-head">
          <div className="titles">
            <div className="kicker">How you play</div>
            <h2>Mode</h2>
          </div>
          <div className="trail" />
        </div>
        <p className="set-lede">
          <strong>Play mode</strong> hides creation/editing tools (no deleting characters mid-game).{' '}
          <strong>Creator mode</strong> shows them. Also in Phone → Settings.
        </p>
        <div className="set-choice">
          <button className={`btn sm ${!creatorMode ? 'primary' : ''}`} onClick={() => setCreatorMode(false)}>
            <Icon name="play" size={14} /> Play mode
          </button>
          <button className={`btn sm ${creatorMode ? 'primary' : ''}`} onClick={() => setCreatorMode(true)}>
            <Icon name="edit" size={14} /> Creator mode
          </button>
        </div>
      </div>

      <div className="card set-section">
        <div className="section-head">
          <div className="titles">
            <div className="kicker">Maturity</div>
            <h2>Adult content (NSFW)</h2>
          </div>
          <div className="trail" />
        </div>
        <p className="set-lede">
          When enabled, the model may generate mature/explicit content during dates — but only once your relationship
          with a character is advanced enough. Propositioning a stranger or acquaintance will still make them walk out.
        </p>
        <div className="set-status-line">
          {form.nsfwEnabled ? (
            <>
              <span className="badge warn">Adult content ON</span>
              <button className="btn sm" onClick={() => persistNsfw(false)} disabled={nsfwSaving}>
                {nsfwSaving ? 'Saving…' : 'Disable'}
              </button>
            </>
          ) : (
            <>
              <span className="badge">Off</span>
              <button className="btn sm danger" onClick={() => setNsfwModalOpen(true)} disabled={nsfwSaving}>
                Enable adult content…
              </button>
            </>
          )}
        </div>
        <p className="hint" style={{ marginBottom: 0, marginTop: 12 }}>
          Best paired with an abliterated / “uncensored” model. A censored or safety-tuned model may still refuse
          explicit content even with this toggle on.
        </p>

        {form.nsfwEnabled && (
          <div className="set-subtoggle">
            <div className="kicker">Heavy themes</div>
            <h3 style={{ margin: '4px 0 6px' }}>Tragic outcomes (self-harm)</h3>
            <p className="set-lede" style={{ marginTop: 0 }}>
              When enabled, sustained, severe mistreatment of someone who loved you (repeated heartbreak, cheating,
              cruelty) can spiral — with many clear warnings and chances to stop — into a character taking their own
              life, permanently memorializing them. The act is never depicted. Leaving them be or treating them kindly
              always pulls them back. Off by default.
            </p>
            <div className="set-status-line">
              {form.tragicOutcomesEnabled ? (
                <>
                  <span className="badge danger">Tragic outcomes ON</span>
                  <button className="btn sm" onClick={() => persistTragic(false)} disabled={tragicSaving}>
                    {tragicSaving ? 'Saving…' : 'Disable'}
                  </button>
                </>
              ) : (
                <>
                  <span className="badge">Off</span>
                  <button className="btn sm danger" onClick={() => setTragicModalOpen(true)} disabled={tragicSaving}>
                    Enable tragic outcomes…
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <Link to="/bench" className="set-bench-card framed">
        <div className="set-bench-mark" aria-hidden="true">
          <Icon name="refresh" size={22} />
        </div>
        <div className="set-bench-body">
          <div className="kicker">Diagnostics</div>
          <h2>Heartmorrow Bench</h2>
          <p>
            Benchmark how your model handles the real prompts this game runs — the rapport judges, date evaluator, and
            generators — against a fixed sample. Score the judges against your own baseline, watch a date play out, and
            track tokens, latency, and tokens/sec. Save runs to compare models.
          </p>
        </div>
        <div className="set-bench-go">
          Open <Icon name="date" size={15} />
        </div>
      </Link>

      {player && (
        <div className="card set-section">
          <div className="section-head">
            <div className="titles">
              <div className="kicker">Who you are</div>
              <h2>Your persona</h2>
            </div>
            <div className="trail" />
          </div>
          <p className="set-lede">
            How characters see you — your name, pronouns, and notes are shared with everyone you meet.
          </p>
          <div className="inline-fields">
            <Field label="Your name">
              <input value={player.name} onChange={(e) => setPlayer({ ...player, name: e.target.value })} />
            </Field>
            <Field label="Your pronouns">
              <input value={player.pronouns} onChange={(e) => setPlayer({ ...player, pronouns: e.target.value })} />
            </Field>
          </div>
          <div className="inline-fields">
            <Field label="Your gender" hint="Separate from pronouns.">
              <select value={player.gender} onChange={(e) => setPlayer({ ...player, gender: e.target.value as Gender })}>
                {Object.entries(GENDER_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Your sexuality" hint="Decides which characters a romance can deepen with.">
              <select
                value={player.sexuality}
                onChange={(e) => setPlayer({ ...player, sexuality: e.target.value as Sexuality })}
              >
                {Object.entries(SEXUALITY_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Persona notes" hint="Optional — anything you want characters to know about you.">
            <textarea
              value={player.personaNotes}
              onChange={(e) => setPlayer({ ...player, personaNotes: e.target.value })}
            />
          </Field>
          <div className="row">
            <button className="btn primary" onClick={savePlayer} disabled={playerSaving}>
              {playerSaving ? 'Saving…' : 'Save persona'}
            </button>
            {playerSaved && <span className="badge good">Saved ✓</span>}
          </div>
        </div>
      )}

      {/* Signature element: the connection console — the technical heart of the
          page, presented as a chamfered instrument panel. */}
      <div className="framed set-console">
        <div className="set-console-head">
          <div>
            <div className="set-console-sub">Local model link</div>
            <div className="set-console-title">Connection console</div>
          </div>
          <span className="set-console-dot">{form.baseUrl ? 'Endpoint set' : 'No endpoint'}</span>
        </div>

        <div className="set-console-grid">
          <div className="set-console-col">
            <div className="set-col-label">Connection</div>
            <Field label="Base URL" hint="e.g. http://localhost:1234/v1">
              <input value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
            </Field>
            <Field label="API key" hint={apiKeySet ? 'A key is set. Leave blank to keep it.' : 'Optional for local servers.'}>
              <input
                type="password"
                placeholder={apiKeySet ? '•••••••• (unchanged)' : 'optional'}
                value={form.apiKey}
                onChange={(e) => set('apiKey', e.target.value)}
              />
            </Field>
            <Field label="Model" hint="Type any model name, or pick from the loaded list below.">
              <input value={form.model} onChange={(e) => set('model', e.target.value)} list="model-list" />
              {models.length > 0 && (
                <select
                  className="set-model-picker"
                  value={models.includes(form.model) ? form.model : ''}
                  onChange={(e) => e.target.value && set('model', e.target.value)}
                >
                  <option value="">{`Pick from ${models.length} loaded model${models.length === 1 ? '' : 's'}…`}</option>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
              <datalist id="model-list">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            <Field
              label="Vision model"
              hint="Optional - used for image-based generation (e.g. drafting a character from a portrait or for a character to respond to an image text). Leave blank to reuse the model above."
            >
              <input
                value={form.visionModel}
                onChange={(e) => set('visionModel', e.target.value)}
                list="model-list"
                placeholder="(same as model)"
              />
              {models.length > 0 && (
                <select
                  className="set-model-picker"
                  value={models.includes(form.visionModel) ? form.visionModel : ''}
                  onChange={(e) => e.target.value && set('visionModel', e.target.value)}
                >
                  <option value="">Pick a loaded model…</option>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <button className="btn sm" onClick={loadModels} disabled={loadingModels}>
              {loadingModels ? 'Loading…' : 'Load models from /v1/models'}
            </button>
          </div>

          <div className="set-console-col">
            <div className="set-col-label">Generation</div>
            <Field label={`Temperature: ${form.temperature}`}>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={form.temperature}
                onChange={(e) => set('temperature', Number(e.target.value))}
              />
            </Field>
            <Field label="Max tokens">
              <input type="number" value={form.maxTokens} onChange={(e) => set('maxTokens', Number(e.target.value))} />
            </Field>
            <Field
              label="Advanced sampling"
              hint="Optional. Leave a field blank to let the endpoint use its own default. top_k / min_p / repeat penalty are honored by llama.cpp, LM Studio, Ollama, and vLLM but ignored or rejected by the official OpenAI API."
            >
              <div className="set-sampling-grid">
                <label className="set-sampling-cell">
                  <span>Top P</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    placeholder="default"
                    value={form.topP ?? ''}
                    onChange={(e) => setNullable('topP', e.target.value)}
                  />
                </label>
                <label className="set-sampling-cell">
                  <span>Top K</span>
                  <input
                    type="number"
                    min={0}
                    max={500}
                    step={1}
                    placeholder="default"
                    value={form.topK ?? ''}
                    onChange={(e) => setNullable('topK', e.target.value)}
                  />
                </label>
                <label className="set-sampling-cell">
                  <span>Min P</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    placeholder="default"
                    value={form.minP ?? ''}
                    onChange={(e) => setNullable('minP', e.target.value)}
                  />
                </label>
                <label className="set-sampling-cell">
                  <span>Frequency penalty</span>
                  <input
                    type="number"
                    min={-2}
                    max={2}
                    step={0.1}
                    placeholder="default"
                    value={form.frequencyPenalty ?? ''}
                    onChange={(e) => setNullable('frequencyPenalty', e.target.value)}
                  />
                </label>
                <label className="set-sampling-cell">
                  <span>Presence penalty</span>
                  <input
                    type="number"
                    min={-2}
                    max={2}
                    step={0.1}
                    placeholder="default"
                    value={form.presencePenalty ?? ''}
                    onChange={(e) => setNullable('presencePenalty', e.target.value)}
                  />
                </label>
                <label className="set-sampling-cell">
                  <span>Repeat penalty</span>
                  <input
                    type="number"
                    min={0}
                    max={2}
                    step={0.05}
                    placeholder="default"
                    value={form.repeatPenalty ?? ''}
                    onChange={(e) => setNullable('repeatPenalty', e.target.value)}
                  />
                </label>
              </div>
            </Field>
            <Field label="Structured output mode" hint="json_object works with most local servers.">
              <select value={form.structuredMode} onChange={(e) => set('structuredMode', e.target.value as StructuredOutputMode)}>
                <option value="json_schema">json_schema</option>
                <option value="json_object">json_object</option>
                <option value="prompt_only">prompt_only</option>
              </select>
            </Field>
            <Field
              label="Drop schema from prompt"
              hint="Perf test for json_schema mode only: the grammar already enforces the shape, so the duplicated schema text in the prompt is redundant. Skipping it shrinks the prompt (faster prefill). No effect in json_object / prompt_only."
            >
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={form.omitSchemaInPrompt}
                  onChange={(e) => set('omitSchemaInPrompt', e.target.checked)}
                />
                <span>Skip the duplicate schema text (json_schema mode)</span>
              </label>
            </Field>
            <Field label="Endpoint mode" hint="responses is reserved for future use.">
              <select value={form.endpointMode} onChange={(e) => set('endpointMode', e.target.value as EndpointMode)}>
                <option value="chat_completions">chat_completions</option>
                <option value="responses">responses</option>
              </select>
            </Field>
            <Field label="Structured retry limit" hint="Retries after a malformed/invalid structured response.">
              <input type="number" min={0} max={10} value={form.maxRetries} onChange={(e) => set('maxRetries', Number(e.target.value))} />
            </Field>
            <Field
              label="Live date feedback"
              hint="How often a date reads how your last message landed (updates the vibe + their expression). 'Every message' is most responsive; 'periodic' keeps replies snappier with one fewer model call per turn."
            >
              <select value={form.rapportCadence} onChange={(e) => set('rapportCadence', e.target.value as 'every' | 'periodic')}>
                <option value="every">Every message</option>
                <option value="periodic">Periodically (lighter)</option>
              </select>
            </Field>
          </div>
        </div>

        <div className="set-console-foot">
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          <button className="btn" onClick={test} disabled={testing}>
            {testing ? 'Testing…' : <><Icon name="refresh" size={15} /> Test connection</>}
          </button>
        </div>
      </div>

      {health && (
        <Banner kind={health.ok ? 'ok' : 'error'}>
          <strong>{health.ok ? 'Connected!' : 'Failed.'}</strong> {health.message}
          {health.latencyMs !== undefined && <> · {health.latencyMs}ms</>}
          {health.sample && (
            <>
              <br />
              Sample reply: <em>{health.sample}</em>
            </>
          )}
          {health.models && health.models.length > 0 && (
            <>
              <br />
              Models: {health.models.slice(0, 8).join(', ')}
            </>
          )}
        </Banner>
      )}

      {nsfwModalOpen &&
        createPortal(
          <div className="modal-overlay" onClick={closeNsfwModal}>
            <div className="modal card" onClick={(e) => e.stopPropagation()}>
              <div className="kicker">Please confirm</div>
              <h2 style={{ marginTop: 0 }}>Enable adult (NSFW) content</h2>
              <p className="hint" style={{ marginTop: 0 }}>
                This is a private, local, single-user game. Content is generated by your own local model and never
                leaves your machine. To continue, please confirm both of the following:
              </p>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: '12px 0', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={ackContent}
                  onChange={(e) => setAckContent(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  I understand that with adult content enabled, the local model may generate explicit, sexual, or
                  otherwise inappropriate material, and that DSim does not filter or guarantee its output.
                </span>
              </label>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: '12px 0', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={ackAge}
                  onChange={(e) => setAckAge(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>I affirm that I am of legal age to view adult content in my jurisdiction.</span>
              </label>
              <p className="hint">
                Best paired with an abliterated / “uncensored” model — a censored model may still refuse even with this
                on. Adult content is only ever generated once your relationship with a character is advanced enough;
                propositioning a stranger or acquaintance will still make them walk out.
              </p>
              {error && <Banner kind="error">{error}</Banner>}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn ghost" onClick={closeNsfwModal} disabled={nsfwSaving}>
                  Cancel
                </button>
                <button
                  className="btn danger"
                  disabled={!(ackContent && ackAge) || nsfwSaving}
                  onClick={confirmEnableNsfw}
                >
                  {nsfwSaving ? 'Enabling…' : 'Enable adult content'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {tragicModalOpen &&
        createPortal(
          <div className="modal-overlay" onClick={closeTragicModal}>
            <div className="modal card" onClick={(e) => e.stopPropagation()}>
              <div className="kicker">Please read carefully</div>
              <h2 style={{ marginTop: 0 }}>Enable tragic outcomes</h2>
              <p className="hint" style={{ marginTop: 0 }}>
                This adds a heavy, optional consequence: if you repeatedly and severely mistreat a character who became
                deeply attached to you — and ignore the escalating warnings, including a worried friend reaching out —
                they may take their own life and be permanently memorialized. The act itself is never shown. Being kind,
                giving them space, or simply stopping always pulls them back from it.
              </p>
              <CrisisResources />
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: '12px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={ackTragic} onChange={(e) => setAckTragic(e.target.checked)} style={{ marginTop: 3 }} />
                <span>
                  I understand this content deals with suicide as a consequence of in-game abuse, and I want it enabled.
                  I can turn it off at any time.
                </span>
              </label>
              {error && <Banner kind="error">{error}</Banner>}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn ghost" onClick={closeTragicModal} disabled={tragicSaving}>
                  Cancel
                </button>
                <button className="btn danger" disabled={!ackTragic || tragicSaving} onClick={confirmEnableTragic}>
                  {tragicSaving ? 'Enabling…' : 'Enable tragic outcomes'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
