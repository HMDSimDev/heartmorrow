import { useCallback, useEffect, useState } from 'react';
import './phone-comms.css';
import type { Email } from '@dsim/shared';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Banner, Spinner } from '../ui';

function senderInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

/** Show "Day N" when available; fall back to a short date from the timestamp. */
function emailWhen(e: Email): string | null {
  if (e.dayNumber != null) return `Day ${e.dayNumber}`;
  const ts = e.deliveredAt ?? e.createdAt;
  if (!ts) return null;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function EmailApp() {
  const { activeWorldId, dayTick } = useAppData();
  const [emails, setEmails] = useState<Email[]>([]);
  const [open, setOpen] = useState<Email | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setEmails(await api.phoneEmails(activeWorldId ?? undefined));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [activeWorldId, dayTick]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEmail = async (email: Email) => {
    setOpen(email);
    if (!email.read) {
      try {
        await api.phoneReadEmail(email.id);
        setEmails((prev) => prev.map((e) => (e.id === email.id ? { ...e, read: true } : e)));
      } catch {
        /* ignore */
      }
    }
  };

  if (open) {
    const when = emailWhen(open);
    return (
      <div className="phone-app">
        <PhoneAppBar
          title={open.senderName}
          kicker="Reading"
          icon="mail"
          left={
            <button className="btn sm ghost pbar-iconbtn" onClick={() => setOpen(null)} aria-label="Back to inbox" title="Inbox">
              <Icon name="chevronDown" size={18} />
            </button>
          }
        />
        <div className="pcom-reader">
          <h2 className="pcom-reader-subject">{open.subject}</h2>
          <div className="pcom-reader-from">
            <span className="pcom-reader-seal">{senderInitial(open.senderName)}</span>
            <span className="pcom-reader-meta">
              <span className="pcom-reader-sendername">{open.senderName}</span>
              <span className="pcom-reader-handle">{open.senderHandle}</span>
            </span>
            {when && <span className="pcom-when pcom-reader-when">{when}</span>}
          </div>
          <p className="pcom-reader-body">{open.body}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="phone-app">
      <PhoneAppBar
        title="Inbox"
        kicker="Mail"
        icon="mail"
        right={
          <button className="btn sm ghost pbar-iconbtn" onClick={load} aria-label="Refresh" title="Refresh">
            <Icon name="refresh" size={18} />
          </button>
        }
      />
      {error && <Banner kind="error">{error}</Banner>}
      {loading ? (
        <Spinner />
      ) : emails.length === 0 ? (
        <div className="pcom-empty">
          <span className="pcom-empty-icon"><Icon name="mail" size={32} /></span>
          <span className="pcom-empty-title">No mail yet</span>
          <p>In-world letters and notices arrive as the days pass.</p>
        </div>
      ) : (
        <div className="pcom-rows">
          {emails.map((e) => {
            const when = emailWhen(e);
            return (
              <button
                key={e.id}
                className={`pcom-mail-row ${e.read ? '' : 'pcom-unread'}`}
                onClick={() => openEmail(e)}
              >
                {!e.read && <span className="pcom-mail-dot" />}
                <span className="pcom-mail-top">
                  <span className="pcom-mail-sender">{e.senderName}</span>
                  {when && <span className="pcom-when">{when}</span>}
                </span>
                <span className="pcom-mail-subject">{e.subject}</span>
                <span className="pcom-mail-snippet">{e.body}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
