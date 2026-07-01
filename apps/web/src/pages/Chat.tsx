import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  RELATIONSHIP_STAT_KEYS,
  currentStatus,
  isBrokenUp,
  isOnTheRocks,
  nextDtrRung,
  warmthBand,
  bandIndex,
  deriveCalendar,
  PHASE_ICONS,
  venueCost,
  venueTierMeta,
  availableIntents,
  isGiftableItem,
  startingRapport,
  RAPPORT_LEAVE_FLOOR,
  INTENT_ICONS,
  type Intent,
  type InventoryItem,
  type ShopItem,
  type Character,
  type ConversationMode,
  type Phase,
  type ConversationSession,
  type DtrResponse,
  type EndSessionResponse,
  type Message,
  type Relationship,
  type RelationshipStatKey,
  type World,
  type PropertyView,
  type ActiveDate,
} from '@dsim/shared';
import { api, streamChat, streamRetry, streamRegenerate, assetUrl } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { useAppData } from '../state/app-context';
import { intentLabel, phaseLabel, relationshipStatusLabel, seasonLabel, weekdayLabel } from '../i18n/labels';
import { Portrait } from '../components/Portrait';
import { Icon } from '../components/Icon';
import { RelationshipBars } from '../components/StatBars';
import { Banner, Empty, Field, Spinner } from '../components/ui';
import './date.page.css';

/**
 * The live date "trajectory" — a diverging bar whose center seam is where THIS date
 * began (`anchor`; a guarded character opens BELOW the neutral midpoint). The fill
 * grows RIGHT (rose→brass) as rapport climbs from the seam toward 100, or LEFT (ember)
 * as it sinks toward the leave floor. Each half is scaled to that side's REAL room, so
 * the bar reaches hard-left exactly as the date bottoms out (the character is about to
 * walk) — never while there's still life in it — and hard-right only at a perfect night.
 * A per-turn +N / −N flourish rides on top; anchoring at the start keeps the fill in step
 * with it, so an opening +3 always reads as rightward progress even for a guarded
 * character. Numbers are never shown; only the fill and a qualitative caption. Values 0..100.
 */
