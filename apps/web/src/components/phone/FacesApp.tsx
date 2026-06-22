import { useEffect, useState } from 'react';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import type { FeedPostView, ReactionKind } from '@dsim/shared';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import { relativeTime } from '../../i18n/labels';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Portrait } from '../Portrait';
import { Banner, Spinner } from '../ui';
import './phone-faces.css';

type PhoneKey = ParseKeys<'phone'>;

/** The reaction palette, in the order shown on a post.
 *  Glyphs use <Icon> (chrome); labels resolve from `faces.react.<kind>`. */
const REACTIONS: ReadonlyArray<{ kind: ReactionKind; icon: Parameters<typeof Icon>[0]['name'] }> = [
  { kind: 'like',  icon: 'reactLike'  },
  { kind: 'love',  icon: 'reactLove'  },
  { kind: 'laugh', icon: 'reactLaugh' },
  { kind: 'wow',   icon: 'reactWow'   },
  { kind: 'sad',   icon: 'reactSad'   },
  { kind: 'angry', icon: 'reactAngry' },
];

const REACTION_ICON: Record<ReactionKind, Parameters<typeof Icon>[0]['name']> = {
  like:  'reactLike',
  love:  'reactLove',
  laugh: 'reactLaugh',
  wow:   'reactWow',
  sad:   'reactSad',
  angry: 'reactAngry',
};

/** Posts that aren't plain statuses get a tinted label + edge to set the mood. */
const KIND_HINT: Partial<Record<FeedPostView['kind'], { labelKey: PhoneKey; tone: string }>> = {
  jealousy:  { labelKey: 'faces.kind.jealousy',  tone: 'rose' },
  breakup:   { labelKey: 'faces.kind.breakup',   tone: 'rose' },
  reconcile: { labelKey: 'faces.kind.reconcile', tone: 'sage' },
  milestone: { labelKey: 'faces.kind.milestone', tone: 'brass' },
  life:      { labelKey: 'faces.kind.life',      tone: 'moon' },
};

