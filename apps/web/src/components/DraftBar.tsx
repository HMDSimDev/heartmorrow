import { useTranslation } from 'react-i18next';
import { type DraftEnvelope } from '../lib/drafts';
import { relativeTime } from '../i18n/labels';
import { Icon } from './Icon';

/* The "Unsaved draft" status pill — placed beside a Save button to show that
   in-progress work is being auto-kept. Reuses the shared `.badge.warn` (brass)
   so it reads as caution-but-not-error, with a softly breathing lamplight dot. */
export function UnsavedPill({ dirty, failed = false }: { dirty: boolean; failed?: boolean }) {
  const { t } = useTranslation();
  if (!dirty) return null;
  // Storage full/disabled — stop promising the work is being kept.
  if (failed) {
    return (
      <span
        className="badge danger draft-pill"
        title={t('draft.notSavedTitle')}
      >
        <span className="draft-pill-dot" aria-hidden />
        {t('draft.notSaved')}
      </span>
    );
  }
  return (
    <span className="badge warn draft-pill" title={t('draft.autoKeptTitle')}>
      <span className="draft-pill-dot" aria-hidden />
      {t('draft.unsaved')}
    </span>
  );
}

/* A dismissible bar offering to restore a previously-abandoned draft. We always
   *offer* (never silently apply) — distinct copy for a brand-new record (the
   draft is the whole thing) vs unsaved edits to an existing one (the draft
   diverges from what's saved). */
export function DraftRestoreBar({
  env,
  noun,
  onRestore,
  onDiscard,
  onDismiss,
}: {
  env: DraftEnvelope;
  /** What kind of thing this is, for the copy: 'character', 'world', 'new world'. */
  noun: string;
  onRestore: () => void;
  onDiscard: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const when = relativeTime(env.updatedAt);
  const name = env.label.trim();
  const titled = name ? `“${name}”` : t('draft.thisNoun', { noun });
  return (
    <div className="draft-bar" role="region" aria-label={t('draft.restoreAria')}>
      <span className="draft-bar-mark" aria-hidden>
        <Icon name="recap" size={16} />
      </span>
      <div className="draft-bar-text">
        <strong>{env.isNew ? t('draft.unsavedNounDraft', { noun }) : t('draft.unsavedChanges')}</strong>
        <span className="draft-bar-detail">
          {env.isNew
            ? name
              ? t('draft.startedNamed', { titled, when })
              : t('draft.startedNew', { noun, when })
            : t('draft.wereEditing', { titled, when })}
        </span>
      </div>
      <div className="draft-bar-actions">
        <button className="btn sm primary" onClick={onRestore}>
          <Icon name="recap" size={13} />
          {t('draft.restore')}
        </button>
        <button className="btn sm ghost" onClick={onDiscard}>
          {t('draft.discardDraft')}
        </button>
        <button className="btn sm ghost draft-bar-x" onClick={onDismiss} aria-label={t('draft.dismiss')}>
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>
  );
}
