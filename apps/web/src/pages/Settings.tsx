import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  GENDER_LABELS,
  SEXUALITY_LABELS,
  type Gender,
  type Sexuality,
  type LlmHealthResult,
  type LlmModelInfo,
  type StructuredOutputMode,
  type EndpointMode,
} from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { genderLabel, sexualityLabel } from '../i18n/labels';
import { Banner, Field, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { CrisisResources } from '../components/CrisisResources';
import './settings.page.css';

/** The endpoint-mode banner: each provider as a prominent, selectable chip with
 * a short tag and a one-line descriptor shown when it's active. Display strings
 * live under `settings.providers.<value>` so they localize; the value doubles as
 * the catalog key. */
const PROVIDER_MODES: EndpointMode[] = ['chat_completions', 'lmstudio', 'anthropic', 'responses'];

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
  anthropicVersion: string;
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
  const { t } = useTranslation(['pages', 'common']);
  const { reloadPlayer, creatorMode, setCreatorMode, activeWorldId } = useAppData();
  const [player, setPlayer] = useState<PlayerForm | null>(null);
  const [playerSaved, setPlayerSaved] = useState(false);
  const [playerSaving, setPlayerSaving] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [apiKeySet, setApiKeySet] = useState(false);
  const [models, setModels] = useState<LlmModelInfo[]>([]);
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
          anthropicVersion: s.anthropicVersion,
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
  const hasModel = (id: string) => models.some((m) => m.id === id);
  // Compact "8K ctx · loaded · Q4_K_M" suffix from whatever metadata is present
  // (LM Studio's native listing fills these in; other endpoints just give an id).
  const modelMeta = (m: LlmModelInfo): string => {
    const bits: string[] = [];
    if (m.contextLength) bits.push(`${Math.round(m.contextLength / 1024)}K ctx`);
    if (m.loaded != null) bits.push(m.loaded ? 'loaded' : 'not loaded');
    if (m.quantization) bits.push(m.quantization);
    return bits.length ? ` — ${bits.join(' · ')}` : '';
  };
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
      anthropicVersion: form.anthropicVersion,
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
      setSavedNote(t('settings.toast.saved'));
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
        setSavedNote(t('settings.toast.noModels'));
      } else {
        setSavedNote(t('settings.toast.loadedModels', { count: res.models.length }));
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
        <div className="kicker">{t('settings.head.kicker')}</div>
        <h1>{t('settings.head.title')}</h1>
        <p>{t('settings.head.blurb')}</p>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {savedNote && <Banner kind="ok">{savedNote}</Banner>}

      <section className="set-group">
        <h2 className="set-group-head">{t('settings.groups.gameplay')}</h2>

      <div className="framed set-section">
        <div className="section-head">
          <div className="titles">
            <div className="kicker">{t('settings.mode.kicker')}</div>
            <h2>{t('settings.mode.head')}</h2>
          </div>
          <div className="trail" />
        </div>
        <p className="set-lede">
          <strong>{t('settings.mode.playName')}</strong> {t('settings.mode.playDesc')}{' '}
          <strong>{t('settings.mode.creatorName')}</strong> {t('settings.mode.creatorDesc')}
        </p>
        <div className="set-choice">
          <button className={`btn sm ${!creatorMode ? 'primary' : ''}`} onClick={() => setCreatorMode(false)}>
            <Icon name="play" size={14} /> {t('settings.mode.play')}
          </button>
          <button className={`btn sm ${creatorMode ? 'primary' : ''}`} onClick={() => setCreatorMode(true)}>
            <Icon name="edit" size={14} /> {t('settings.mode.creator')}
          </button>
        </div>
      </div>

      <div className="framed set-section">
        <div className="section-head">
          <div className="titles">
            <div className="kicker">{t('settings.nsfw.kicker')}</div>
            <h2>{t('settings.nsfw.head')}</h2>
          </div>
          <div className="trail" />
        </div>
        <p className="set-lede">{t('settings.nsfw.lede')}</p>
        <div className="set-status-line">
          {form.nsfwEnabled ? (
            <>
              <span className="badge warn">{t('settings.nsfw.on')}</span>
              <button className="btn sm" onClick={() => persistNsfw(false)} disabled={nsfwSaving}>
                {nsfwSaving ? t('settings.nsfw.saving') : t('settings.nsfw.disable')}
              </button>
            </>
          ) : (
            <>
              <span className="badge">{t('settings.nsfw.off')}</span>
              <button className="btn sm danger" onClick={() => setNsfwModalOpen(true)} disabled={nsfwSaving}>
                {t('settings.nsfw.enable')}
              </button>
            </>
          )}
        </div>
        <p className="hint" style={{ marginBottom: 0, marginTop: 12 }}>
          {t('settings.nsfw.modelHint')}
        </p>

        {form.nsfwEnabled && (
          <div className="set-subtoggle">
            <div className="kicker">{t('settings.tragic.kicker')}</div>
            <h3 style={{ margin: '4px 0 6px' }}>{t('settings.tragic.head')}</h3>
            <p className="set-lede" style={{ marginTop: 0 }}>
              {t('settings.tragic.lede')}
            </p>
            <div className="set-status-line">
              {form.tragicOutcomesEnabled ? (
                <>
                  <span className="badge danger">{t('settings.tragic.on')}</span>
                  <button className="btn sm" onClick={() => persistTragic(false)} disabled={tragicSaving}>
                    {tragicSaving ? t('settings.tragic.saving') : t('settings.tragic.disable')}
                  </button>
                </>
              ) : (
                <>
                  <span className="badge">{t('settings.tragic.off')}</span>
                  <button className="btn sm danger" onClick={() => setTragicModalOpen(true)} disabled={tragicSaving}>
                    {t('settings.tragic.enable')}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {player && (
        <div className="framed set-section">
          <div className="section-head">
            <div className="titles">
              <div className="kicker">{t('settings.persona.kicker')}</div>
              <h2>{t('settings.persona.head')}</h2>
            </div>
            <div className="trail" />
          </div>
          <p className="set-lede">{t('settings.persona.lede')}</p>
          <div className="inline-fields">
            <Field label={t('settings.persona.name')}>
              <input value={player.name} onChange={(e) => setPlayer({ ...player, name: e.target.value })} />
            </Field>
            <Field label={t('settings.persona.pronouns')}>
              <input value={player.pronouns} onChange={(e) => setPlayer({ ...player, pronouns: e.target.value })} />
            </Field>
          </div>
          <div className="inline-fields">
            <Field label={t('settings.persona.gender')} hint={t('settings.persona.genderHint')}>
              <select value={player.gender} onChange={(e) => setPlayer({ ...player, gender: e.target.value as Gender })}>
                {Object.keys(GENDER_LABELS).map((k) => (
                  <option key={k} value={k}>
                    {genderLabel(k)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('settings.persona.sexuality')} hint={t('settings.persona.sexualityHint')}>
              <select
                value={player.sexuality}
                onChange={(e) => setPlayer({ ...player, sexuality: e.target.value as Sexuality })}
              >
                {Object.keys(SEXUALITY_LABELS).map((k) => (
                  <option key={k} value={k}>
                    {sexualityLabel(k)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t('settings.persona.notes')} hint={t('settings.persona.notesHint')}>
            <textarea
              value={player.personaNotes}
              onChange={(e) => setPlayer({ ...player, personaNotes: e.target.value })}
            />
          </Field>
          <div className="row">
            <button className="btn primary" onClick={savePlayer} disabled={playerSaving}>
              {playerSaving ? t('settings.persona.saving') : t('settings.persona.save')}
            </button>
            {playerSaved && <span className="badge good">{t('settings.persona.saved')}</span>}
          </div>
        </div>
      )}
      </section>

      <section className="set-group">
        <h2 className="set-group-head">{t('settings.groups.model')}</h2>

      <Link to="/bench" className="set-bench-card framed">
        <div className="set-bench-mark" aria-hidden="true">
          <Icon name="refresh" size={22} />
        </div>
        <div className="set-bench-body">
          <div className="kicker">{t('settings.bench.kicker')}</div>
          <h2>{t('settings.bench.head')}</h2>
          <p>{t('settings.bench.blurb')}</p>
        </div>
        <div className="set-bench-go">
          {t('settings.bench.open')} <Icon name="date" size={15} />
        </div>
      </Link>

      {/* Signature element: the connection console — the technical heart of the
          page, presented as a chamfered instrument panel. */}
      <div className="framed set-console">
        <div className="set-console-head">
          <div>
            <div className="set-console-sub">{t('settings.console.sub')}</div>
            <div className="set-console-title">{t('settings.console.title')}</div>
          </div>
          <span className="set-console-dot">
            {PROVIDER_MODES.includes(form.endpointMode)
              ? t(`settings.providers.${form.endpointMode}.name`)
              : t('settings.console.providerFallback')}{' '}
            · {form.baseUrl ? t('settings.console.endpointSet') : t('settings.console.noEndpoint')}
          </span>
        </div>

        {/* Provider selector — the first decision on this console: it picks the
            wire protocol every field below speaks, so it spans the full width
            above the two columns rather than hiding among the sampling knobs. */}
        <div className="set-provider">
          <div className="set-col-label">{t('settings.console.providerLabel')}</div>
          <div className="set-provider-seg" role="group" aria-label={t('settings.console.endpointModeAria')}>
            {PROVIDER_MODES.map((mode) => {
              const active = form.endpointMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  className={`set-provider-chip ${active ? 'active' : ''}`}
                  aria-pressed={active}
                  onClick={() => set('endpointMode', mode)}
                >
                  <span className="set-provider-name">{t(`settings.providers.${mode}.name`)}</span>
                  <span className="set-provider-tag">{t(`settings.providers.${mode}.tag`)}</span>
                </button>
              );
            })}
          </div>
          <p className="set-provider-desc">{t(`settings.providers.${form.endpointMode}.desc`)}</p>
        </div>

        <div className="set-console-grid">
          <div className="set-console-col">
            <div className="set-col-label">{t('settings.console.connection')}</div>
            <Field
              label={t('settings.fields.baseUrl')}
              hint={
                form.endpointMode === 'anthropic'
                  ? t('settings.fields.baseUrlHintAnthropic')
                  : form.endpointMode === 'lmstudio'
                    ? t('settings.fields.baseUrlHintLmstudio')
                    : t('settings.fields.baseUrlHintDefault')
              }
            >
              <input value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
            </Field>
            <Field
              label={t('settings.fields.apiKey')}
              hint={
                apiKeySet
                  ? t('settings.fields.apiKeyHintSet')
                  : form.endpointMode === 'anthropic'
                    ? t('settings.fields.apiKeyHintAnthropic')
                    : t('settings.fields.apiKeyHintLocal')
              }
            >
              <input
                type="password"
                placeholder={
                  apiKeySet
                    ? t('settings.fields.apiKeyPlaceholderSet')
                    : form.endpointMode === 'anthropic'
                      ? t('settings.fields.apiKeyPlaceholderRequired')
                      : t('settings.fields.apiKeyPlaceholderOptional')
                }
                value={form.apiKey}
                onChange={(e) => set('apiKey', e.target.value)}
              />
            </Field>
            {form.endpointMode === 'anthropic' && (
              <Field
                label={t('settings.fields.anthropicVersion')}
                hint={t('settings.fields.anthropicVersionHint')}
              >
                <input
                  value={form.anthropicVersion}
                  onChange={(e) => set('anthropicVersion', e.target.value)}
                  placeholder="2023-06-01"
                />
              </Field>
            )}
            <Field label={t('settings.fields.model')} hint={t('settings.fields.modelHint')}>
              <input value={form.model} onChange={(e) => set('model', e.target.value)} list="model-list" />
              {models.length > 0 && (
                <select
                  className="set-model-picker"
                  value={hasModel(form.model) ? form.model : ''}
                  onChange={(e) => e.target.value && set('model', e.target.value)}
                >
                  <option value="">{t('settings.fields.pickFrom', { count: models.length })}</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                      {modelMeta(m)}
                    </option>
                  ))}
                </select>
              )}
              <datalist id="model-list">
                {models.map((m) => (
                  <option key={m.id} value={m.id} />
                ))}
              </datalist>
            </Field>
            <Field
              label={t('settings.fields.visionModel')}
              hint={t('settings.fields.visionModelHint')}
            >
              <input
                value={form.visionModel}
                onChange={(e) => set('visionModel', e.target.value)}
                list="model-list"
                placeholder={t('settings.fields.sameAsModel')}
              />
              {models.length > 0 && (
                <select
                  className="set-model-picker"
                  value={hasModel(form.visionModel) ? form.visionModel : ''}
                  onChange={(e) => e.target.value && set('visionModel', e.target.value)}
                >
                  <option value="">{t('settings.fields.pickModel')}</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                      {modelMeta(m)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <button className="btn sm" onClick={loadModels} disabled={loadingModels}>
              {loadingModels ? t('settings.fields.loading') : t('settings.fields.loadModels')}
            </button>
          </div>

          <div className="set-console-col">
            <div className="set-col-label">{t('settings.console.generation')}</div>
            <Field label={t('settings.fields.temperature', { value: form.temperature })}>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={form.temperature}
                onChange={(e) => set('temperature', Number(e.target.value))}
              />
            </Field>
            <Field label={t('settings.fields.maxTokens')}>
              <input type="number" value={form.maxTokens} onChange={(e) => set('maxTokens', Number(e.target.value))} />
            </Field>
            <Field
              label={t('settings.fields.advancedSampling')}
              hint={t('settings.fields.advancedSamplingHint')}
            >
              <div className="set-sampling-grid">
                <label className="set-sampling-cell">
                  <span>{t('settings.fields.topP')}</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    placeholder={t('settings.fields.samplingDefault')}
                    value={form.topP ?? ''}
                    onChange={(e) => setNullable('topP', e.target.value)}
                  />
                </label>
                <label className="set-sampling-cell">
                  <span>{t('settings.fields.topK')}</span>
                  <input
                    type="number"
                    min={0}
                    max={500}
                    step={1}
                    placeholder={t('settings.fields.samplingDefault')}
                    value={form.topK ?? ''}
                    onChange={(e) => setNullable('topK', e.target.value)}
                  />
                </label>
                <label className="set-sampling-cell">
                  <span>{t('settings.fields.minP')}</span>
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    placeholder={t('settings.fields.samplingDefault')}
                    value={form.minP ?? ''}
                    onChange={(e) => setNullable('minP', e.target.value)}
                  />
                </label>
                <label className="set-sampling-cell">
                  <span>{t('settings.fields.frequencyPenalty')}</span>
                  <input
                    type="number"
                    min={-2}
                    max={2}
                    step={0.1}
                    placeholder={t('settings.fields.samplingDefault')}
                    value={form.frequencyPenalty ?? ''}
                    onChange={(e) => setNullable('frequencyPenalty', e.target.value)}
                  />
                </label>
                <label className="set-sampling-cell">
                  <span>{t('settings.fields.presencePenalty')}</span>
                  <input
                    type="number"
                    min={-2}
                    max={2}
                    step={0.1}
                    placeholder={t('settings.fields.samplingDefault')}
                    value={form.presencePenalty ?? ''}
                    onChange={(e) => setNullable('presencePenalty', e.target.value)}
                  />
                </label>
                <label className="set-sampling-cell">
                  <span>{t('settings.fields.repeatPenalty')}</span>
                  <input
                    type="number"
                    min={0}
                    max={2}
                    step={0.05}
                    placeholder={t('settings.fields.samplingDefault')}
                    value={form.repeatPenalty ?? ''}
                    onChange={(e) => setNullable('repeatPenalty', e.target.value)}
                  />
                </label>
              </div>
            </Field>
            <Field label={t('settings.fields.structuredMode')} hint={t('settings.fields.structuredModeHint')}>
              <select value={form.structuredMode} onChange={(e) => set('structuredMode', e.target.value as StructuredOutputMode)}>
                <option value="json_schema">json_schema</option>
                <option value="json_object">json_object</option>
                <option value="prompt_only">prompt_only</option>
              </select>
            </Field>
            <Field
              label={t('settings.fields.dropSchema')}
              hint={t('settings.fields.dropSchemaHint')}
            >
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={form.omitSchemaInPrompt}
                  onChange={(e) => set('omitSchemaInPrompt', e.target.checked)}
                />
                <span>{t('settings.fields.dropSchemaLabel')}</span>
              </label>
            </Field>
            <Field label={t('settings.fields.retryLimit')} hint={t('settings.fields.retryLimitHint')}>
              <input type="number" min={0} max={10} value={form.maxRetries} onChange={(e) => set('maxRetries', Number(e.target.value))} />
            </Field>
            <Field
              label={t('settings.fields.rapport')}
              hint={t('settings.fields.rapportHint')}
            >
              <select value={form.rapportCadence} onChange={(e) => set('rapportCadence', e.target.value as 'every' | 'periodic')}>
                <option value="every">{t('settings.fields.rapportEvery')}</option>
                <option value="periodic">{t('settings.fields.rapportPeriodic')}</option>
              </select>
            </Field>
          </div>
        </div>

        <div className="set-console-foot">
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? t('settings.foot.saving') : t('settings.foot.save')}
          </button>
          <button className="btn" onClick={test} disabled={testing}>
            {testing ? t('settings.foot.testing') : <><Icon name="refresh" size={15} /> {t('settings.foot.test')}</>}
          </button>
        </div>
      </div>
      </section>

      {health && (
        <Banner kind={health.ok ? 'ok' : 'error'}>
          <strong>{health.ok ? t('settings.health.connected') : t('settings.health.failed')}</strong> {health.message}
          {health.latencyMs !== undefined && <> · {health.latencyMs}ms</>}
          {health.sample && (
            <>
              <br />
              {t('settings.health.sample')} <em>{health.sample}</em>
            </>
          )}
          {health.models && health.models.length > 0 && (
            <>
              <br />
              {t('settings.health.models')} {health.models.slice(0, 8).join(', ')}
            </>
          )}
        </Banner>
      )}

      {nsfwModalOpen &&
        createPortal(
          <div className="modal-overlay" onClick={closeNsfwModal}>
            <div className="modal card" onClick={(e) => e.stopPropagation()}>
              <div className="kicker">{t('settings.nsfwModal.kicker')}</div>
              <h2 style={{ marginTop: 0 }}>{t('settings.nsfwModal.title')}</h2>
              <p className="hint" style={{ marginTop: 0 }}>
                {t('settings.nsfwModal.intro')}
              </p>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: '12px 0', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={ackContent}
                  onChange={(e) => setAckContent(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>{t('settings.nsfwModal.ackContent')}</span>
              </label>
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: '12px 0', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={ackAge}
                  onChange={(e) => setAckAge(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>{t('settings.nsfwModal.ackAge')}</span>
              </label>
              <p className="hint">
                {t('settings.nsfwModal.footnote')}
              </p>
              {error && <Banner kind="error">{error}</Banner>}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn ghost" onClick={closeNsfwModal} disabled={nsfwSaving}>
                  {t('settings.nsfwModal.cancel')}
                </button>
                <button
                  className="btn danger"
                  disabled={!(ackContent && ackAge) || nsfwSaving}
                  onClick={confirmEnableNsfw}
                >
                  {nsfwSaving ? t('settings.nsfwModal.enabling') : t('settings.nsfwModal.enable')}
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
              <div className="kicker">{t('settings.tragicModal.kicker')}</div>
              <h2 style={{ marginTop: 0 }}>{t('settings.tragicModal.title')}</h2>
              <p className="hint" style={{ marginTop: 0 }}>
                {t('settings.tragicModal.intro')}
              </p>
              <CrisisResources />
              <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: '12px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={ackTragic} onChange={(e) => setAckTragic(e.target.checked)} style={{ marginTop: 3 }} />
                <span>{t('settings.tragicModal.ack')}</span>
              </label>
              {error && <Banner kind="error">{error}</Banner>}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn ghost" onClick={closeTragicModal} disabled={tragicSaving}>
                  {t('settings.tragicModal.cancel')}
                </button>
                <button className="btn danger" disabled={!ackTragic || tragicSaving} onClick={confirmEnableTragic}>
                  {tragicSaving ? t('settings.tragicModal.enabling') : t('settings.tragicModal.enable')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
