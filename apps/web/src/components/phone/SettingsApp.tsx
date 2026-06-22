import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppData } from '../../state/app-context';
import { errorMessage } from '../../lib/hooks';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Banner, ConfirmDialog } from '../ui';
import { SUPPORTED_LOCALES } from '../../i18n/locales';
import '../../pages/settings.page.css';

// `nameKey` points at a settings-namespace label so swatch names localize with
// the rest of the UI. `as const` keeps the keys as a literal union for typed t().
const PRESETS = [
  { nameKey: 'accent.presets.rose', accent: null, accent2: null },
  { nameKey: 'accent.presets.brass', accent: '#e6b15e', accent2: '#d98a3c' },
  { nameKey: 'accent.presets.moonlight', accent: '#9db8de', accent2: '#6f8fd0' },
  { nameKey: 'accent.presets.sage', accent: '#8fcf9f', accent2: '#4fa97e' },
  { nameKey: 'accent.presets.ember', accent: '#e07a82', accent2: '#b23d52' },
  { nameKey: 'accent.presets.plum', accent: '#b58bd6', accent2: '#e88aa6' },
] as const;

const MAX_WALLPAPER_BYTES = 1.5 * 1024 * 1024;

export function SettingsApp() {
  const { t, i18n } = useTranslation(['settings', 'common']);
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
            <div className="pset-group-head">{t('language.head')}</div>
            <div className="pset-panel">
              <p className="pset-hint" style={{ marginBottom: 10 }}>{t('language.hint')}</p>
              <div className="pset-custom">
                <span>{t('language.label')}</span>
                <select
                  aria-label={t('language.label')}
                  value={i18n.resolvedLanguage ?? i18n.language}
                  onChange={(e) => { void i18n.changeLanguage(e.target.value); }}
                >
                  {SUPPORTED_LOCALES.map((loc) => (
                    <option key={loc.code} value={loc.code}>{loc.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="pset-group">
            <div className="pset-group-head">{t('accent.head')}</div>
            <div className="pset-panel">
              <div className="pset-swatches">
                {PRESETS.map((p) => {
                  const active = (theme.accent ?? null) === p.accent;
                  return (
                    <button
                      key={p.nameKey}
                      className={`pset-swatch ${active ? 'active' : ''}`}
                      aria-pressed={active}
                      aria-label={t(p.nameKey)}
                      onClick={() => setTheme({ ...theme, accent: p.accent, accent2: p.accent2 })}
                    >
                      <span
                        className="pset-gem"
                        style={{
                          background: p.accent
                            ? `linear-gradient(135deg, ${p.accent}, ${p.accent2})`
                            : 'linear-gradient(135deg, var(--rose), var(--brass))',
                        }}
                      />
                      <span className="pset-swatch-name">{t(p.nameKey)}</span>
                    </button>
                  );
                })}
              </div>
              <div className="pset-custom">
                <span>{t('accent.custom')}</span>
                {/* <input type="color"> intentionally left as native — the color picker is a platform affordance */}
                <input
                  type="color"
                  value={theme.accent ?? '#e88aa6'}
                  onChange={(e) => setTheme({ ...theme, accent: e.target.value, accent2: e.target.value })}
                />
              </div>
            </div>
          </div>

          <div className="pset-group">
            <div className="pset-group-head">{t('wallpaper.head')}</div>
            <div className="pset-panel">
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
