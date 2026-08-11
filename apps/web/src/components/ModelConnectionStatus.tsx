import type { EndpointMode } from '@dsim/shared';
import { useTranslation } from 'react-i18next';
import { useAppData } from '../state/app-context';

function providerKey(mode: EndpointMode): 'lmstudio' | 'ollama' | 'koboldcpp' | 'generic' {
  if (mode === 'lmstudio') return 'lmstudio';
  if (mode === 'ollama') return 'ollama';
  if (mode === 'koboldcpp') return 'koboldcpp';
  return 'generic';
}

export function ModelConnectionStatus({ detailed = false }: { detailed?: boolean }) {
  const { t } = useTranslation('common');
  const { modelConnectionStatus, modelConnectionMessage, modelProviderMode } = useAppData();
  const provider = t(`support.modelStatus.providers.${providerKey(modelProviderMode)}`);
  let label = t('support.modelStatus.notConfigured');
  if (modelConnectionStatus === 'checking') label = t('support.modelStatus.checking', { provider });
  if (modelConnectionStatus === 'connected') label = t('support.modelStatus.connected', { provider });
  if (modelConnectionStatus === 'disconnected') label = t('support.modelStatus.disconnected', { provider });
  let className = `model-connection-status is-${modelConnectionStatus}`;
  if (detailed) className += ' is-detailed';
  let title: string | undefined;
  if (modelConnectionMessage) title = modelConnectionMessage;

  return (
    <div className={className} role="status" aria-live="polite" title={title}>
      <span className="model-connection-lamp" aria-hidden="true" />
      <span className="model-connection-copy">
        <span className="model-connection-label">{label}</span>
        {detailed && modelConnectionMessage && <small>{modelConnectionMessage}</small>}
      </span>
    </div>
  );
}
