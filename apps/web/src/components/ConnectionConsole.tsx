import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LlmModelInfo, StructuredOutputMode, EndpointMode, LlmRoleConnection } from '@dsim/shared';
import { Field } from './ui';
import { Icon } from './Icon';

/** The connection/generation fields shared by the base config and every per-role
 *  override (everything on a role connection except its `enabled` flag). */
export type ConnectionForm = Omit<LlmRoleConnection, 'enabled'>;

/** Provider chips, in display order. Mirrors Settings' base console. */
const PROVIDER_MODES: EndpointMode[] = ['chat_completions', 'lmstudio', 'anthropic', 'responses'];

const NULLABLE_KEYS = ['topP', 'topK', 'minP', 'frequencyPenalty', 'presencePenalty', 'repeatPenalty'] as const;
type NullableKey = (typeof NULLABLE_KEYS)[number];

interface Props {
  value: ConnectionForm;
  onChange: (patch: Partial<ConnectionForm>) => void;
  /** Whether a key is already stored server-side (blank field then means "keep it"). */
  apiKeySet: boolean;
  /** Unique suffix so each console's <datalist> id doesn't collide. */
  idPrefix: string;
  models: LlmModelInfo[];
  loadingModels: boolean;
  onLoadModels: () => void;
  onTest: () => void;
  testing: boolean;
  /** Extra fields rendered at the end of the connection column (e.g. vision model). */
  connectionExtra?: ReactNode;
  /** Extra fields rendered at the end of the generation column (e.g. rapport cadence). */
  generationExtra?: ReactNode;
  /** Extra controls rendered at the start of the footer row (e.g. the global Save). */
  footerStart?: ReactNode;
  /** Hide the built-in footer entirely (when the parent owns a shared footer). */
  hideFooter?: boolean;
}

/**
 * One LLM connection editor: the provider selector plus the connection and
 * generation columns. Used for the base config and for each per-role override, so a
 * role can point at a wholly independent endpoint, model, and decoding params.
 */
