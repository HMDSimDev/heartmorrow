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
  type LlmRoleConnection,
  type EndpointMode,
} from '@dsim/shared';
import { api } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { genderLabel, sexualityLabel } from '../i18n/labels';
import { SUPPORTED_LOCALES } from '../i18n/locales';
import { Banner, Field, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { CrisisResources } from '../components/CrisisResources';
import { ConnectionConsole, type ConnectionForm } from '../components/ConnectionConsole';
import './settings.page.css';

/** Accent presets — gem-like tints applied app-wide via the theme CSS variables.
 *  `null` accent restores the default Rose. `nameKey` localizes the swatch name. */
const ACCENT_PRESETS = [
  { nameKey: 'settings.appearance.presets.rose', accent: null, accent2: null },
  { nameKey: 'settings.appearance.presets.brass', accent: '#e6b15e', accent2: '#d98a3c' },
  { nameKey: 'settings.appearance.presets.moonlight', accent: '#9db8de', accent2: '#6f8fd0' },
  { nameKey: 'settings.appearance.presets.sage', accent: '#8fcf9f', accent2: '#4fa97e' },
  { nameKey: 'settings.appearance.presets.ember', accent: '#e07a82', accent2: '#b23d52' },
  { nameKey: 'settings.appearance.presets.plum', accent: '#b58bd6', accent2: '#e88aa6' },
] as const;

/** The endpoint-mode banner: each provider as a prominent, selectable chip with
 * a short tag and a one-line descriptor shown when it's active. Display strings
 * live under `settings.providers.<value>` so they localize; the value doubles as
 * the catalog key. */
const PROVIDER_MODES: EndpointMode[] = ['chat_completions', 'lmstudio', 'anthropic', 'responses'];

/** Roles with an optional independent endpoint/model. `prose` always uses base. */
type RoleKey = 'evaluator' | 'vision';
const ROLE_KEYS: RoleKey[] = ['evaluator', 'vision'];

/** The base config: a connection (shared with the role consoles) plus the
 *  base-only vision model, the game-level toggles, and the per-role overrides. */
type Form = ConnectionForm & {
  visionModel: string;
  nsfwEnabled: boolean;
  rapportCadence: 'every' | 'periodic';
  tragicOutcomesEnabled: boolean;
  roleOverrides: Record<RoleKey, LlmRoleConnection>;
};

/** Keys of one connection, used to project a connection into a settings patch. */
const CONNECTION_FIELDS = [
  'baseUrl', 'apiKey', 'model', 'temperature', 'maxTokens', 'topP', 'topK', 'minP',
  'frequencyPenalty', 'presencePenalty', 'repeatPenalty', 'structuredMode',
  'omitSchemaInPrompt', 'endpointMode', 'anthropicVersion', 'maxRetries',
] as const;

/** A connection → settings-patch object, dropping a blank API key so the server
 *  keeps the stored one (the field is redacted on load and only sent when changed). */
function connectionPatch(c: ConnectionForm): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const k of CONNECTION_FIELDS) patch[k] = c[k];
  if (!c.apiKey) delete patch.apiKey;
  return patch;
}

interface PlayerForm {
  name: string;
  pronouns: string;
  gender: Gender;
  sexuality: Sexuality;
  personaNotes: string;
}

/** `embedded` drops the page's own header — used when the world selector renders
 *  Settings under its own "Settings" heading, so the title isn't shown twice. */
