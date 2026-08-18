import { useTranslation } from 'react-i18next';
import { useAppData } from '../state/app-context';

/** A quiet fixed pill shown while the API server is unreachable — the run.bat /
 *  desktop-shell boot race, or a mid-session server restart. The app-context
 *  wake loop is already retrying with backoff; this exists so the temporary
 *  emptiness never masquerades as an empty save. Mounted once, above the shell,
 *  so it covers every route including the world selector. */
export function ServerWakingNotice() {
  const { t } = useTranslation();
  const { serverWaking, syncWarning } = useAppData();
  if (!serverWaking && !syncWarning) return null;
  let className = 'server-waking';
  let role: 'status' | 'alert' = 'status';
  let message = t('shell.serverWaking');
  if (!serverWaking && syncWarning) {
    className += ' is-error';
    role = 'alert';
    message = t('shell.syncWarning', { error: syncWarning });
  }
  return (
    <div className={className} role={role}>
      <span className="server-waking-dot" aria-hidden />
      {message}
    </div>
  );
}