export function ConnectionConsole({
  value,
  onChange,
  apiKeySet,
  idPrefix,
  models,
  loadingModels,
  onLoadModels,
  onTest,
  testing,
  connectionExtra,
  generationExtra,
  footerStart,
  hideFooter,
}: Props) {
  const { t } = useTranslation(['pages', 'common']);
  const hasModel = (id: string) => models.some((m) => m.id === id);
  const datalistId = `model-list-${idPrefix}`;

  const modelMeta = (m: LlmModelInfo): string => {
    const bits: string[] = [];
    if (m.contextLength) bits.push(`${Math.round(m.contextLength / 1024)}K ctx`);
    if (m.loaded != null) bits.push(m.loaded ? 'loaded' : 'not loaded');
    if (m.quantization) bits.push(m.quantization);
    return bits.length ? ` — ${bits.join(' · ')}` : '';
  };

  const setNullable = (k: NullableKey, raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') return onChange({ [k]: null } as Partial<ConnectionForm>);
    const n = Number(trimmed);
    onChange({ [k]: Number.isFinite(n) ? n : null } as Partial<ConnectionForm>);
  };

  const nullableCell = (k: NullableKey, label: string, min: number, max: number, step: number) => (
    <label className="set-sampling-cell">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        placeholder={t('settings.fields.samplingDefault')}
        value={value[k] ?? ''}
        onChange={(e) => setNullable(k, e.target.value)}
      />
    </label>
  );

  return (
    <>
      <div className="set-provider">
        <div className="set-col-label">{t('settings.console.providerLabel')}</div>
        <div className="set-provider-seg" role="group" aria-label={t('settings.console.endpointModeAria')}>
          {PROVIDER_MODES.map((mode) => {
            const active = value.endpointMode === mode;
            return (
              <button
                key={mode}
                type="button"
                className={`set-provider-chip ${active ? 'active' : ''}`}
                aria-pressed={active}
                onClick={() => onChange({ endpointMode: mode })}
              >
                <span className="set-provider-name">{t(`settings.providers.${mode}.name`)}</span>
                <span className="set-provider-tag">{t(`settings.providers.${mode}.tag`)}</span>
              </button>
            );
          })}
        </div>
        <p className="set-provider-desc">{t(`settings.providers.${value.endpointMode}.desc`)}</p>
      </div>

      <div className="set-console-grid">
        <div className="set-console-col">
          <div className="set-col-label">{t('settings.console.connection')}</div>
          <Field
            label={t('settings.fields.baseUrl')}
            hint={
              value.endpointMode === 'anthropic'
                ? t('settings.fields.baseUrlHintAnthropic')
                : value.endpointMode === 'lmstudio'
                  ? t('settings.fields.baseUrlHintLmstudio')
                  : t('settings.fields.baseUrlHintDefault')
            }
          >
            <input value={value.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} />
          </Field>
          <Field
            label={t('settings.fields.apiKey')}
            hint={
              apiKeySet
                ? t('settings.fields.apiKeyHintSet')
                : value.endpointMode === 'anthropic'
                  ? t('settings.fields.apiKeyHintAnthropic')
                  : t('settings.fields.apiKeyHintLocal')
            }
          >
            <input
              type="password"
              placeholder={
                apiKeySet
                  ? t('settings.fields.apiKeyPlaceholderSet')
                  : value.endpointMode === 'anthropic'
                    ? t('settings.fields.apiKeyPlaceholderRequired')
                    : t('settings.fields.apiKeyPlaceholderOptional')
              }
              value={value.apiKey}
              onChange={(e) => onChange({ apiKey: e.target.value })}
            />
          </Field>
          {value.endpointMode === 'anthropic' && (
            <Field label={t('settings.fields.anthropicVersion')} hint={t('settings.fields.anthropicVersionHint')}>
              <input
                value={value.anthropicVersion}
                onChange={(e) => onChange({ anthropicVersion: e.target.value })}
                placeholder="2023-06-01"
              />
            </Field>
          )}
          <Field label={t('settings.fields.model')} hint={t('settings.fields.modelHint')}>
            <input value={value.model} onChange={(e) => onChange({ model: e.target.value })} list={datalistId} />
            {models.length > 0 && (
              <select
                className="set-model-picker"
                value={hasModel(value.model) ? value.model : ''}
                onChange={(e) => e.target.value && onChange({ model: e.target.value })}
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
            <datalist id={datalistId}>
              {models.map((m) => (
                <option key={m.id} value={m.id} />
              ))}
            </datalist>
          </Field>
          {connectionExtra}
          <button className="btn sm" onClick={onLoadModels} disabled={loadingModels}>
            {loadingModels ? t('settings.fields.loading') : t('settings.fields.loadModels')}
          </button>
        </div>

        <div className="set-console-col">
          <div className="set-col-label">{t('settings.console.generation')}</div>
          <Field label={t('settings.fields.temperature', { value: value.temperature })}>
            <input
              type="range"
              min={0}
              max={2}
              step={0.1}
              value={value.temperature}
              onChange={(e) => onChange({ temperature: Number(e.target.value) })}
            />
          </Field>
          <Field label={t('settings.fields.maxTokens')}>
            <input type="number" value={value.maxTokens} onChange={(e) => onChange({ maxTokens: Number(e.target.value) })} />
          </Field>
          <Field label={t('settings.fields.advancedSampling')} hint={t('settings.fields.advancedSamplingHint')}>
            <div className="set-sampling-grid">
              {nullableCell('topP', t('settings.fields.topP'), 0, 1, 0.05)}
              {nullableCell('topK', t('settings.fields.topK'), 0, 500, 1)}
              {nullableCell('minP', t('settings.fields.minP'), 0, 1, 0.01)}
              {nullableCell('frequencyPenalty', t('settings.fields.frequencyPenalty'), -2, 2, 0.1)}
              {nullableCell('presencePenalty', t('settings.fields.presencePenalty'), -2, 2, 0.1)}
              {nullableCell('repeatPenalty', t('settings.fields.repeatPenalty'), 0, 2, 0.05)}
            </div>
          </Field>
          <Field label={t('settings.fields.structuredMode')} hint={t('settings.fields.structuredModeHint')}>
            <select
              value={value.structuredMode}
              onChange={(e) => onChange({ structuredMode: e.target.value as StructuredOutputMode })}
            >
              <option value="json_schema">json_schema</option>
              <option value="json_object">json_object</option>
              <option value="prompt_only">prompt_only</option>
            </select>
          </Field>
          <Field label={t('settings.fields.dropSchema')} hint={t('settings.fields.dropSchemaHint')}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={value.omitSchemaInPrompt}
                onChange={(e) => onChange({ omitSchemaInPrompt: e.target.checked })}
              />
              <span>{t('settings.fields.dropSchemaLabel')}</span>
            </label>
          </Field>
          <Field label={t('settings.fields.retryLimit')} hint={t('settings.fields.retryLimitHint')}>
            <input
              type="number"
              min={0}
              max={10}
              value={value.maxRetries}
              onChange={(e) => onChange({ maxRetries: Number(e.target.value) })}
            />
          </Field>
          {generationExtra}
        </div>
      </div>

      {!hideFooter && (
        <div className="set-console-foot">
          {footerStart}
          <button className="btn" onClick={onTest} disabled={testing}>
            {testing ? t('settings.foot.testing') : (
              <>
                <Icon name="refresh" size={15} /> {t('settings.foot.test')}
              </>
            )}
          </button>
        </div>
      )}
    </>
  );
}
