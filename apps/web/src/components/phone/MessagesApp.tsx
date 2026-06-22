import { Fragment, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './phone-comms.css';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_IMAGE_LABEL,
  IMAGE_UPLOAD_ACCEPT,
  isGiftableItem,
  type Character,
  type InventoryItem,
  type LandlordNotice,
  type ShopItem,
  type TextMessage,
} from '@dsim/shared';
import { api, assetUrl } from '../../lib/api';
import { downscaleImageFile } from '../../lib/image';
import { errorMessage } from '../../lib/hooks';
import { useAppData } from '../../state/app-context';
import { Icon } from '../Icon';
import { PhoneAppBar } from './PhoneAppBar';
import { Portrait } from '../Portrait';
import { Banner, Spinner } from '../ui';

type View =
  | { kind: 'list' }
  | { kind: 'thread'; characterId: string }
  | { kind: 'new' }
  | { kind: 'landlord' };

export function MessagesApp() {
  const [view, setView] = useState<View>({ kind: 'list' });
  if (view.kind === 'thread') {
    return <ThreadView characterId={view.characterId} onBack={() => setView({ kind: 'list' })} />;
  }
  if (view.kind === 'new') {
    return <NewMessage onPick={(id) => setView({ kind: 'thread', characterId: id })} onBack={() => setView({ kind: 'list' })} />;
  }
  if (view.kind === 'landlord') {
    return <LandlordView onBack={() => setView({ kind: 'list' })} />;
  }
  return (
    <ThreadList
      onOpen={(id) => setView({ kind: 'thread', characterId: id })}
      onNew={() => setView({ kind: 'new' })}
      onLandlord={() => setView({ kind: 'landlord' })}
    />
  );
}

// ——— Landlord Notice view ————————————————————————————————————————————————