export function Settings({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, i18n } = useTranslation(['pages', 'common']);
  const { reloadPlayer, creatorMode, setCreatorMode, activeWorldId, theme, setTheme } = useAppData();
  const [player, setPlayer] = useState<PlayerForm | null>(null);
  const [playerSaved, setPlayerSaved] = useState(false);
  const [playerSaving, setPlayerSaving] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  // API-key-is-set flags + model lists + load/test pending, keyed per connection
  // ('base' | RoleKey) so each console manages its own endpoint independently.
  const [apiKeySet, setApiKeySet] = useState<Record<string, boolean>>({});
  const [models, setModels] = useState<Record<string, LlmModelInfo[]>>({});
  const [loadingModels, setLoadingModels] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  // Which connection tab is showing: the main config or one of the role overrides.
  const [tab, setTab] = useState<'base' | RoleKey>('base');
  const [health, setHealth] = useState<LlmHealthResult | null>(null);
  const [error, setError] = useState<string>();
  const [savedNote, setSavedNote] = useState<string>();
  const [saving, setSaving] = useState(false);
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
        setApiKeySet({ base: s.apiKeySet, evaluator: s.roleApiKeySet.evaluator, vision: s.roleApiKeySet.vision });
        setForm({
          baseUrl: s.baseUrl,
          apiKey: '',
          model: s.model,
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
          visionModel: s.visionModel,
          nsfwEnabled: s.nsfwEnabled,
          rapportCadence: s.rapportCadence,
          tragicOutcomesEnabled: s.tragicOutcomesEnabled,
          roleOverrides: { evaluator: s.roleOverrides.evaluator, vision: s.roleOverrides.vision },
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
  // The connection backing the active tab — drives the header status readout.
  const activeConn: ConnectionForm = tab === 'base' ? form : form.roleOverrides[tab];
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  // Patch into one role's override connection.
  const setRole = (role: RoleKey, patch: Partial<ConnectionForm>) =>
    setForm((f) =>
      f ? { ...f, roleOverrides: { ...f.roleOverrides, [role]: { ...f.roleOverrides[role], ...patch } } } : f,
    );

  // The full PATCH body: base connection (+ blank key dropped) + base-only fields +
  // both role overrides whole (a blank role key is preserved server-side).
  const buildUpdate = (): Record<string, unknown> => ({
    ...connectionPatch(form),
    visionModel: form.visionModel,
    nsfwEnabled: form.nsfwEnabled,
    rapportCadence: form.rapportCadence,
    tragicOutcomesEnabled: form.tragicOutcomesEnabled,
    roleOverrides: { evaluator: form.roleOverrides.evaluator, vision: form.roleOverrides.vision },
  });

  const save = async () => {
    setSaving(true);
    setSavedNote(undefined);
    setError(undefined);
    try {
      const s = await api.updateSettings(buildUpdate());
      setApiKeySet({ base: s.apiKeySet, evaluator: s.roleApiKeySet.evaluator, vision: s.roleApiKeySet.vision });
      // Re-blank every (now stored) key field so the inputs show "unchanged".
      setForm((f) =>
        f
          ? {
              ...f,
              apiKey: '',
              roleOverrides: {
                evaluator: { ...f.roleOverrides.evaluator, apiKey: '' },
                vision: { ...f.roleOverrides.vision, apiKey: '' },
              },
            }
          : f,
      );
      setSavedNote(t('settings.toast.saved'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  // Test / list-models for one connection ('base' or a role). Uses the values
  // currently typed in (no Save needed); a role passes its key so a blank field
  // falls back to that role's stored key, not the base one.
  const overrideFor = (key: string) =>
    key === 'base'
      ? connectionPatch(form)
      : { ...connectionPatch(form.roleOverrides[key as RoleKey]), role: key as RoleKey };

  const test = async (key: string) => {
    setTesting((m) => ({ ...m, [key]: true }));
    setHealth(null);
    setError(undefined);
    try {
      setHealth(await api.testLlm(overrideFor(key)));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setTesting((m) => ({ ...m, [key]: false }));
    }
  };

  const loadModels = async (key: string) => {
    if (loadingModels[key]) return;
    setLoadingModels((m) => ({ ...m, [key]: true }));
    setError(undefined);
    setSavedNote(undefined);
    try {
      const res = await api.listModels(overrideFor(key));
      setModels((m) => ({ ...m, [key]: res.models }));
      if (!res.ok && res.error) setError(res.error);
      else if (res.models.length === 0) setSavedNote(t('settings.toast.noModels'));
      else setSavedNote(t('settings.toast.loadedModels', { count: res.models.length }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingModels((m) => ({ ...m, [key]: false }));
    }
  };

  // Persist the NSFW toggle on its own (a minimal PATCH) so enabling/disabling is
  // atomic with the acknowledgment and never depends on the main Save button.
  const persistNsfw = async (enabled: boolean): Promise<boolean> => {
    setNsfwSaving(true);
    setError(undefined);
    try {
      const s = await api.updateSettings({ nsfwEnabled: enabled });
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


  return (
    <div className="stack set-page">
      {!embedded && (
        <div className="page-head">
          <div className="kicker">{t('settings.head.kicker')}</div>
          <h1>{t('settings.head.title')}</h1>
          <p>{t('settings.head.blurb')}</p>
        </div>
      )}
      {error && <Banner kind="error">{error}</Banner>}
      {savedNote && <Banner kind="ok">{savedNote}</Banner>}

      <section className="set-group">
        <h2 className="set-group-head">{t('settings.groups.appearance')}</h2>

        <div className="framed set-section">
          <div className="section-head">
            <div className="titles">
              <div className="kicker">{t('settings.appearance.kicker')}</div>
              <h2>{t('settings.appearance.head')}</h2>
            </div>
            <div className="trail" />
          </div>
          <p className="set-lede">{t('settings.appearance.lede')}</p>

          <Field label={t('settings.appearance.language')} hint={t('settings.appearance.languageHint')}>
            <select
              value={i18n.resolvedLanguage ?? i18n.language}
              onChange={(e) => { void i18n.changeLanguage(e.target.value); }}
            >
              {SUPPORTED_LOCALES.map((loc) => (
                <option key={loc.code} value={loc.code}>{loc.label}</option>
              ))}
            </select>
          </Field>

          <div className="set-accent">
            <div className="set-col-label">{t('settings.appearance.accent')}</div>
            <p className="hint" style={{ marginTop: 0 }}>{t('settings.appearance.accentHint')}</p>
            <div className="set-swatches">
              {ACCENT_PRESETS.map((p) => {
                const active = (theme.accent ?? null) === p.accent;
                return (
                  <button
                    key={p.nameKey}
                    type="button"
                    className={`set-swatch ${active ? 'active' : ''}`}
                    aria-pressed={active}
                    aria-label={t(p.nameKey)}
                    onClick={() => setTheme({ ...theme, accent: p.accent, accent2: p.accent2 })}
                  >
                    <span
                      className="set-gem"
                      style={{
                        background: p.accent
                          ? `linear-gradient(135deg, ${p.accent}, ${p.accent2})`
                          : 'linear-gradient(135deg, var(--rose), var(--brass))',
                      }}
                    />
                    <span className="set-swatch-name">{t(p.nameKey)}</span>
                  </button>
                );
              })}
            </div>
            <label className="set-accent-custom">
              <span>{t('settings.appearance.accentCustom')}</span>
              {/* native color picker — a platform affordance */}
              <input
                type="color"
                value={theme.accent ?? '#e88aa6'}
                onChange={(e) => setTheme({ ...theme, accent: e.target.value, accent2: e.target.value })}
              />
            </label>
          </div>
        </div>
      </section>

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

      {player && activeWorldId && (
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
          page, presented as a chamfered instrument panel. One box, with a tab per
          model role: the main config (prose), the judge (evaluator), and vision. */}
      <div className="framed set-console">
        <div className="set-console-head">
          <div>
            <div className="set-console-sub">{t('settings.console.sub')}</div>
            <div className="set-console-title">{t('settings.console.title')}</div>
          </div>
          <span className="set-console-dot">
            {PROVIDER_MODES.includes(activeConn.endpointMode)
              ? t(`settings.providers.${activeConn.endpointMode}.name`)
              : t('settings.console.providerFallback')}{' '}
            · {activeConn.baseUrl ? t('settings.console.endpointSet') : t('settings.console.noEndpoint')}
          </span>
        </div>

        <div className="set-tabs" role="tablist" aria-label={t('settings.console.title')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'base'}
            className={`set-tab ${tab === 'base' ? 'active' : ''}`}
            onClick={() => setTab('base')}
          >
            {t('settings.roles.base.tab')}
          </button>
          {ROLE_KEYS.map((role) => (
            <button
              key={role}
              type="button"
              role="tab"
              aria-selected={tab === role}
              className={`set-tab ${tab === role ? 'active' : ''}`}
              onClick={() => setTab(role)}
            >
              {t(`settings.roles.${role}.tab`)}
              {form.roleOverrides[role].enabled && <span className="set-tab-dot" aria-hidden="true" />}
            </button>
          ))}
        </div>

        {tab === 'base' ? (
          <ConnectionConsole
            value={form}
            onChange={set}
            apiKeySet={!!apiKeySet.base}
            idPrefix="base"
            models={models.base ?? []}
            loadingModels={!!loadingModels.base}
            onLoadModels={() => loadModels('base')}
            onTest={() => test('base')}
            testing={!!testing.base}
            hideFooter
            connectionExtra={
              <Field label={t('settings.fields.visionModel')} hint={t('settings.fields.visionModelHint')}>
                <input
                  value={form.visionModel}
                  onChange={(e) => set({ visionModel: e.target.value })}
                  list="model-list-base"
                  placeholder={t('settings.fields.sameAsModel')}
                />
              </Field>
            }
            generationExtra={
              <Field label={t('settings.fields.rapport')} hint={t('settings.fields.rapportHint')}>
                <select
                  value={form.rapportCadence}
                  onChange={(e) => set({ rapportCadence: e.target.value as 'every' | 'periodic' })}
                >
                  <option value="every">{t('settings.fields.rapportEvery')}</option>
                  <option value="periodic">{t('settings.fields.rapportPeriodic')}</option>
                </select>
              </Field>
            }
          />
        ) : (
          (() => {
            const role = tab;
            const conn = form.roleOverrides[role];
            return (
              <>
                <div className="set-role-bar">
                  <p className="set-lede" style={{ margin: 0 }}>
                    {t(`settings.roles.${role}.blurb`)}
                  </p>
                  <label className="set-role-toggle">
                    <input
                      type="checkbox"
                      checked={conn.enabled}
                      onChange={(e) => setRole(role, { enabled: e.target.checked } as Partial<ConnectionForm>)}
                    />
                    <span>{conn.enabled ? t('settings.roles.on') : t('settings.roles.off')}</span>
                  </label>
                </div>
                {conn.enabled ? (
                  <ConnectionConsole
                    value={conn}
                    onChange={(patch) => setRole(role, patch)}
                    apiKeySet={!!apiKeySet[role]}
                    idPrefix={role}
                    models={models[role] ?? []}
                    loadingModels={!!loadingModels[role]}
                    onLoadModels={() => loadModels(role)}
                    onTest={() => test(role)}
                    testing={!!testing[role]}
                    hideFooter
                  />
                ) : (
                  <p className="hint">{t('settings.roles.usingMain')}</p>
                )}
              </>
            );
          })()
        )}

        <div className="set-console-foot">
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? t('settings.foot.saving') : t('settings.foot.save')}
          </button>
          {(tab === 'base' || form.roleOverrides[tab].enabled) && (
            <button className="btn" onClick={() => test(tab)} disabled={!!testing[tab]}>
              {testing[tab] ? t('settings.foot.testing') : (
                <>
                  <Icon name="refresh" size={15} /> {t('settings.foot.test')}
                </>
              )}
            </button>
          )}
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