function DateTrajectory({
  value,
  anchor,
  label,
  pulse,
}: {
  value: number | null;
  anchor: number;
  label: string;
  pulse: { delta: number; key: number } | null;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const v = value ?? anchor; // no read yet → sit exactly on the opening seam (empty fill)
  // The label word still reads absolute warmth, so its color stays keyed to the raw value.
  const tone = v >= 60 ? 'good' : v < 40 ? 'bad' : 'mid';
  const warming = v >= anchor;
  // Fill each half over its own available range so it can't underfill: warming spans
  // seam→100, cooling spans seam→leave-floor (below which the character leaves anyway).
  const room = warming ? Math.max(1, 100 - anchor) : Math.max(1, anchor - RAPPORT_LEAVE_FLOOR);
  const mag = Math.max(0, Math.min(50, (Math.abs(v - anchor) / room) * 50));
  const side = warming ? 'warm' : 'cool';
  // Anchor the fill from the LEFT for both directions (warming grows right of the 50%
  // seam; cooling occupies the mag% just left of it) and transition `left` too — so as
  // rapport crosses the seam the fill sweeps continuously THROUGH it instead of the one
  // element snapping its anchor from right-of-seam to left-of-seam mid-transition (the
  // old left:50% ↔ right:50% class flip, which made the bar visibly jump across zero).
  const fillLeft = warming ? 50 : 50 - mag;
  return (
    <div className={`date-trajectory tone-${tone}`} role="img" aria-label={t('chat.trajectoryAria', { label })}>
      <div className="dt-caption">
        <span className="dt-vibe">{label}</span>
      </div>
      <div className="dt-gauge">
        {pulse && pulse.delta !== 0 && (
          <div className="dt-pulse-wrap" key={pulse.key} aria-hidden="true">
            <span className={`dt-pulse ${pulse.delta > 0 ? 'up' : 'down'}`}>
              {pulse.delta > 0 ? '+' : ''}
              {pulse.delta}
            </span>
          </div>
        )}
        <span className="dt-pole dt-pole-cool" aria-hidden="true">◆</span>
        <div className="dt-track">
          <span className="dt-center" aria-hidden="true" />
          <span className={`dt-fill ${side}`} style={{ left: `${fillLeft}%`, width: `${mag}%` }} />
        </div>
        <span className="dt-pole dt-pole-warm" aria-hidden="true">◆</span>
      </div>
      <div className="dt-foot">
        <span className="dt-end">{t('chat.cooling')}</span>
        <span className="dt-end">{t('chat.warming')}</span>
      </div>
    </div>
  );
}

export function Chat() {
  const { t } = useTranslation(['pages', 'common']);
  const [params] = useSearchParams();
  const { player, reloadPlayer, refreshWorldState, activeWorldId, worldState, dayTick, activeDate, activeDateLoaded, refreshActiveDate, assetById } =
    useAppData();
  const [availability, setAvailability] = useState<Record<string, { available: boolean; reason: string | null }>>({});
  // The wallet of the SELECTED character's world (may differ from the active
  // world when arriving via a deep link); falls back to the context player.
  const [setupMoney, setSetupMoney] = useState<number | null>(null);

  const [characters, setCharacters] = useState<Character[]>([]);
  const [setup, setSetup] = useState({
    characterId: params.get('character') ?? '',
    mode: 'date' as ConversationMode,
    // "Anywhere" (the server auto-picks a free venue, else the cheapest affordable one).
    locationId: 'anywhere',
  });
  const [setupWorld, setSetupWorld] = useState<World | null>(null);
  const [setupProperties, setSetupProperties] = useState<PropertyView[]>([]);
  const [roomUnlocked, setRoomUnlocked] = useState(false);
  const [scene, setScene] = useState<{
    day: number;
    phase: Phase;
    weatherIcon: string;
    weatherLabel: string;
    moodIcon: string | null;
    mood: string | null;
  } | null>(null);

  const [session, setSession] = useState<ConversationSession | null>(null);
  const [character, setCharacter] = useState<Character | null>(null);
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [intent, setIntent] = useState<Intent | null>(null);
  const [streaming, setStreaming] = useState<{ active: boolean; text: string }>({ active: false, text: '' });
  const [expression, setExpression] = useState<string | null>(null);
  const [evalResult, setEvalResult] = useState<EndSessionResponse | null>(null);
  const [deltas, setDeltas] = useState<Partial<Record<RelationshipStatKey, number>> | null>(null);
  const [milestone, setMilestone] = useState<EndSessionResponse['milestone']>(null);
  const [dtrOutcome, setDtrOutcome] = useState<DtrResponse | null>(null);
  const [giftPicker, setGiftPicker] = useState(false);
  const [giftItems, setGiftItems] = useState<Array<{ inventoryItem: InventoryItem; item: ShopItem }>>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  // Resuming an in-progress date the server still holds (after a navigation/refresh).
  const [resuming, setResuming] = useState(false);
  const [resumeFailed, setResumeFailed] = useState(false);
  const [notice, setNotice] = useState<string>();
  // A turn that didn't land, with how to recover it. 'reply' = your message was
  // saved but the reply failed/dropped → regenerate it (no duplicate). 'send' =
  // nothing saved → resend the original text + intent (kept here).
  const [failed, setFailed] = useState<
    | { kind: 'reply' }
    // priorPlayerTurns: player-turn count BEFORE this send — lets a retry tell "my
    // turn was saved" (count grew) from "a stale prior reply is trailing".
    | { kind: 'send'; text: string; intent?: Intent; priorPlayerTurns: number }
    | null
  >(null);
  const [walkout, setWalkout] = useState<string | null>(null);
  // Live "how it's going" read: the vibe word, the numeric trajectory (0..100,
  // internal — center 50), and the signed change this turn for the +N/−N flourish.
  const [vibe, setVibe] = useState<string | null>(null);
  const [rapport, setRapport] = useState<number | null>(null);
  const [rapportPulse, setRapportPulse] = useState<{ delta: number; key: number } | null>(null);
  const [leftEarly, setLeftEarly] = useState(false);
  // The player typed something that read as a breakup — awaiting their confirm.
  const [breakupPending, setBreakupPending] = useState<{ reaction: 'accept' | 'hurt' | 'plead' } | null>(null);
  const [brokeUp, setBrokeUp] = useState(false);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Mirrors the live session id so async handlers can detect that the player
  // abandoned this date (New / world-switch) before their request resolved.
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    sessionIdRef.current = session?.id ?? null;
  }, [session]);

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    void api.listCharacters().then(setCharacters).catch((e) => setError(errorMessage(e)));
  }, []);

  // Who's available to date today (Do Not Disturb), for the active world.
  // Re-keyed on dayTick so ending the day refreshes "who's free today".
  useEffect(() => {
    if (!activeWorldId) return;
    let live = true;
    void api
      .worldAvailability(activeWorldId)
      .then((list) => {
        if (!live) return;
        const map: Record<string, { available: boolean; reason: string | null }> = {};
        for (const a of list) map[a.characterId] = { available: a.available, reason: a.reason };
        setAvailability((prev) => ({ ...prev, ...map }));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [activeWorldId, dayTick]);

  // Owned + rentable properties in the selected character's world, offered as date
  // venues (owned = free + the best buff; rentable = pay the rent fee for the night).
  // Only when that world has the property feature on; re-keyed on dayTick (ownership
  // + the wallet shift after End day / a purchase).
  useEffect(() => {
    if (!setupWorld?.featureFlags?.property) {
      setSetupProperties([]);
      return;
    }
    let live = true;
    api
      .listProperties(setupWorld.id)
      .then((r) => live && setSetupProperties(r.properties))
      .catch(() => live && setSetupProperties([]));
    return () => {
      live = false;
    };
  }, [setupWorld?.id, setupWorld?.featureFlags?.property, dayTick]);

  // Load the chosen character's world (for its locations + wallet) and their
  // availability. Re-keyed on dayTick so ending the day refreshes the gate; the
  // `live` flag drops out-of-order writes when the partner is switched mid-fetch.
  useEffect(() => {
    if (!setup.characterId) {
      setSetupWorld(null);
      setRoomUnlocked(false);
      setSetupMoney(null);
      return;
    }
    let live = true;
    const cid = setup.characterId;
    void (async () => {
      try {
        const c = await api.getCharacter(cid);
        if (!live) return;
        setSetupWorld(c.worldId ? await api.getWorld(c.worldId) : null);
        if (!live) return;
        // Load availability + wallet from the SELECTED character's own world (not
        // just the active world) so the unavailability gate and the venue
        // "can't afford" text match what the server enforces, even when arriving
        // from the character page on a non-active world.
        if (c.worldId) {
          const [list, wp] = await Promise.all([
            api.worldAvailability(c.worldId),
            c.worldId === activeWorldId ? Promise.resolve(null) : api.getPlayer(c.worldId),
          ]);
          if (!live) return;
          setAvailability((prev) => ({
            ...prev,
            ...Object.fromEntries(list.map((a) => [a.characterId, { available: a.available, reason: a.reason }])),
          }));
          setSetupMoney(wp ? wp.money : null);
        } else {
          setSetupMoney(null);
        }
      } catch {
        if (live) setSetupWorld(null);
      }
    })();
    // Their private room unlocks once you're "getting close". Fetching it also
    // ensures the description is generated by the time you start the date.
    void api
      .getRelationship(cid)
      .then((rel) => {
        if (!live) return;
        const unlocked = bandIndex(warmthBand(rel)) >= bandIndex('getting-close');
        setRoomUnlocked(unlocked);
        if (unlocked) void api.getRoom(cid).catch(() => undefined);
      })
      .catch(() => live && setRoomUnlocked(false));
    return () => {
      live = false;
    };
  }, [setup.characterId, dayTick, activeWorldId]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  // Keep the date-scene chips (day / weather / mood) in sync if the world clock
  // advances mid-session — e.g. the player ends the day from the persistent HUD.
  useEffect(() => {
    if (!session || !character?.worldId) return;
    let live = true;
    const cid = character.id;
    void Promise.all([api.getWorldState(character.worldId), api.worldWeather(character.worldId)])
      .then(([ws, ww]) => {
        if (!live) return;
        const m = ww.characters.find((x) => x.id === cid);
        setScene({
          day: ws.day,
          phase: ws.phase,
          weatherIcon: ww.today.icon,
          weatherLabel: ww.today.label,
          moodIcon: m?.moodIcon ?? null,
          mood: m?.mood ?? null,
        });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [dayTick, session?.id, character?.id, character?.worldId]);

  // The date has concluded by some terminal path (evaluated, walkout, soft-leave,
  // DTR-ended, or breakup) — the session is no longer open on the server.
  const dateConcluded = !!evalResult || !!walkout || leftEarly || brokeUp || !!dtrOutcome?.ended;

  // Leaving the Date tab no longer destroys the date — it's held server-side and
  // auto-resumes when you come back (see the resume effect below). The only thing a
  // refresh can interrupt is a reply that's still generating, so warn only then.
  useEffect(() => {
    if (!streaming.active) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // Chrome requires a set returnValue to show the prompt
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [streaming.active]);

  // A date the server still holds for this world but we're not currently showing —
  // it needs to be hydrated back into view (the auto-resume).
  const pendingResume = !!activeDate && session?.id !== activeDate.sessionId && !dateConcluded;

  // Rehydrate an in-progress date from its server session: the conversation +
  // partner + relationship + scene, restoring the live trajectory if the server
  // still holds it. Drives the setup machinery (world/properties/room) by simply
  // setting the partner, then overlays the live session on top.
  const resume = async (ad: ActiveDate) => {
    setResuming(true);
    setResumeFailed(false);
    setError(undefined);
    // Clear any prior terminal state so a resumed date reads as live.
    setEvalResult(null);
    setDeltas(null);
    setMilestone(null);
    setDtrOutcome(null);
    setGiftPicker(false);
    setGiftItems([]);
    setWalkout(null);
    setLeftEarly(false);
    setBreakupPending(null);
    setBrokeUp(false);
    setRapportPulse(null);
    setIntent(null);
    setFailed(null);
    try {
      const [c, sm] = await Promise.all([api.getCharacter(ad.characterId), api.getConversation(ad.sessionId)]);
      // The context can briefly point at a session that just ended elsewhere — never
      // reopen a finished date. Reconcile (await, so the lock clears) and fall back
      // to setup; the resumeFailed flag is a harmless no-op once activeDate is null.
      if (sm.session.ended) {
        await refreshActiveDate();
        setResumeFailed(true);
        return;
      }
      setSetup((s) => ({ ...s, characterId: ad.characterId, locationId: sm.session.locationId ?? '' }));
      setSession(sm.session);
      setCharacter(c);
      setMessages(sm.messages);
      // Re-derive the retry bar from server truth so it survives a refresh / resume:
      // a transcript ending in an unanswered player turn means the reply never came.
      const lastMsg = sm.messages[sm.messages.length - 1];
      if (lastMsg && lastMsg.role === 'player') setFailed({ kind: 'reply' });
      setRelationship(await api.getRelationship(c.id));
      setExpression(null);
      setVibe(ad.vibe);
      setRapport(ad.rapport);
      if (c.worldId) {
        const [ws, ww] = await Promise.all([api.getWorldState(c.worldId), api.worldWeather(c.worldId)]);
        const m = ww.characters.find((x) => x.id === c.id);
        setScene({
          day: ws.day,
          phase: ws.phase,
          weatherIcon: ww.today.icon,
          weatherLabel: ww.today.label,
          moodIcon: m?.moodIcon ?? null,
          mood: m?.mood ?? null,
        });
      }
    } catch (e) {
      // The date is still real on the server, so keep the lock and surface a retry.
      // Also reconcile activeDate so a date that actually ended doesn't stay stuck.
      setResumeFailed(true);
      setError(errorMessage(e));
      void refreshActiveDate();
    } finally {
      setResuming(false);
    }
  };

  // Auto-resume whenever the world surfaces a different in-progress date than what's
  // on screen. Keyed on the session id so a refetch that returns the SAME date (a
  // routine refresh) never re-hydrates or loops.
  useEffect(() => {
    if (!activeDate || resuming || starting) return;
    if (session?.id === activeDate.sessionId) return; // already showing it
    void resume(activeDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDate?.sessionId]);

  // When the date ends by any path, clear the world's lock so Sleep / Work /
  // Minigames unlock and the nav badge drops.
  useEffect(() => {
    if (dateConcluded) void refreshActiveDate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateConcluded]);

  const start = async () => {
    if (!setup.characterId) return;
    if (activeDate) return; // a date is already underway — resume it, never start a second
    setStarting(true);
    setError(undefined);
    setEvalResult(null);
    setDeltas(null);
    setMilestone(null);
    setDtrOutcome(null);
    setGiftPicker(false);
    setGiftItems([]);
    setWalkout(null);
    setVibe(null);
    setLeftEarly(false);
    setBreakupPending(null);
    setBrokeUp(false);
    setResumeFailed(false);
    setScene(null);
    setIntent(null);
    setFailed(null);
    try {
      const c = await api.getCharacter(setup.characterId);
      const created = await api.createConversation({
        characterId: setup.characterId,
        mode: setup.mode,
        locationId: setup.locationId || null,
      });
      setSession(created);
      setCharacter(c);
      // A date is now open server-side — engage the world's "date underway" lock
      // (Sleep / Work / Minigames) and light the Date-tab badge.
      void refreshActiveDate();
      setRelationship(await api.getRelationship(c.id));
      // On a first date the character opens the conversation, so load any message
      // the server already persisted (empty for repeat dates → the player opens).
      try {
        const sm = await api.getConversation(created.id);
        setMessages(sm.messages);
      } catch {
        setMessages([]);
      }
      setExpression(null);
      // Load the at-a-glance scene context (time/weather/mood) for this character's world.
      if (c.worldId) {
        void Promise.all([api.getWorldState(c.worldId), api.worldWeather(c.worldId)])
          .then(([ws, ww]) => {
            const m = ww.characters.find((x) => x.id === c.id);
            setScene({
              day: ws.day,
              phase: ws.phase,
              weatherIcon: ww.today.icon,
              weatherLabel: ww.today.label,
              moodIcon: m?.moodIcon ?? null,
              mood: m?.mood ?? null,
            });
          })
          .catch(() => setScene(null));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  // `resend` carries a preserved payload for a retry; a normal send reads the live
  // composer. `playerPersisted` tracks whether the server saved the player turn
  // (the `player` event fired) so a failure can pick the right recovery: regenerate
  // the reply (text saved) vs. resend the whole turn (nothing saved).
  const send = async (resend?: { text: string; intent?: Intent }) => {
    const text = (resend?.text ?? input).trim();
    if (!text || !session || streaming.active || busy) return;
    const chosenIntent = resend ? resend.intent : intent ?? undefined;
    if (!resend) {
      setInput('');
      setIntent(null);
    }
    setError(undefined);
    setNotice(undefined);
    setFailed(null);
    setStreaming({ active: true, text: '' });
    const controller = new AbortController();
    abortRef.current = controller;
    let playerPersisted = false;
    let settled = false; // a terminal event (done/error/walkout/…) arrived
    // Baseline to detect (on a retry) whether THIS turn persisted despite a missed
    // 'player' event — by the player-turn count growing, not the trailing role.
    const priorPlayerTurns = messages.filter((m) => m.role === 'player').length;
    const recover = () =>
      playerPersisted ? { kind: 'reply' as const } : { kind: 'send' as const, text, intent: chosenIntent, priorPlayerTurns };
    try {
      await streamChat(
        session.id,
        text,
        {
          onPlayer: (m) => {
            playerPersisted = true;
            setMessages((prev) => [...prev, m]);
          },
          onDelta: (delta) => setStreaming((s) => ({ active: true, text: s.text + delta })),
          onDone: (m) => {
            settled = true;
            setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
            setStreaming({ active: false, text: '' });
          },
          onError: (msg) => {
            settled = true;
            setError(msg);
            setStreaming({ active: false, text: '' });
            setFailed(recover());
          },
          onNotice: (msg) => setNotice(msg),
          onWalkout: (m, reason) => {
            // The character stormed out. Show the walkout moment, then run the normal
            // end-and-evaluate flow so the blown-up date is scored in full (stamina,
            // deltas, memories, milestones) — same as a deliberately-ended date.
            settled = true;
            setMessages((prev) => [...prev, m]);
            setStreaming({ active: false, text: '' });
            setWalkout(reason || t('chat.walkoutDefault'));
            void endDate();
          },
          onBreakupIntent: (m, reaction) => {
            settled = true;
            setMessages((prev) => [...prev, m]);
            setStreaming({ active: false, text: '' });
            setBreakupPending({ reaction });
          },
          onRapport: (label, expr, rap, delta) => {
            setVibe(label);
            if (expr) setExpression(expr);
            setRapport(rap);
            if (delta) setRapportPulse((p) => ({ delta, key: (p?.key ?? 0) + 1 }));
          },
          onLeft: (m) => {
            // The character lost interest and called it a night. Show the soft-exit
            // moment, then run the normal end-and-evaluate flow so the flat date is
            // scored in full (stamina, deltas, memories) like any ended date.
            settled = true;
            setMessages((prev) => [...prev, m]);
            setStreaming({ active: false, text: '' });
            setLeftEarly(true);
            setVibe(null);
            void endDate();
          },
          onFarewell: (m, expr) => {
            // The player ended the date by chatting (a natural goodbye). Show the
            // character's send-off, then run the normal end-and-evaluate flow so the
            // date is scored in full — no need to click "End & evaluate".
            settled = true;
            setMessages((prev) => [...prev, m]);
            setStreaming({ active: false, text: '' });
            if (expr) setExpression(expr);
            void endDate();
          },
        },
        controller.signal,
        chosenIntent,
      );
      // The stream ended with no terminal event (the connection dropped mid-reply):
      // recover instead of leaving the typing indicator spinning forever.
      if (!settled && !controller.signal.aborted) {
        setStreaming({ active: false, text: '' });
        setError(t('chat.replyDropped'));
        setFailed(recover());
      }
    } catch (e) {
      // Aborts are expected when the user resets/navigates; ignore them.
      if (!controller.signal.aborted) {
        setError(errorMessage(e));
        setFailed(recover());
      }
      setStreaming({ active: false, text: '' });
    }
  };

  // Recover a failed turn: resend a lost message, or regenerate a reply when the
  // player's message was saved but the reply failed (no duplicate player turn).
  const retry = async () => {
    if (!session || !failed || streaming.active || busy) return;
    // Regenerating a reply never adds a player turn; resending re-POSTs /stream and
    // WOULD duplicate the turn if the server actually saved it (we may have missed
    // the 'player' event on a drop). So for a presumed-lost send, reconcile with
    // server truth first and only resend when there's no unanswered player turn.
    let action: 'reply' | 'send' | 'abort' = failed.kind === 'reply' ? 'reply' : 'send';
    if (failed.kind === 'send') {
      setBusy(true);
      try {
        const sm = await api.getConversation(session.id);
        const newPlayerTurns = sm.messages.filter((m) => m.role === 'player').length;
        const last = sm.messages[sm.messages.length - 1];
        if (newPlayerTurns > failed.priorPlayerTurns) {
          // The turn WAS saved (count grew). If a reply also landed, we're done.
          if (last && last.role === 'character') {
            setMessages(sm.messages);
            setFailed(null);
            return;
          }
          action = 'reply'; // saved but unanswered → regenerate
        } else {
          action = 'send'; // genuinely not saved → resend
        }
      } catch {
        action = 'abort'; // couldn't verify — keep the retry, don't risk a dup
      } finally {
        setBusy(false);
      }
    }

    if (action === 'abort') return; // payload preserved in `failed`; they can retry again
    if (action === 'send' && failed.kind === 'send') {
      const { text, intent: keptIntent } = failed;
      setFailed(null);
      await send({ text, intent: keptIntent });
      return;
    }

    setFailed(null);
    setError(undefined);
    setNotice(undefined);
    setStreaming({ active: true, text: '' });
    const controller = new AbortController();
    abortRef.current = controller;
    let settled = false;
    try {
      await streamRetry(
        session.id,
        {
          onDelta: (delta) => setStreaming((s) => ({ active: true, text: s.text + delta })),
          onDone: (m) => {
            settled = true;
            setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
            setStreaming({ active: false, text: '' });
          },
          onError: (msg) => {
            settled = true;
            setError(msg);
            setStreaming({ active: false, text: '' });
            setFailed({ kind: 'reply' });
          },
          onNotice: (msg) => setNotice(msg),
        },
        controller.signal,
      );
      if (!settled && !controller.signal.aborted) {
        setStreaming({ active: false, text: '' });
        setError(t('chat.replyDropped'));
        setFailed({ kind: 'reply' });
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(errorMessage(e));
        setFailed({ kind: 'reply' });
      }
      setStreaming({ active: false, text: '' });
    }
  };

  // Rewrite the character's MOST RECENT reply (a bad/looping line) without re-judging
  // the turn. Optimistically drop the old reply — the server deletes it and streams a
  // fresh one against the same player turn. On failure the reply is gone server-side,
  // so we surface the standard reply-retry (which also regenerates, never re-judges).
  const regenerate = async () => {
    if (!session || streaming.active || busy || locked) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'character') return;
    setError(undefined);
    setNotice(undefined);
    setFailed(null);
    setMessages((prev) => prev.slice(0, -1));
    setStreaming({ active: true, text: '' });
    const controller = new AbortController();
    abortRef.current = controller;
    let settled = false;
    try {
      await streamRegenerate(
        session.id,
        {
          onDelta: (delta) => setStreaming((s) => ({ active: true, text: s.text + delta })),
          onDone: (m) => {
            settled = true;
            setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
            setStreaming({ active: false, text: '' });
          },
          onError: (msg) => {
            settled = true;
            setError(msg);
            setStreaming({ active: false, text: '' });
            setFailed({ kind: 'reply' });
          },
          onNotice: (msg) => setNotice(msg),
        },
        controller.signal,
      );
      if (!settled && !controller.signal.aborted) {
        setStreaming({ active: false, text: '' });
        setError(t('chat.replyDropped'));
        setFailed({ kind: 'reply' });
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(errorMessage(e));
        setFailed({ kind: 'reply' });
      }
      setStreaming({ active: false, text: '' });
    }
  };

  const newConversation = () => {
    abortRef.current?.abort();
    setStreaming({ active: false, text: '' });
    setSession(null);
    setCharacter(null);
    setMessages([]);
    setEvalResult(null);
    setDeltas(null);
    setMilestone(null);
    setDtrOutcome(null);
    setGiftPicker(false);
    setGiftItems([]);
    setNotice(undefined);
    setWalkout(null);
    setVibe(null);
    setRapport(null);
    setRapportPulse(null);
    setLeftEarly(false);
    setBreakupPending(null);
    setBrokeUp(false);
    setScene(null);
    setIntent(null);
    setFailed(null);
  };

  // A world switch must not leave a different world's date streaming into view.
  // Abort the in-flight stream and reset to the setup screen when the active
  // world changes (skipping the initial mount).
  const lastWorldRef = useRef(activeWorldId);
  useEffect(() => {
    if (lastWorldRef.current === activeWorldId) return;
    lastWorldRef.current = activeWorldId;
    abortRef.current?.abort();
    newConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorldId]);

  const defineRelationship = async () => {
    if (!session) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.defineRelationship(session.id);
      setMessages((prev) => [...prev, res.message]);
      setRelationship(res.relationship);
      setDtrOutcome(res);
      setSession((s) => (s ? { ...s, ended: res.ended || s.ended } : s));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // Load the player's held GIFTABLE items for this world (gifts are given here or
  // by text now, never from the bag). Filters out consumables/money items.
  const openGiftPicker = async () => {
    setGiftPicker(true);
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

  const giveGift = async (inventoryItemId: string) => {
    if (!session || busy || streaming.active) return;
    const sid = session.id;
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.giftOnDate(sid, inventoryItemId);
      if (sessionIdRef.current !== sid) return; // player switched dates mid-gift
      // The "🎁 you gave …" beat + the character's reaction land in the transcript.
      setMessages((prev) => [...prev, res.narratorMessage, res.message]);
      setRelationship(res.relationship);
      if (res.expression) setExpression(res.expression);
      setDeltas(res.deltas);
      setTimeout(() => setDeltas(null), 1800);
      setGiftPicker(false);
      // Reflect the consumed unit so a second gift this date reads correctly.
      setGiftItems((items) =>
        items
          .map((e) =>
            e.inventoryItem.id === inventoryItemId
              ? { ...e, inventoryItem: { ...e.inventoryItem, quantity: e.inventoryItem.quantity - 1 } }
              : e,
          )
          .filter((e) => e.inventoryItem.quantity > 0),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmBreakup = async () => {
    if (!session) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.confirmBreakup(session.id);
      setRelationship(res.relationship);
      setSession((s) => (s ? { ...s, ended: res.ended || s.ended } : s));
      setBreakupPending(null);
      setBrokeUp(true);
      await reloadPlayer();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const cancelBreakup = () => setBreakupPending(null);

  // Back out of a date you haven't spoken in yet. The server discards an unspoken
  // session at no cost (no stamina, no "last seen"), so this just clears it and
  // drops you back to the setup screen — no evaluation banner.
  const cancelDate = async () => {
    if (!session) return;
    const sid = session.id;
    setBusy(true);
    setError(undefined);
    try {
      await api.endSession(sid);
      if (sessionIdRef.current !== sid) return; // already moved on
      newConversation();
      await refreshActiveDate();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const endDate = async () => {
    if (!session) return;
    const sid = session.id;
    setBusy(true);
    setError(undefined);
    const prev = relationship;
    try {
      const result = await api.endSession(sid);
      if (sessionIdRef.current !== sid) return; // player abandoned this date mid-eval
      setEvalResult(result);
      setSession(result.session);
      if (result.relationship) {
        // Surface the date's net change as floating chips, then clear them so the
        // animation can replay on the next date.
        if (prev) {
          const d: Partial<Record<RelationshipStatKey, number>> = {};
          for (const k of RELATIONSHIP_STAT_KEYS) {
            const diff = result.relationship[k] - prev[k];
            if (diff !== 0) d[k] = diff;
          }
          setDeltas(Object.keys(d).length ? d : null);
          setTimeout(() => setDeltas(null), 1800);
        }
        setRelationship(result.relationship);
      }
      setMilestone(result.milestone ?? null);
      if (result.expression) setExpression(result.expression);
      await reloadPlayer();
      await refreshWorldState();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const summarize = async () => {
    if (!session) return;
    const sid = session.id;
    setBusy(true);
    try {
      const updated = await api.summarize(sid);
      if (sessionIdRef.current !== sid) return; // player abandoned this date
      setSession(updated);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // --- setup screen ---
  if (!session || !character) {
    // Don't flash "Plan a date" before we know whether a date is already underway,
    // nor while one is being rehydrated.
    if (!activeDateLoaded || ((pendingResume || resuming) && !resumeFailed)) {
      return (
        <div className="stack">
          <Spinner />
        </div>
      );
    }
    // A date IS underway for this world but it isn't on screen (the resume failed or
    // hasn't landed). NEVER show the plan-a-date form here — that would let the player
    // open a SECOND concurrent date. Offer to reopen the real one instead.
    if (activeDate) {
      return (
        <div className="stack">
          <div className="page-head">
            <div className="kicker">{t('chat.tonightsPlan')}</div>
            <h1>{t('chat.onADateTitle')}</h1>
            <p>{t('chat.onADateBody', { name: activeDate.characterName })}</p>
          </div>
          {error && <Banner kind="error">{error}</Banner>}
          <div className="framed date-setup">
            <p>{t('chat.reopenFailed')}</p>
            <button className="btn primary block" onClick={() => void resume(activeDate)} disabled={resuming}>
              {resuming ? (
                <>
                  <span className="date-btn-spinner" aria-hidden="true" /> {t('chat.reopening')}
                </>
              ) : (
                <>
                  <Icon name="date" size={16} /> {t('chat.resumeDate', { name: activeDate.characterName })}
                </>
              )}
            </button>
          </div>
        </div>
      );
    }
    // Affordability/energy gates read the SELECTED character's world where it
    // differs from the active world (deep link); else the active world's wallet.
    const wallet = setupMoney ?? player?.money ?? 0;
    const sameWorld = !setupWorld || setupWorld.id === activeWorldId;
    const outOfEnergy = sameWorld && worldState != null && worldState.stamina <= 0;
    return (
      <div className="stack">
        <div className="page-head">
          <div className="kicker">{t('chat.tonightsPlan')}</div>
          <h1>{t('chat.planADate')}</h1>
          <p>{t('chat.planSub')}</p>
        </div>
        {error && <Banner kind="error">{error}</Banner>}
        {characters.length === 0 ? (
          <Empty icon="💬" title={t('chat.noCharsTitle')}>
            <p>{t('chat.noCharsBody')}</p>
          </Empty>
        ) : (
          <div className="framed date-setup">
            <div className="date-setup-head">
              <div className="date-setup-mark" aria-hidden="true" />
              <div>
                <div className="kicker date-setup-kicker">{t('chat.arrangeEvening')}</div>
                <h2>{t('chat.whoWhereWhen')}</h2>
              </div>
            </div>
            <div className="date-pick">
              <div className="kicker">{t('chat.whoMeeting')}</div>
              <div className="date-pick-grid">
                {characters
                  .filter((c) => !activeWorldId || c.worldId === activeWorldId)
                  .map((c) => {
                    const avail = availability[c.id];
                    const unavailable = !!avail && !avail.available;
                    const selected = setup.characterId === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={`date-pick-card${selected ? ' selected' : ''}${unavailable ? ' unavailable' : ''}`}
                        onClick={() => setSetup((s) => ({ ...s, characterId: c.id, locationId: 'anywhere' }))}
                        disabled={unavailable}
                        title={unavailable ? t('chat.cardTitleUnavailable', { name: c.name, reason: avail?.reason ?? t('chat.unavailableToday') }) : t('chat.cardTitleMeet', { name: c.name })}
                      >
                        {selected && (
                          <span className="date-pick-check" aria-hidden="true">
                            ✓
                          </span>
                        )}
                        <div className="date-pick-portrait">
                          <Portrait character={c} />
                        </div>
                        <div className="date-pick-name">{c.name}</div>
                        <div className="date-pick-sub">
                          {unavailable ? (avail?.reason ?? t('chat.busyToday')) : t('chat.agePronouns', { age: c.age, pronouns: c.pronouns })}
                        </div>
                      </button>
                    );
                  })}
              </div>
            </div>
            {((setupWorld && setupWorld.locations.length > 0) || roomUnlocked || setupProperties.length > 0) && (
              <Field label={t('chat.locationField')}>
                {(() => {
                  // One unified list of pickable venues rendered as photo tiles.
                  // Each tile: a value (locationId), label, optional sub-line,
                  // optional photo, an emoji fallback, and an afford/disabled flag.
                  type Tile = {
                    value: string;
                    label: string;
                    sub?: string;
                    image?: string;
                    glyph: string;
                    disabled?: boolean;
                  };
                  // "Anywhere" lets the server pick: the first free public venue, else
                  // the cheapest one you can afford. Mirror that here so the tile shows
                  // the right cost (and disables when nothing's affordable).
                  const locs = setupWorld?.locations ?? [];
                  const anyFree = locs.some((l) => venueCost(l.priceTier) === 0);
                  const cheapestAffordablePaid = [...locs]
                    .filter((l) => venueCost(l.priceTier) > 0)
                    .sort((a, b) => venueCost(a.priceTier) - venueCost(b.priceTier))
                    .find((l) => venueCost(l.priceTier) <= wallet);
                  const anywhereBroke = locs.length > 0 && !anyFree && !cheapestAffordablePaid;
                  const anywhereSub =
                    anyFree || locs.length === 0
                      ? t('chat.free')
                      : anywhereBroke
                        ? t('chat.cantAffordAny')
                        : t('chat.venueCost', {
                            symbol: venueTierMeta(cheapestAffordablePaid!.priceTier).symbol,
                            cost: venueCost(cheapestAffordablePaid!.priceTier),
                          });
                  const tiles: Tile[] = [
                    { value: 'anywhere', label: t('chat.anywhere'), sub: anywhereSub, glyph: '✨', disabled: anywhereBroke },
                  ];
                  for (const pv of setupProperties) {
                    // Date at a property you OWN or currently LEASE (both free — the
                    // lease rent is paid separately). Lease/buy one in the Property app.
                    if (!pv.owned && !pv.lease) continue;
                    tiles.push({
                      value: `prop:${pv.property.id}`,
                      label: pv.property.name,
                      sub: `${pv.owned ? t('chat.yourPlace') : t('chat.leased')}${t('chat.freeSuffix')}`,
                      image: assetById(pv.property.assetId)?.path,
                      glyph: '🏠',
                    });
                  }
                  for (const l of setupWorld?.locations ?? []) {
                    const cost = venueCost(l.priceTier);
                    const meta = venueTierMeta(l.priceTier);
                    const broke = cost > wallet;
                    tiles.push({
                      value: l.id,
                      label: l.name,
                      sub: cost > 0 ? `${t('chat.venueCost', { symbol: meta.symbol, cost })}${broke ? t('chat.cantAffordSuffix') : ''}` : t('chat.free'),
                      image: assetById(l.imageAssetId)?.path,
                      glyph: '📍',
                      disabled: broke,
                    });
                  }
                  if (roomUnlocked) {
                    const partnerName = characters.find((c) => c.id === setup.characterId)?.name;
                    tiles.push({
                      value: `room:${setup.characterId}`,
                      label: partnerName ? t('chat.roomName', { name: partnerName }) : t('chat.theirRoomName'),
                      sub: t('chat.stayInFree'),
                      glyph: '🚪',
                    });
                  }
                  return (
                    <div className="date-loc-grid" role="radiogroup" aria-label={t('chat.chooseLocation')}>
                      {tiles.map((tile) => {
                        const selected = setup.locationId === tile.value;
                        return (
                          <button
                            key={tile.value || 'anywhere'}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={`date-loc-card${selected ? ' selected' : ''}${tile.disabled ? ' unavailable' : ''}`}
                            onClick={() => !tile.disabled && setSetup((s) => ({ ...s, locationId: tile.value }))}
                            disabled={tile.disabled}
                            title={tile.disabled ? t('chat.tileTitleCantAfford', { label: tile.label }) : tile.label}
                          >
                            <div className="date-loc-photo">
                              {tile.image ? (
                                <img src={assetUrl(tile.image)} alt="" />
                              ) : (
                                <span className="date-loc-glyph" aria-hidden="true">{tile.glyph}</span>
                              )}
                              {selected && <span className="date-loc-check" aria-hidden="true">✓</span>}
                            </div>
                            <div className="date-loc-meta">
                              <span className="date-loc-name">{tile.label}</span>
                              {tile.sub && <span className="date-loc-sub">{tile.sub}</span>}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
                <div className="muted" style={{ fontSize: '0.78rem', marginTop: '0.5rem' }}>
                  {t('chat.walletNote', { wallet })}
                </div>
              </Field>
            )}
            {setup.characterId && availability[setup.characterId] && !availability[setup.characterId]!.available && (
              <div className="banner error" style={{ fontSize: '0.82rem' }}>
                {t('chat.availBanner', {
                  name: characters.find((c) => c.id === setup.characterId)?.name ?? '',
                  reason: availability[setup.characterId]!.reason ?? t('chat.isUnavailableToday'),
                })}
              </div>
            )}
            {outOfEnergy && (
              <div className="banner info" style={{ fontSize: '0.82rem' }}>
                {t('chat.outOfEnergy')}
              </div>
            )}
            <button
              className="btn primary block"
              onClick={start}
              disabled={
                starting ||
                !setup.characterId ||
                (availability[setup.characterId] && !availability[setup.characterId]!.available) ||
                outOfEnergy
              }
            >
              {starting ? (
                <>
                  <span className="date-btn-spinner" aria-hidden="true" />
                  {t('chat.settingScene')}
                </>
              ) : (
                <>
                  <Icon name="date" size={16} /> {t('chat.begin')}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    );
  }

  // --- chat screen ---
  const status = relationship ? currentStatus(relationship) : 'none';
  const rung = relationship ? nextDtrRung(relationship) : null;
  const spokeThisSession = messages.some((m) => m.role === 'player');
  const dtrReady = !!rung && rung.warmthMet && spokeThisSession;
  // The date is over (evaluated or any terminal path) → no more composing, and the
  // actions collapse to "New date". Mirrors dateConcluded so the lock clears in step.
  const locked = !!evalResult || !!walkout || leftEarly || !!dtrOutcome?.ended || brokeUp;
  // The id of the trailing character reply, when it's a plain line the player may
  // regenerate (not a consequence-bearing walkout/farewell/etc, and not mid-stream
  // or mid-recovery). Drives the small "rewrite this reply" button on that bubble.
  const lastMsg = messages[messages.length - 1];
  const regenId =
    lastMsg &&
    lastMsg.role === 'character' &&
    !lastMsg.metadata?.walkout &&
    !lastMsg.metadata?.left &&
    !lastMsg.metadata?.farewell &&
    !lastMsg.metadata?.breakupIntent &&
    messages.some((m) => m.role === 'player') && // a reply to your turn, not the opener
    !locked &&
    !streaming.active &&
    !busy &&
    !failed &&
    !breakupPending
      ? lastMsg.id
      : null;
  const locationName = session.locationId
    ? session.locationId.startsWith('room:')
      ? t('chat.loc.room', { name: character.name })
      : session.locationId.startsWith('prop:')
        ? setupProperties.find((pv) => `prop:${pv.property.id}` === session.locationId)?.property.name ?? t('chat.loc.yourPlace')
        : setupWorld?.locations.find((l) => l.id === session.locationId)?.name ?? t('chat.loc.somewhere')
    : t('chat.loc.anywhere');
  // The chosen venue's uploaded photo, if any — surfaced as a scene backdrop.
  const locationAssetId = session.locationId
    ? session.locationId.startsWith('prop:')
      ? setupProperties.find((pv) => `prop:${pv.property.id}` === session.locationId)?.property.assetId ?? null
      : session.locationId.startsWith('room:')
        ? null
        : setupWorld?.locations.find((l) => l.id === session.locationId)?.imageAssetId ?? null
    : null;
  const locationImage = assetById(locationAssetId)?.path;
  const cal = scene ? deriveCalendar(scene.day) : null;

  // The end-of-date evaluation note (mood, summary, memories) — or a safe-failure
  // notice. Extracted so it can stand in as the primary moment OR ride along as a
  // secondary note when a milestone/DTR moment takes the primary slot (going
  // official otherwise hid the evaluation entirely).
  const evalBanner = evalResult
    ? evalResult.evaluated
      ? (
        <Banner kind="ok">
          <strong>{t('chat.evalTitle')}</strong>{' '}
          {t('chat.evalDetail', { mood: evalResult.mood, summary: evalResult.summaryLine, count: evalResult.memoriesWritten })}
        </Banner>
      )
      : (
        <Banner kind="error">
          <strong>{t('chat.evalFailedTitle')}</strong>{t('chat.evalFailedBody', { error: evalResult.evalError })}
        </Banner>
      )
    : null;

  // When a milestone or accepted "define the relationship" moment is the headline,
  // the evaluation note is shown below it rather than suppressed.
  const milestoneTookPrimary = !!milestone || dtrOutcome?.decision === 'accept';

  // Compute the single most-important outcome to surface. Only one is shown at a time.
  const primaryOutcome = (() => {
    if (evalResult?.ending) {
      return (
        <div className="date-moment date-moment-ending">
          <div className="date-moment-seal" aria-hidden="true">✦</div>
          <div className="date-moment-kicker">{t('chat.endingKicker')}</div>
          <div className="date-moment-title">{t('chat.endingTitle', { title: evalResult.ending.title })}</div>
          <p className="date-moment-body">{evalResult.ending.epilogue}</p>
          <p className="date-moment-note">
            {t('chat.endingNote')}
          </p>
        </div>
      );
    }
    // A walkout / lost-interest exit is the proximate thing that just happened on
    // screen, so it stays the PRIMARY moment even when the full evaluation it now
    // runs also ends the relationship — the breakup is surfaced as a consequence
    // note below (see the secondary outcomes). Checked above evalResult.breakup so a
    // walkout-induced breakup doesn't get re-skinned as an ordinary breakup card.
    if (walkout) {
      return (
        <div className="date-moment date-moment-walkout">
          <div className="date-moment-seal" aria-hidden="true">🚪</div>
          <div className="date-moment-kicker">{t('chat.walkoutKicker')}</div>
          <div className="date-moment-title">{t('chat.walkoutTitle', { name: character.name })}</div>
          <p className="date-moment-body">{walkout}</p>
          <p className="date-moment-note">{t('chat.walkoutNote')}</p>
        </div>
      );
    }
    if (leftEarly) {
      return (
        <div className="date-moment date-moment-walkout">
          <div className="date-moment-seal" aria-hidden="true">🌙</div>
          <div className="date-moment-kicker">{t('chat.leftEarlyKicker')}</div>
          <div className="date-moment-title">{t('chat.leftEarlyTitle', { name: character.name })}</div>
          <p className="date-moment-body">{t('chat.leftEarlyBody')}</p>
          <p className="date-moment-note">{t('chat.leftEarlyNote')}</p>
        </div>
      );
    }
    if (evalResult?.breakup) {
      return (
        <div className="date-moment date-moment-breakup">
          <div className="date-moment-seal" aria-hidden="true">💔</div>
          <div className="date-moment-kicker">{t('chat.breakupKicker')}</div>
          <div className="date-moment-title">{t('chat.breakupTitle', { name: character.name })}</div>
          <p className="date-moment-body">{evalResult.breakup.line}</p>
          <p className="date-moment-note">{t('chat.breakupNote')}</p>
        </div>
      );
    }
    if (brokeUp) {
      return (
        <div className="date-moment date-moment-breakup">
          <div className="date-moment-seal" aria-hidden="true">💔</div>
          <div className="date-moment-kicker">{t('chat.youEndedKicker')}</div>
          <div className="date-moment-title">{t('chat.youEndedTitle', { name: character.name })}</div>
          <p className="date-moment-body">{t('chat.youEndedBody')}</p>
        </div>
      );
    }
    if (milestone) {
      return (
        <div className="date-moment date-moment-milestone">
          <div className="date-moment-seal" aria-hidden="true">✦</div>
          <div className="date-moment-kicker">{t('chat.milestoneKicker')}</div>
          <div className="date-moment-title">{t('chat.milestoneTitle', { label: milestone.label })}</div>
          <p className="date-moment-body">{milestone.line}</p>
        </div>
      );
    }
    if (dtrOutcome) {
      if (dtrOutcome.decision === 'accept') {
        return (
          <div className="date-moment date-moment-milestone">
            <div className="date-moment-seal" aria-hidden="true">✦</div>
            <div className="date-moment-kicker">{t('chat.dtrConfirmedKicker')}</div>
            <div className="date-moment-title">{t('chat.dtrConfirmedTitle', { status: relationshipStatusLabel(dtrOutcome.status) })}</div>
          </div>
        );
      }
      if (dtrOutcome.decision === 'backfire') {
        return (
          <div className="date-moment date-moment-walkout">
            <div className="date-moment-seal" aria-hidden="true">⚠</div>
            <div className="date-moment-kicker">{t('chat.dtrBackfireKicker')}</div>
            <div className="date-moment-title">{t('chat.dtrBackfireTitle')}</div>
            {dtrOutcome.ended && <p className="date-moment-note">{t('chat.dtrEnded')}</p>}
          </div>
        );
      }
      return <Banner kind="info">{t('chat.dtrNotYet')}</Banner>;
    }
    if (evalResult) return evalBanner;
    return null;
  })();

  return (
    <div className="stack">
      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="info">{notice}</Banner>}
      <div className="chat-wrap date-wrap">
        <aside className="chat-side date-dossier">
          <div className="framed bracketed date-plate">
            <div className="kicker">{t('chat.yourCompanion')}</div>
            <div className="date-plate-portrait">
              <Portrait character={character} expression={expression} crossfade />
            </div>
            <div className="date-plate-name">{character.name}</div>
            <div className="date-plate-badges">
              {relationship && isBrokenUp(relationship) ? (
                <span className="badge danger"><Icon name="breakup" size={12} /> {t('chat.brokenUp')}</span>
              ) : (
                <>
                  {status !== 'none' && <span className="badge accent"><Icon name="date" size={12} /> {relationshipStatusLabel(status)}</span>}
                  {relationship && isOnTheRocks(relationship) && <span className="badge warn"><Icon name="warn" size={12} /> {t('chat.onTheRocks')}</span>}
                </>
              )}
              {expression && <span className="badge accent date-mood-chip">{expression}</span>}
            </div>
          </div>
          {relationship && (
            <div className={`card date-gauges ${milestone ? 'stage-up' : ''}`}>
              <div className="date-gauges-head">
                <div className="kicker">{t('chat.whereYouStand')}</div>
                <div className="trail" />
              </div>
              <RelationshipBars relationship={relationship} deltas={deltas ?? undefined} />
            </div>
          )}
          <div className="card date-actions">
            {dtrReady && !locked && (
              <button className="btn primary block date-dtr" onClick={defineRelationship} disabled={busy || streaming.active} title={t('chat.dtrTitle')}>
                <Icon name="commit" size={16} /> {rung!.rung.label}
              </button>
            )}
            {!locked && relationship && (
              <button
                className="btn ghost block date-gift-btn"
                onClick={() => (giftPicker ? setGiftPicker(false) : void openGiftPicker())}
                disabled={busy || streaming.active}
                title={t('chat.giveSomething')}
              >
                <Icon name="gift" size={15} /> {giftPicker ? t('chat.neverMind') : t('chat.giveGift')}
              </button>
            )}
            {giftPicker && !locked && (
              <div className="date-gift-picker">
                {giftItems.length === 0 ? (
                  <p className="muted date-gift-empty">{t('chat.giftEmpty')}</p>
                ) : (
                  giftItems.map((e) => (
                    <button
                      key={e.inventoryItem.id}
                      className="date-gift-item"
                      onClick={() => void giveGift(e.inventoryItem.id)}
                      disabled={busy || streaming.active}
                    >
                      <span className="date-gift-item-name">{e.item.name}</span>
                      <span className="date-gift-item-qty">×{e.inventoryItem.quantity}</span>
                    </button>
                  ))
                )}
              </div>
            )}
            {/* A date is held server-side, so there's no silent "abandon" while it's
                live — you finish it (End & evaluate), or back out of one you haven't
                spoken in (Cancel date, free). Once it's over, start a new one. */}
            {locked ? (
              <button className="btn ghost block" onClick={newConversation} disabled={busy} title={t('chat.newDateTitle')}>
                <Icon name="recap" size={14} /> {t('chat.newDate')}
              </button>
            ) : spokeThisSession ? (
              <>
                <button className="btn sm block" onClick={summarize} disabled={busy || streaming.active}>
                  <Icon name="recap" size={14} /> {t('chat.recap')}
                </button>
                <button className="btn ghost block date-end-btn" onClick={endDate} disabled={busy || streaming.active}>
                  {busy ? t('chat.evaluating') : <><Icon name="end" size={14} /> {t('chat.endEvaluate')}</>}
                </button>
              </>
            ) : (
              <button className="btn ghost block date-end-btn" onClick={cancelDate} disabled={busy || streaming.active}>
                {busy ? t('chat.leaving') : <><Icon name="leave" size={14} /> {t('chat.cancelDate')}</>}
              </button>
            )}
          </div>
        </aside>

        <section className="framed date-stage">
          <div className={`date-scene${locationImage ? ' has-photo' : ''}`}>
            {locationImage && (
              <div className="date-scene-backdrop" aria-hidden="true">
                <img src={assetUrl(locationImage)} alt="" />
              </div>
            )}
            {scene && cal && (
              <span className="date-scene-lead" title={t('chat.sceneLeadTitle', { weekday: weekdayLabel(cal.dayOfWeek), season: seasonLabel(cal.season) })}>
                <span className="ph">{PHASE_ICONS[scene.phase]}</span>
                <span className="day">
                  {t('chat.sceneDay', { day: scene.day })}<span className="ph-label">{phaseLabel(scene.phase)}</span>
                </span>
              </span>
            )}
            <span className="date-chip date-chip-place">
              <span className="ico"><Icon name="location" size={13} /></span> {locationName}
            </span>
            {scene && (
              <span className="date-chip">
                <span className="ico">{scene.weatherIcon}</span> {scene.weatherLabel}
              </span>
            )}
            {scene?.mood && (
              <span className="date-chip">
                <span className="ico">{scene.moodIcon}</span> {t('chat.seems', { name: character.name, mood: scene.mood })}
              </span>
            )}
          </div>
          {!locked && (
            <DateTrajectory
              value={rapport}
              anchor={startingRapport(character.guardedness)}
              label={vibe ?? t('chat.settlingIn')}
              pulse={rapportPulse}
            />
          )}
          <div className="messages date-reel">
            {messages.length === 0 && !streaming.active && (
              <div className="date-opening">
                <div className="date-opening-portrait">
                  <Portrait character={character} expression={expression} crossfade />
                </div>
                <div className="date-opening-copy">
                  <div className="date-opening-name">{character.name}</div>
                  <p className="date-opening-scene">
                    {scene?.mood
                      ? t('chat.openingWithMood', {
                          name: character.name,
                          mood: scene.mood,
                          atLocation: locationName !== t('chat.loc.anywhere') ? t('chat.openingAtLocation', { location: locationName }) : '',
                          weather: scene.weatherLabel ? t('chat.openingWeather', { weather: scene.weatherLabel.toLowerCase() }) : '',
                        })
                      : locationName !== t('chat.loc.anywhere')
                        ? t('chat.openingWaitingAt', { name: character.name, location: locationName })
                        : t('chat.openingWaiting', { name: character.name })}
                  </p>
                  <div className="date-opening-cue">{t('chat.sayHello')}</div>
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`date-msg ${m.role}${m.role === 'narrator' && m.metadata?.venueFlavor === true ? ' venue-flavor' : ''}`}
              >
                {m.text}
                {m.id === regenId && (
                  <button
                    className="date-regen-btn"
                    onClick={() => void regenerate()}
                    aria-label={t('chat.regen')}
                    title={t('chat.regenTitle')}
                  >
                    <Icon name="refresh" size={13} />
                  </button>
                )}
              </div>
            ))}
            {streaming.active && (
              <div className="date-msg character">
                {streaming.text.trim() ? (
                  <>
                    {streaming.text.trimStart()}
                    <span className="date-cursor" />
                  </>
                ) : (
                  <span className="date-typing" aria-label="typing">
                    <span />
                    <span />
                    <span />
                  </span>
                )}
              </div>
            )}
            <div ref={messagesEnd} />
          </div>

          <div className="date-foot">
          {/* Prioritised outcome surface — one moment at a time */}
          {primaryOutcome}

          {/* Secondary outcomes — quiet notes below the primary moment */}
          {milestoneTookPrimary && evalBanner}
          {(walkout || leftEarly) && evalResult?.breakup && (
            <Banner kind="error">
              <Icon name="breakup" size={14} /> <strong>{t('chat.breakupTitle', { name: character.name })}</strong>{' '}
              {evalResult.breakup.line}
            </Banner>
          )}
          {evalResult?.reconciled && (
            <Banner kind="ok">
              <Icon name="date" size={14} /> <strong>{t('chat.backTogether', { name: character.name })}</strong> {t('chat.backTogetherNote')}
            </Banner>
          )}
          {evalResult?.onTheRocks && !evalResult.breakup && (
            <Banner kind="info">
              <Icon name="warn" size={14} /> <strong>{t('chat.rocksTitle')}</strong> {t('chat.rocksNote')}
            </Banner>
          )}
          {evalResult?.jealousy?.triggered && (
            <Banner kind="error"><Icon name="breakup" size={14} /> {evalResult.jealousy.message}</Banner>
          )}

          {failed && !locked && !breakupPending && (
            <div className="date-retry" role="alert">
              <span className="date-retry-msg">
                <Icon name="warn" size={14} />
                {failed.kind === 'reply' ? t('chat.replyFailed') : t('chat.sendFailed')}
              </span>
              <button className="btn sm date-retry-btn" onClick={() => void retry()} disabled={streaming.active || busy}>
                <Icon name="refresh" size={14} /> {streaming.active ? t('chat.retrying') : t('chat.retry')}
              </button>
            </div>
          )}

          {locked ? (
            <div className="date-restart">
              <button className="btn" onClick={newConversation}>
                <Icon name="recap" size={14} /> {t('chat.startOver')}
              </button>
            </div>
          ) : breakupPending ? (
            <div className="date-breakup">
              <div className="date-breakup-title"><Icon name="breakup" size={16} /> {t('chat.breakupConfirmTitle', { name: character.name })}</div>
              <p>
                {t('chat.breakupConfirmBody', { name: character.name })}
              </p>
              <div className="row">
                <button className="btn danger" onClick={confirmBreakup} disabled={busy}>
                  {busy ? t('chat.ending') : <><Icon name="breakup" size={14} /> {t('chat.confirmBreakup')}</>}
                </button>
                <button className="btn ghost" onClick={cancelBreakup} disabled={busy}>
                  {t('chat.neverMind')}
                </button>
              </div>
            </div>
          ) : (
            <div className="date-input-wrap">
              {relationship && (
                <div className="intent-chips" role="group" aria-label={t('chat.intentComing')}>
                  {availableIntents(relationship).map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      className={`intent-chip${intent === opt ? ' active' : ''}`}
                      aria-pressed={intent === opt}
                      disabled={streaming.active}
                      onClick={() => setIntent((cur) => (cur === opt ? null : opt))}
                    >
                      <span className="intent-chip-emoji">{INTENT_ICONS[opt]}</span>
                      {intentLabel(opt)}
                    </button>
                  ))}
                </div>
              )}
              <div className="chat-input date-composer">
                <textarea
                  value={input}
                  placeholder={intent ? t('chat.composerIntent', { intent: intentLabel(intent), name: character.name }) : t('chat.composerPlain', { name: character.name })}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <button className="btn primary date-send" onClick={() => void send()} disabled={streaming.active || !input.trim()}>
                  <Icon name="send" size={15} />
                </button>
              </div>
            </div>
          )}
          </div>
        </section>
      </div>
    </div>
  );
}