export function FacesApp() {
  const { t } = useTranslation(['phone', 'common']);
  const { activeWorldId, dayTick } = useAppData();
  const [loading, setLoading] = useState(true);
  const [posts, setPosts] = useState<FeedPostView[]>([]);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    if (!activeWorldId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .facesFeed(activeWorldId)
      .then((feed) => {
        if (!cancelled) setPosts(feed.posts);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    // Mark the feed seen so the home-screen badge clears.
    void api.facesSeen(activeWorldId).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeWorldId, dayTick]);

  /** Replace one post in the timeline with its updated copy (from react/comment). */
  const replacePost = (updated: FeedPostView) =>
    setPosts((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));

  const submitPost = async () => {
    const body = draft.trim();
    if (!body || posting || !activeWorldId) return;
    setPosting(true);
    setError(undefined);
    try {
      const res = await api.facesPost(body, activeWorldId);
      setPosts((prev) => [res.post, ...prev]);
      setDraft('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="phone-app">
      <PhoneAppBar title={t('faces.title')} kicker={t('faces.kicker')} icon="faces" />

      {!activeWorldId ? (
        <div className="fcs-empty">
          <span className="fcs-empty-icon"><Icon name="faces" size={32} /></span>
          <span className="fcs-empty-title">{t('faces.noWorldTitle')}</span>
          <p>{t('faces.noWorldBody')}</p>
        </div>
      ) : (
        <div className="fcs-scroll">
          {error && <Banner kind="error">{error}</Banner>}

          <div className="fcs-compose">
            <textarea
              className="fcs-compose-input"
              value={draft}
              placeholder={t('faces.composePlaceholder')}
              rows={2}
              maxLength={500}
              onChange={(e) => setDraft(e.target.value)}
              disabled={posting}
            />
            <div className="fcs-compose-foot">
              <span className={`fcs-compose-count${draft.length > 450 ? ' is-near' : ''}`} aria-hidden="true">
                {draft.length}/500
              </span>
              <button
                className="btn primary sm fcs-post-btn"
                onClick={submitPost}
                disabled={posting || !draft.trim()}
              >
                {posting ? t('faces.posting') : t('faces.post')}
              </button>
            </div>
          </div>

          {loading ? (
            <Spinner />
          ) : posts.length === 0 ? (
            <div className="fcs-empty">
              <span className="fcs-empty-icon"><Icon name="moon" size={32} /></span>
              <span className="fcs-empty-title">{t('faces.emptyTitle')}</span>
              <p>{t('faces.emptyBody')}</p>
            </div>
          ) : (
            <div className="fcs-feed">
              {posts.map((post) => (
                <PostCard key={post.id} post={post} onUpdate={replacePost} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PostCard({
  post,
  onUpdate,
}: {
  post: FeedPostView;
  onUpdate: (updated: FeedPostView) => void;
}) {
  const { t } = useTranslation(['phone', 'common']);
  const [busy, setBusy] = useState(false);
  const hint = KIND_HINT[post.kind];
  const isNpc = post.authorType === 'character';

  const react = async (kind: ReactionKind) => {
    if (busy) return;
    setBusy(true);
    try {
      onUpdate(await api.facesReact(post.id, kind));
    } catch {
      /* reactions are narrative-only; a failed tap is harmless */
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`ph-rise fcs-card${hint ? ` fcs-tone-${hint.tone}` : ''}`}>
      <header className="fcs-card-head">
        <span className="fcs-ava">
          <Portrait
            character={{ name: post.authorName, portraitAssetId: post.portraitAssetId, expressionAssets: {} }}
            className="round"
          />
        </span>
        <span className="fcs-head-meta">
          <span className="fcs-author">{post.authorName}</span>
          <span className="fcs-sub">
            {post.dayNumber != null ? t('faces.day', { day: post.dayNumber }) : relativeTime(post.createdAt)}
            {hint && <span className={`fcs-kind fcs-kind-${hint.tone}`}>{t(hint.labelKey)}</span>}
          </span>
        </span>
      </header>

      <p className="fcs-body">{post.body}</p>
      {post.mood && <div className="fcs-mood">— {post.mood}</div>}

      <ReactionSummary post={post} />

      <div className="fcs-react-bar">
        {REACTIONS.map((r) => (
          <button
            key={r.kind}
            className={`fcs-react${post.playerReaction === r.kind ? ' is-on' : ''}`}
            onClick={() => react(r.kind)}
            disabled={busy}
            title={t(`faces.react.${r.kind}`)}
            aria-label={t(`faces.react.${r.kind}`)}
            aria-pressed={post.playerReaction === r.kind}
          >
            <Icon name={r.icon} size={18} />
          </button>
        ))}
      </div>

      <CommentList post={post} onUpdate={onUpdate} allowComment={isNpc} />
    </article>
  );
}

function ReactionSummary({ post }: { post: FeedPostView }) {
  const { t } = useTranslation(['phone', 'common']);
  const live = post.reactions.filter((r) => r.count > 0);
  if (live.length === 0) return null;
  const names = live
    .flatMap((r) => r.actorNames)
    .filter(Boolean)
    .slice(0, 3);
  const total = live.reduce((sum, r) => sum + r.count, 0);
  return (
    <div className="fcs-react-summary">
      <span className="fcs-react-glyphs">
        {live.map((r) => (
          <span key={r.kind} className="fcs-react-glyph">
            <Icon name={REACTION_ICON[r.kind]} size={14} />
          </span>
        ))}
      </span>
      <span className="fcs-react-names">
        {names.length > 0
          ? total > names.length
            ? t('faces.andMore', { names: names.join(', '), count: total - names.length })
            : names.join(', ')
          : total}
      </span>
    </div>
  );
}

function CommentList({
  post,
  onUpdate,
  allowComment,
}: {
  post: FeedPostView;
  onUpdate: (updated: FeedPostView) => void;
  allowComment: boolean;
}) {
  const { t } = useTranslation(['phone', 'common']);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const submit = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      onUpdate(await api.facesComment(post.id, body));
      setText('');
    } catch {
      /* narrative-only; a dropped comment is harmless */
    } finally {
      setSending(false);
    }
  };

  if (post.comments.length === 0 && !allowComment) return null;

  return (
    <div className="fcs-comments">
      {post.comments.map((c) => (
        <div className="fcs-comment" key={c.id}>
          <span className="fcs-comment-ava">
            <Portrait
              character={{ name: c.authorName, portraitAssetId: c.portraitAssetId, expressionAssets: {} }}
              className="round"
            />
          </span>
          <span className="fcs-comment-bubble">
            <span className="fcs-comment-name">{c.authorName}</span>
            <span className="fcs-comment-body">{c.body}</span>
            {c.tone && <span className="fcs-comment-tone">{c.tone}</span>}
          </span>
        </div>
      ))}
      {allowComment && (
        <div className="fcs-comment-compose">
          <input
            className="fcs-comment-input"
            value={text}
            placeholder={t('faces.addComment')}
            maxLength={400}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
            disabled={sending}
          />
          <button
            className="btn sm ghost fcs-comment-send"
            onClick={submit}
            disabled={sending || !text.trim()}
            aria-label={t('faces.comment')}
            title={t('faces.comment')}
          >
            <Icon name="send" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
