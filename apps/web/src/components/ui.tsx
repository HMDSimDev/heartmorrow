import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { AsyncState } from '../lib/hooks';

export function Banner({ kind, children }: { kind: 'error' | 'ok' | 'info'; children: ReactNode }) {
  return <div className={`banner ${kind}`}>{children}</div>;
}

/** A centered, lamplit modal that escapes any backdrop-filter ancestor via a
 *  portal to <body>. Click-outside and Esc both dismiss. */
export function Modal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Styled replacement for window.confirm — never breaks the Nocturne illusion. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = false,
  kicker,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  kicker?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal onClose={onCancel}>
      <div className="kicker">{kicker ?? t('pleaseConfirm')}</div>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      {body && <p className="hint">{body}</p>}
      {/* Allow the actions to wrap (and stack) under a narrow width instead of
          ellipsizing long labels at ≤320px. */}
      <div className="row end" style={{ flexWrap: 'wrap' }}>
        <button className="btn ghost" onClick={onCancel} disabled={busy}>
          {cancelLabel ?? t('cancel')}
        </button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm} disabled={busy} autoFocus>
          {confirmLabel ?? t('confirm')}
        </button>
      </div>
    </Modal>
  );
}

export function Spinner() {
  return (
    <div className="row center" style={{ justifyContent: 'center', padding: 30 }}>
      <div className="spinner" />
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="big">{icon}</div>}
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** Generic async boundary: shows spinner/error or renders children with data. */
export function Loader<T>({
  state,
  children,
}: {
  state: AsyncState<T>;
  children: (data: T) => ReactNode;
}) {
  if (state.loading && state.data === undefined) return <Spinner />;
  if (state.error) return <Banner kind="error">{state.error}</Banner>;
  if (state.data === undefined) return <Spinner />;
  return <>{children(state.data)}</>;
}

export function TagInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const { t: tr } = useTranslation();
  const [draft, setDraft] = useState('');
  const commit = () => {
    const v = draft.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft('');
  };
  return (
    <div>
      <div className="tags" style={{ marginBottom: value.length ? 8 : 0 }}>
        {value.map((tag) => (
          <span className="tag" key={tag}>
            {tag}
            <button type="button" onClick={() => onChange(value.filter((x) => x !== tag))} aria-label={tr('removeTag', { tag })}>
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        placeholder={placeholder ?? tr('tagPlaceholder')}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}
