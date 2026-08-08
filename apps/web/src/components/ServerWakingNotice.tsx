import { useTranslation } from 'react-i18next';
import { useAppData } from '../state/app-context';

/** A quiet fixed pill shown while the API server is unreachable — the run.bat /
 *  desktop-shell boot race, or a mid-session server restart. The app-context
 *  wake loop is already retrying with backoff; this exists so the temporary
 *  emptiness never masquerades as an empty save. Mounted once, above the shell,
 *  so it covers every route including the world selector. */
export function ServerWakingNotice() {
  const { t } = useTranslation();
  const { serverWaking } = useAppData();
  if (!serverWaking) return null;
  return (
    <div className="server-waking" role="status">
      <span className="server-waking-dot" aria-hidden />
      {t('shell.serverWaking')}
    </div>
  );
}