function LandlordView({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation(['phone', 'common']);
  const { activeWorldId, refreshInbox } = useAppData();
  const [notices, setNotices] = useState<LandlordNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!activeWorldId) return;
    let live = true;
    api
      .landlordNotices(activeWorldId)
      .then(async (res) => {
        if (!live) return;
        setNotices(res.notices);
        // Mark read and sync the global inbox badge.
        await api.markLandlordRead(activeWorldId);
        await refreshInbox();
      })
      .catch((e) => live && setError(errorMessage(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [activeWorldId, refreshInbox]);

  return (
    <div className="phone-app">
      <PhoneAppBar
        title={t('messages.landlord.title')}
        kicker={t('messages.landlord.notices')}
        icon="property"
        left={
          <button className="btn sm ghost pbar-iconbtn" onClick={onBack} aria-label={t('common:back')} title={t('common:back')}>
            <Icon name="chevronDown" size={18} />
          </button>
        }
      />
      {error && <Banner kind="error">{error}</Banner>}
      {loading ? (
        <Spinner />
      ) : notices.length === 0 ? (
        <div className="pcom-empty">
          <span className="pcom-empty-icon"><Icon name="property" size={32} /></span>
          <span className="pcom-empty-title">{t('messages.landlord.emptyTitle')}</span>
          <p>{t('messages.landlord.emptyBody')}</p>
        </div>
      ) : (
        <div className="pcom-thread lnd-thread">
          {notices.map((n) => (
            <div key={n.id} className={`pcom-msg character lnd-notice${n.kind === 'eviction' ? ' lnd-eviction' : ''}`}>
              <div className="lnd-notice-header">
                <span className="lnd-notice-kind">
                  <Icon name="warn" size={12} />
                  {n.kind === 'eviction' ? t('messages.landlord.eviction') : t('messages.landlord.overdue')}
                </span>
                <span className="lnd-notice-day">{t('messages.day', { day: n.dayNumber })}</span>
              </div>
              <div className="pcom-bubble lnd-bubble">{n.body}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ——— Thread list ——————————————————————————————————————————————————————————

function ThreadList({
  onOpen,
  onNew,
  onLandlord,
}: {
  onOpen: (id: string) => void;
  onNew: () => void;
  onLandlord: () => void;
}) {
  const { t, i18n } = useTranslation(['phone', 'common']);
  const { activeWorldId, activeWorld, dayTick } = useAppData();
  const [loading, setLoading] = useState(true);
  const [threads, setThreads] = useState<Awaited<ReturnType<typeof api.phoneThreads>>>([]);
  const [landlordUnread, setLandlordUnread] = useState(0);
  const [landlordPreview, setLandlordPreview] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const propertyEnabled = !!activeWorld?.featureFlags?.property;

  // Re-keyed on dayTick so DND moons + unread counts refresh after End day.
  useEffect(() => {
    let live = true;
    api
      .phoneThreads(activeWorldId ?? undefined)
      .then((t) => live && setThreads(t))
      .catch((e) => live && setError(errorMessage(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [activeWorldId, dayTick]);

  // Fetch landlord notices separately — only when feature is enabled.
  useEffect(() => {
    if (!activeWorldId || !propertyEnabled) {
      setLandlordUnread(0);
      setLandlordPreview(null);
      return;
    }
    let live = true;
    api
      .landlordNotices(activeWorldId)
      .then((res) => {
        if (!live) return;
        setLandlordUnread(res.unread);
        const latest = res.notices[0];
        setLandlordPreview(latest ? latest.body.split('\n')[0] ?? null : null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [activeWorldId, propertyEnabled, dayTick]);

  const hasLandlordNotices = propertyEnabled && (landlordUnread > 0 || landlordPreview !== null);

  return (
    <div className="phone-app">
      <PhoneAppBar
        title={t('messages.title')}
        kicker={t('messages.inbox')}
        icon="messages"
        right={
          <button className="btn sm ghost pbar-iconbtn" onClick={onNew} aria-label={t('messages.newMessage')} title={t('messages.newMessage')}>
            <Icon name="edit" size={18} />
          </button>
        }
      />
      {error && <Banner kind="error">{error}</Banner>}
      {loading ? (
        <Spinner />
      ) : threads.length === 0 && !hasLandlordNotices ? (
        <div className="pcom-empty">
          <span className="pcom-empty-icon"><Icon name="messages" size={32} /></span>
          <span className="pcom-empty-title">{t('messages.list.emptyTitle')}</span>
          <p>{t('messages.list.emptyBody')}</p>
        </div>
      ) : (
        <div className="pcom-rows">
          {/* Pinned landlord notices row — always first when present */}
          {hasLandlordNotices && (
            <button
              className={`pcom-row lnd-row${landlordUnread > 0 ? ' pcom-unread lnd-unread' : ''}`}
              onClick={onLandlord}
            >
              <span className="pcom-ava lnd-ava">
                <span className="lnd-ava-icon">
                  <Icon name="property" size={20} />
                </span>
                {landlordUnread > 0 && <span className="pcom-count">{landlordUnread}</span>}
              </span>
              <span className="pcom-body">
                <span className="pcom-toprow">
                  <span className="pcom-name lnd-name">
                    <Icon name="warn" size={12} />
                    {' '}{t('messages.landlord.title')}
                  </span>
                </span>
                {landlordPreview && (
                  <span className="pcom-preview lnd-preview">{landlordPreview}</span>
                )}
              </span>
            </button>
          )}

          {threads.map((th) => (
            <button
              key={th.characterId}
              className={`ph-rise pcom-row ${th.unread > 0 ? 'pcom-unread' : ''}`}
              onClick={() => onOpen(th.characterId)}
            >
              <span className="pcom-ava">
                <Portrait
                  character={{ name: th.characterName, portraitAssetId: th.portraitAssetId, expressionAssets: {} }}
                  className="round"
                />
                {th.unread > 0 && <span className="pcom-count">{th.unread}</span>}
                {!th.available && <span className="pcom-dnd" title={t('messages.unavailableToday')}><Icon name="moon" size={11} /></span>}
              </span>
              <span className="pcom-body">
                <span className="pcom-toprow">
                  <span className="pcom-name">{th.characterName}</span>
                  {th.lastAt != null && <span className="pcom-when">{new Date(th.lastAt).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })}</span>}
                </span>
                {!th.available ? (
                  <span className="pcom-preview">{th.unavailableReason ?? t('messages.isUnavailableToday')}</span>
                ) : th.lastBody ? (
                  <span className="pcom-preview">
                    {th.lastFromPlayer && <span className="pcom-preview-you">{t('messages.list.you')}</span>}
                    {th.lastBody}
                  </span>
                ) : (
                  <span className="pcom-preview pcom-preview-empty">{t('messages.list.tapToStart')}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NewMessage({ onPick, onBack }: { onPick: (id: string) => void; onBack: () => void }) {
  const { t } = useTranslation(['phone', 'common']);
  const { activeWorldId, dayTick } = useAppData();
  const [contacts, setContacts] = useState<
    Array<{ id: string; name: string; portraitAssetId: string | null; available: boolean; unavailableReason: string | null }>
  >([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    api
      .phoneContacts(activeWorldId ?? undefined)
      .then((c) => live && setContacts(c))
      .catch(() => undefined)
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [activeWorldId, dayTick]);
  return (
    <div className="phone-app">
      <PhoneAppBar
        title={t('messages.newMessage')}
        kicker={t('messages.to')}
        left={
          <button className="btn sm ghost pbar-iconbtn" onClick={onBack} aria-label={t('common:back')} title={t('common:back')}>
            <Icon name="chevronDown" size={18} />
          </button>
        }
      />
      {loading ? (
        <Spinner />
      ) : contacts.length === 0 ? (
        <div className="pcom-empty">
          <span className="pcom-empty-icon"><Icon name="people" size={32} /></span>
          <span className="pcom-empty-title">{t('messages.new.emptyTitle')}</span>
          <p>{t('messages.new.emptyBody')}</p>
        </div>
      ) : (
        <div className="pcom-rows">
          <div className="pcom-pick-head">{t('messages.new.chooseSomeone')}</div>
          {contacts.map((c) => (
            <button
              key={c.id}
              className={`pcom-row ${c.available ? '' : 'pcom-row-busy'}`}
              onClick={() => onPick(c.id)}
            >
              <span className="pcom-ava">
                <Portrait
                  character={{ name: c.name, portraitAssetId: c.portraitAssetId, expressionAssets: {} }}
                  className="round"
                />
                {!c.available && <span className="pcom-dnd" title={t('messages.unavailableToday')}><Icon name="moon" size={11} /></span>}
              </span>
              <span className="pcom-body">
                <span className="pcom-name">{c.name}</span>
                {!c.available && (
                  <span className="pcom-busy">{c.unavailableReason ?? t('messages.isUnavailableToday')}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadView({ characterId, onBack }: { characterId: string; onBack: () => void }) {
  const { t } = useTranslation(['phone', 'common']);
  const { reloadPlayer, refreshInbox, assets, reloadAssets, dayTick } = useAppData();
  const [character, setCharacter] = useState<Character | null>(null);
  const [availability, setAvailability] = useState<{ available: boolean; reason: string | null }>({
    available: true,
    reason: null,
  });
  const [messages, setMessages] = useState<TextMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [feeling, setFeeling] = useState<{ text: string; warm: boolean } | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  // A downscaled photo staged to send with the next text (uploaded already so the
  // asset exists; the vision model reads it server-side).
  const [pendingImage, setPendingImage] = useState<{ assetId: string; url: string } | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  // A held item staged to send as a gift with the next text, plus the open/options
  // state of the gift picker (gifts now come from a date or a text, not the bag).
  const [giftOpen, setGiftOpen] = useState(false);
  const [giftItems, setGiftItems] = useState<Array<{ inventoryItem: InventoryItem; item: ShopItem }>>([]);
  const [pendingGift, setPendingGift] = useState<{ inventoryItem: InventoryItem; item: ShopItem } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const data = await api.phoneThread(characterId);
      setCharacter(data.character);
      setAvailability({ available: data.available, reason: data.unavailableReason });
      setMessages(data.messages);
      void refreshInbox(); // opening the thread zeroed unread server-side; sync the badge
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId, dayTick]);

  // A staged gift / open picker belongs to the character you were texting — drop it
  // when the thread switches so you can't carry one person's gift into another's.
  useEffect(() => {
    setGiftOpen(false);
    setGiftItems([]);
    setPendingGift(null);
  }, [characterId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // Downscale (max ~512px tall) in the browser, then upload — so the stored asset
  // and the image the vision model reads are both small + fast.
  const attachImage = async (file: File) => {
    setError(undefined);
    // Validate the ORIGINAL file (before downscaling, which would re-encode a
    // large image to JPEG) so an unsupported type is always rejected, regardless
    // of its size — the vision model can only read these formats.
    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
      setError(t('messages.thread.unsupportedImage', { label: ALLOWED_IMAGE_LABEL }));
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    setUploadingImage(true);
    try {
      const resized = await downscaleImageFile(file);
      const asset = await api.uploadAsset(resized, 'other', '', '');
      await reloadAssets(); // so the thumbnail resolves from context after sending
      setPendingImage({ assetId: asset.id, url: assetUrl(asset.path) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setUploadingImage(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // Load the player's held GIFTABLE items (per the character's world) into the
  // picker. Toggles closed if already open.
  const openGiftMenu = async () => {
    if (giftOpen) {
      setGiftOpen(false);
      return;
    }
    setGiftOpen(true);
    try {
      const inv = await api.getInventory(character?.worldId ?? undefined);
      setGiftItems(
        inv.entries.filter(
          (e): e is { inventoryItem: InventoryItem; item: ShopItem } =>
            !!e.item && e.inventoryItem.quantity > 0 && isGiftableItem(e.item),
        ),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const send = async () => {
    const text = input.trim();
    const image = pendingImage;
    const gift = pendingGift;
    if ((!text && !image && !gift) || sending || uploadingImage) return;
    // Defensive: the compose box is disabled when unavailable, but never POST a
    // text the server will reject (it 400s for a busy character).
    if (!availability.available) return;
    setInput('');
    setPendingImage(null);
    setPendingGift(null);
    setGiftOpen(false);
    setSending(true);
    setError(undefined);
    // Show the player's message immediately (reconciled by load() afterward).
    const optimistic: TextMessage = {
      id: `opt-${Date.now()}`,
      threadId: '',
      sender: 'player',
      body: text,
      status: 'delivered',
      dayNumber: messages[messages.length - 1]?.dayNumber ?? null,
      scheduledPhase: null,
      attachment: gift ? { shopItemId: gift.item.id, name: gift.item.name, claimed: true } : null,
      imageAssetId: image?.assetId ?? null,
      deliveredAt: Date.now(),
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const res = await api.phoneSend(characterId, text, image?.assetId ?? null, gift?.inventoryItem.id ?? null);
      await load();
      // A gift was consumed from the bag — keep the held-money/inventory in sync.
      if (gift) await reloadPlayer();
      if (res.error) setError(t('messages.thread.noReply', { error: res.error }));
      // Subtle cue that the exchange shifted how they feel.
      const d = res.relationshipDelta ?? {};
      const net =
        (d.affection ?? 0) + (d.comfort ?? 0) + (d.chemistry ?? 0) + (d.trust ?? 0) + (d.respect ?? 0) - (d.tension ?? 0);
      if (net !== 0) {
        setFeeling({ text: net > 0 ? t('messages.thread.warmer') : t('messages.thread.cooler'), warm: net > 0 });
        setTimeout(() => setFeeling(null), 2200);
      }
    } catch (e) {
      setError(errorMessage(e));
      await load(); // drop the optimistic bubble if the send failed
    } finally {
      setSending(false);
    }
  };

  const dayLabel = (m: TextMessage) => (m.dayNumber != null ? t('messages.day', { day: m.dayNumber }) : t('messages.earlier'));

  const claim = async (textId: string) => {
    if (claimingId) return; // a tap is in flight — don't double-claim the gift
    setClaimingId(textId);
    try {
      await api.phoneClaimGift(textId);
      await Promise.all([load(), reloadPlayer()]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setClaimingId(null);
    }
  };

  return (
    <div className="phone-app">
      <PhoneAppBar
        title={character?.name ?? t('messages.title')}
        kicker={t('messages.texting')}
        left={
          <button className="btn sm ghost pbar-iconbtn" onClick={onBack} aria-label={t('common:back')} title={t('common:back')}>
            <Icon name="chevronDown" size={18} />
          </button>
        }
      />
      {error && <Banner kind="error">{error}</Banner>}
      <div className="pcom-thread">
        {messages.map((m, i) => {
          const label = dayLabel(m);
          // Don't show a divider for the in-flight optimistic bubble (it has no
          // real day yet); load() reconciles it a moment later.
          const isOptimistic = m.id.startsWith('opt-');
          const showDivider = !isOptimistic && (i === 0 || label !== dayLabel(messages[i - 1]!));
          const imgAsset = m.imageAssetId ? assets.find((a) => a.id === m.imageAssetId) : null;
          const imgSrc = imgAsset ? assetUrl(imgAsset.path) : null;
          return (
            <Fragment key={m.id}>
              {showDivider && <div className="pcom-day">{label}</div>}
              <div className={`pcom-msg ${m.sender}`}>
                {imgSrc && (
                  <a className="pcom-image-link" href={imgSrc} target="_blank" rel="noreferrer" title={t('messages.thread.openFullSize')}>
                    <img className="pcom-image" src={imgSrc} alt={t('messages.thread.sentPhoto')} loading="lazy" />
                  </a>
                )}
                {m.body && <div className="pcom-bubble">{m.body}</div>}
                {/* NPC-sent gift: claimable. */}
                {m.attachment && m.sender === 'character' && (
                  <button className="pcom-gift" disabled={m.attachment.claimed || claimingId !== null} onClick={() => claim(m.id)}>
                    <span className="pcom-gift-icon"><Icon name="gift" size={20} /></span>
                    <span className="pcom-gift-text">
                      <span className="pcom-gift-label">{m.attachment.claimed ? t('messages.thread.kept') : t('messages.thread.giftForYou')}</span>
                      <span className="pcom-gift-name">
                        {m.attachment.claimed ? m.attachment.name : t('messages.thread.accept', { name: m.attachment.name })}
                      </span>
                    </span>
                  </button>
                )}
                {/* Player-sent gift: a non-interactive "sent" badge. */}
                {m.attachment && m.sender === 'player' && (
                  <div className="pcom-gift pcom-gift-sent">
                    <span className="pcom-gift-icon"><Icon name="gift" size={20} /></span>
                    <span className="pcom-gift-text">
                      <span className="pcom-gift-label">{t('messages.thread.giftSent')}</span>
                      <span className="pcom-gift-name">{m.attachment.name}</span>
                    </span>
                  </div>
                )}
              </div>
            </Fragment>
          );
        })}
        {sending && (
          <div className="pcom-msg character">
            <div className="pcom-bubble">
              <span className="typing">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {feeling && <div className={`pcom-feeling ${feeling.warm ? 'is-warm' : 'is-cool'}`}>{feeling.text}</div>}
      {pendingImage && (
        <div className="pcom-attach">
          <img className="pcom-attach-thumb" src={pendingImage.url} alt={t('messages.thread.attachmentPreview')} />
          <span className="pcom-attach-label">{t('messages.thread.photoReady')}</span>
          <button
            className="pcom-attach-remove"
            onClick={() => setPendingImage(null)}
            aria-label={t('messages.thread.removeImage')}
            title={t('messages.thread.removeImage')}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {pendingGift && (
        <div className="pcom-attach">
          <span className="pcom-attach-gifticon"><Icon name="gift" size={16} /></span>
          <span className="pcom-attach-label">{t('messages.thread.giftStaged', { name: pendingGift.item.name })}</span>
          <button
            className="pcom-attach-remove"
            onClick={() => setPendingGift(null)}
            aria-label={t('messages.thread.removeGift')}
            title={t('messages.thread.removeGift')}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {giftOpen && (
        <div className="pcom-giftmenu">
          {giftItems.length === 0 ? (
            <p className="muted pcom-giftmenu-empty">{t('messages.thread.giftMenuEmpty')}</p>
          ) : (
            giftItems.map((e) => (
              <button key={e.inventoryItem.id} className="pcom-giftmenu-item" onClick={() => { setPendingGift(e); setGiftOpen(false); }}>
                <span className="pcom-giftmenu-name">{e.item.name}</span>
                <span className="pcom-giftmenu-qty">×{e.inventoryItem.quantity}</span>
              </button>
            ))
          )}
        </div>
      )}
      {!availability.available && (
        <div className="pcom-dnd-bar">
          <Icon name="moon" size={14} />
          <span>
            {t('messages.thread.dndBar', {
              name: character?.name ?? t('messages.they'),
              reason: availability.reason ?? t('messages.isUnavailableToday'),
            })}
          </span>
        </div>
      )}
      <div className="pcom-compose">
        <input
          ref={fileRef}
          type="file"
          accept={IMAGE_UPLOAD_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void attachImage(f);
          }}
        />
        <button
          className="btn ghost sm pcom-attachbtn"
          onClick={() => fileRef.current?.click()}
          disabled={sending || uploadingImage || !availability.available}
          aria-label={t('messages.thread.attachPhoto')}
          title={t('messages.thread.attachPhoto')}
        >
          <Icon name={uploadingImage ? 'refresh' : 'image'} size={18} />
        </button>
        <button
          className={`btn ghost sm pcom-attachbtn${giftOpen || pendingGift ? ' pcom-attachbtn-on' : ''}`}
          onClick={() => void openGiftMenu()}
          disabled={sending || uploadingImage || !availability.available}
          aria-label={t('messages.thread.sendGift')}
          title={t('messages.thread.sendGift')}
        >
          <Icon name="gift" size={18} />
        </button>
        <input
          value={input}
          disabled={!availability.available}
          placeholder={
            !availability.available
              ? t('messages.thread.cantTalk', { name: character?.name ?? t('messages.they') })
              : pendingImage
                ? t('messages.thread.addCaption')
                : pendingGift
                  ? t('messages.thread.addNote')
                  : t('messages.thread.textPlaceholder', { name: character?.name ?? '…' })
          }
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          className="btn primary sm pcom-send"
          onClick={send}
          disabled={sending || uploadingImage || !availability.available || (!input.trim() && !pendingImage && !pendingGift)}
          aria-label={t('messages.thread.send')}
          title={t('messages.thread.send')}
        >
          <Icon name="send" size={16} />
        </button>
      </div>
    </div>
  );
}
