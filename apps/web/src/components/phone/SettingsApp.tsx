import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppData } from '../../state/app-context';
import { errorMessage } from '../../lib/hooks';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Banner, ConfirmDialog } from '../ui';
import '../../pages/settings.page.css';

const MAX_WALLPAPER_BYTES = 1.5 * 1024 * 1024;

export function SettingsApp() {
  const { t } = useTranslation(['settings', 'common']);
  const { theme, setTheme, creatorMode, setCreatorMode, resetProgress } = useAppData();
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onWallpaper = (file: File) => {
    setError(undefined);
    if (file.size > MAX_WALLPAPER_BYTES) {
      setError(t('toast.wallpaperTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setTheme({ ...theme, wallpaper: String(reader.result) });
        setNote(t('toast.wallpaperSet'));
      } catch (e) {
        setError(errorMessage(e));
      }
    };
    reader.readAsDataURL(file);
  };

  const totalReset = async () => {
    setConfirmReset(false);
    setResetting(true);
    setError(undefined);
    try {
      await resetProgress();
      setNote(t('toast.progressReset'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="phone-app">
      <PhoneAppBar title={t('title')} icon="settings" />
      <div className="phone-embed">
        {note && <Banner kind="ok">{note}</Banner>}
        {error && <Banner kind="error">{error}</Banner>}

        {confirmReset && (
          <ConfirmDialog
            kicker={t('reset.kicker')}
            title={t('reset.title')}
            body={t('reset.body')}
            confirmLabel={t('reset.confirm')}
            danger
            busy={resetting}
            onConfirm={() => { void totalReset(); }}
            onCancel={() => setConfirmReset(false)}
          />
        )}

        <div className="pset-list">
          <div className="pset-group">
            <div className="pset-group-head">{t('wallpaper.head')}</div>
            <div className="pset-panel">
              <p className="pset-hint" style={{ marginBottom: 10 }}>{t('wallpaper.hint')}</p>
              <div className="pset-wall">
                <span
                  className="pset-wall-prev"
                  style={theme.wallpaper ? { backgroundImage: `url("${theme.wallpaper}")` } : undefined}
                >
                  {!theme.wallpaper && <Icon name="download" size={22} />}
                </span>
                <div className="pset-wall-actions">
                  <label className="btn sm">
                    <Icon name="upload" size={14} /> {t('common:chooseImage')}
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) onWallpaper(f);
                        if (fileRef.current) fileRef.current.value = '';
                      }}
                    />
                  </label>
                  {theme.wallpaper && (
                    <button className="btn sm ghost" onClick={() => setTheme({ ...theme, wallpaper: null })}>
                      {t('common:remove')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="pset-group">
            <div className="pset-group-head">{t('mode.head')}</div>
            <div className="pset-panel">
              <p className="pset-hint" style={{ marginBottom: 10 }}>
                {t('mode.hint')}
              </p>
              <div className="row">
                <button className={`btn sm ${!creatorMode ? 'primary' : ''}`} aria-pressed={!creatorMode} onClick={() => setCreatorMode(false)}>
                  <Icon name="play" size={14} /> {t('mode.play')}
                </button>
                <button className={`btn sm ${creatorMode ? 'primary' : ''}`} aria-pressed={creatorMode} onClick={() => setCreatorMode(true)}>
                  <Icon name="settings" size={14} /> {t('mode.creator')}
                </button>
              </div>
            </div>
          </div>

          <div className="pset-danger">
            <div className="pset-group-head">{t('danger.head')}</div>
            <p className="pset-hint" style={{ margin: '8px 0 10px' }}>
              {t('danger.hint')}
            </p>
            <button className="btn sm danger" onClick={() => setConfirmReset(true)} disabled={resetting}>
              <Icon name="trash" size={14} /> {resetting ? t('danger.resetting') : t('danger.reset')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
