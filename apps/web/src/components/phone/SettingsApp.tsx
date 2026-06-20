import { useRef, useState } from 'react';
import { useAppData } from '../../state/app-context';
import { errorMessage } from '../../lib/hooks';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Banner, ConfirmDialog } from '../ui';
import '../../pages/settings.page.css';

const PRESETS: Array<{ name: string; accent: string | null; accent2: string | null }> = [
  { name: 'Rose (default)', accent: null, accent2: null },
  { name: 'Brass', accent: '#e6b15e', accent2: '#d98a3c' },
  { name: 'Moonlight', accent: '#9db8de', accent2: '#6f8fd0' },
  { name: 'Sage', accent: '#8fcf9f', accent2: '#4fa97e' },
  { name: 'Ember', accent: '#e07a82', accent2: '#b23d52' },
  { name: 'Plum', accent: '#b58bd6', accent2: '#e88aa6' },
];

const MAX_WALLPAPER_BYTES = 1.5 * 1024 * 1024;

export function SettingsApp() {
  const { theme, setTheme, creatorMode, setCreatorMode, resetProgress } = useAppData();
  const [note, setNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onWallpaper = (file: File) => {
    setError(undefined);
    if (file.size > MAX_WALLPAPER_BYTES) {
      setError('Image too large — pick one under 1.5 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setTheme({ ...theme, wallpaper: String(reader.result) });
        setNote('Wallpaper set.');
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
      setNote('Progress reset. Back to Day 1.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="phone-app">
      <PhoneAppBar title="Settings" icon="settings" />
      <div className="phone-embed">
        {note && <Banner kind="ok">{note}</Banner>}
        {error && <Banner kind="error">{error}</Banner>}

        {confirmReset && (
          <ConfirmDialog
            kicker="Danger zone"
            title="Total reset"
            body="Erase ALL progress (relationships, memories, texts, money, day) and start over at Day 1? Your created characters and worlds are kept."
            confirmLabel="Reset everything"
            danger
            busy={resetting}
            onConfirm={() => { void totalReset(); }}
            onCancel={() => setConfirmReset(false)}
          />
        )}

        <div className="pset-list">
          <div className="pset-group">
            <div className="pset-group-head">Accent color</div>
            <div className="pset-panel">
              <div className="pset-swatches">
                {PRESETS.map((p) => {
                  const active = (theme.accent ?? null) === p.accent;
                  return (
                    <button
                      key={p.name}
                      className={`pset-swatch ${active ? 'active' : ''}`}
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
                      <span className="pset-swatch-name">{p.name}</span>
                    </button>
                  );
                })}
              </div>
              <div className="pset-custom">
                <span>Custom tint</span>
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
            <div className="pset-group-head">Wallpaper</div>
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
                    <Icon name="upload" size={14} /> Choose image
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
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="pset-group">
            <div className="pset-group-head">Mode</div>
            <div className="pset-panel">
              <p className="pset-hint" style={{ marginBottom: 10 }}>
                Play mode hides creation/editing tools so you can just play. Creator mode shows them.
              </p>
              <div className="row">
                <button className={`btn sm ${!creatorMode ? 'primary' : ''}`} onClick={() => setCreatorMode(false)}>
                  <Icon name="play" size={14} /> Play mode
                </button>
                <button className={`btn sm ${creatorMode ? 'primary' : ''}`} onClick={() => setCreatorMode(true)}>
                  <Icon name="settings" size={14} /> Creator mode
                </button>
              </div>
            </div>
          </div>

          <div className="pset-danger">
            <div className="pset-group-head">Danger zone</div>
            <p className="pset-hint" style={{ margin: '8px 0 10px' }}>
              Erase all progress and start fresh. Your created characters and worlds are kept.
            </p>
            <button className="btn sm danger" onClick={() => setConfirmReset(true)} disabled={resetting}>
              <Icon name="trash" size={14} /> {resetting ? 'Resetting…' : 'Total reset (back to Day 1)'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
