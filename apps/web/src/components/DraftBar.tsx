import { type DraftEnvelope, relativeTime } from '../lib/drafts';
import { Icon } from './Icon';

/* The "Unsaved draft" status pill — placed beside a Save button to show that
   in-progress work is being auto-kept. Reuses the shared `.badge.warn` (brass)
   so it reads as caution-but-not-error, with a softly breathing lamplight dot. */
export function UnsavedPill({ dirty, failed = false }: { dirty: boolean; failed?: boolean }) {
  if (!dirty) return null;
  // Storage full/disabled — stop promising the work is being kept.
  if (failed) {
    return (
      <span
        className="badge danger draft-pill"
        title="Couldn't auto-save this draft (storage full). Press Save to keep your work."
      >
        <span className="draft-pill-dot" aria-hidden />
        Draft not saved
      </span>
    );
  }
  return (
    <span className="badge warn draft-pill" title="Your changes are auto-kept as a draft until you press Save.">
      <span className="draft-pill-dot" aria-hidden />
      Unsaved draft
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
  const when = relativeTime(env.updatedAt);
  const name = env.label.trim();
  const titled = name ? `“${name}”` : `this ${noun}`;
  return (
    <div className="draft-bar" role="region" aria-label="Restore unsaved draft">
      <span className="draft-bar-mark" aria-hidden>
        <Icon name="recap" size={16} />
      </span>
      <div className="draft-bar-text">
        <strong>{env.isNew ? `Unsaved ${noun} draft` : 'Unsaved changes'}</strong>
        <span className="draft-bar-detail">
          {env.isNew
            ? `You started ${name ? titled : `a new ${noun}`} ${when} but never saved it.`
            : `You were editing ${titled} ${when} — those changes were never saved.`}
        </span>
      </div>
      <div className="draft-bar-actions">
        <button className="btn sm primary" onClick={onRestore}>
          <Icon name="recap" size={13} />
          Restore
        </button>
        <button className="btn sm ghost" onClick={onDiscard}>
          Discard draft
        </button>
        <button className="btn sm ghost draft-bar-x" onClick={onDismiss} aria-label="Dismiss">
          <Icon name="close" size={13} />
        </button>
      </div>
    </div>
  );
}
