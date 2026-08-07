import { Fragment, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  RELATIONSHIP_STAT_KEYS,
  currentStatus,
  isBrokenUp,
  nextDtrRung,
  DTR_COOLDOWN_DAYS,
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
  type ConversationContextEstimate,
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
  type ConversationParticipant,
} from '@dsim/shared';
import { api, streamChat, streamRetry, streamRegenerate, assetUrl } from '../lib/api';
import { errorMessage } from '../lib/hooks';
import { activeDateParticipantNames } from '../lib/active-date';
import { contextUsagePercent, contextUsageTone } from '../lib/context-window';
import { useAppData } from '../state/app-context';
import { intentLabel, intentTip, phaseLabel, relationshipStatusLabel, seasonLabel, weekdayLabel } from '../i18n/labels';
import { Portrait } from '../components/Portrait';
import { DateOnboarding, DATE_ONBOARDING_KEY } from '../components/DateOnboarding';
import { Icon } from '../components/Icon';
import { RelationshipBars } from '../components/StatBars';
import { RichLine } from '../components/RichText';
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
/** Single-slot unsent-message draft (one live date at a time). */
const DATE_DRAFT_KEY = 'dsim.dateDraft';

/** Reaction-chip copy, indexed by judged engagement + 3 (−3 … +3). */
const REACTION_KEYS = [
  'pages:chat.reaction.m3',
  'pages:chat.reaction.m2',
  'pages:chat.reaction.m1',
  'pages:chat.reaction.zero',
  'pages:chat.reaction.p1',
  'pages:chat.reaction.p2',
  'pages:chat.reaction.p3',
] as const;

function hasUnansweredAttendee(
  session: ConversationSession,
  messages: Message[],
  participants: ConversationParticipant[],
): boolean {
  const playerIndex = messages.findLastIndex((message) => message.role === 'player');
  if (playerIndex < 0) return false;
  const answered = new Set(
    messages
      .slice(playerIndex + 1)
      .filter((message) => message.role === 'character')
      .map((message) => message.characterId ?? session.characterId),
  );
  return participants.some((participant) => participant.state === 'present' && !answered.has(participant.characterId));
}

async function loadParticipantCharacters(
  participants: ConversationParticipant[],
  known: Character[] = [],
): Promise<Character[]> {
  return Promise.all(
    participants.map((participant) => {
      const cached = known.find((character) => character.id === participant.characterId);
      return cached ?? api.getCharacter(participant.characterId);
    }),
  );
}

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
  // The label word reads absolute warmth, so its color keys to the raw value — but
  // before any judged read exists (value null), the "settling in" fallback stays
  // neutral rather than borrowing a guarded character's cool opening tone.
  const tone = value == null ? 'mid' : v >= 60 ? 'good' : v < 40 ? 'bad' : 'mid';
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
    participantId: '',
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
    moodsByCharacter: Record<string, { moodIcon: string | null; mood: string | null }>;
  } | null>(null);

  const [session, setSession] = useState<ConversationSession | null>(null);
  const [character, setCharacter] = useState<Character | null>(null);
  const [participants, setParticipants] = useState<ConversationParticipant[]>([]);
  const [participantCharacters, setParticipantCharacters] = useState<Character[]>([]);
  /** Relationship-specific actions on a group date are addressed to this person. */
  const [actionTargetId, setActionTargetId] = useState<string | null>(null);
  const [relationship, setRelationship] = useState<Relationship | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [contextEstimate, setContextEstimate] = useState<ConversationContextEstimate | null>(null);
  const [input, setInput] = useState('');
  const [intent, setIntent] = useState<Intent | null>(null);
  const [streaming, setStreaming] = useState<{ active: boolean; text: string }>({ active: false, text: '' });
  const [streamingCharacterId, setStreamingCharacterId] = useState<string | null>(null);
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
    | { kind: 'send'; text: string; intent?: Intent; targetCharacterId?: string; priorPlayerTurns: number }
    | null
  >(null);
  const [walkout, setWalkout] = useState<string | null>(null);
  // Live "how it's going" read: the vibe word, the numeric trajectory (0..100,
  // internal — center 50), and the signed change this turn for the +N/−N flourish.
  const [vibe, setVibe] = useState<string | null>(null);
  const [rapport, setRapport] = useState<number | null>(null);
  const [rapportPulse, setRapportPulse] = useState<{ delta: number; key: number } | null>(null);
  const [participantPulses, setParticipantPulses] = useState<
    Record<string, { delta: number; key: number } | null>
  >({});
  const [leftEarly, setLeftEarly] = useState(false);
  // The player typed something that read as a breakup — awaiting their confirm.
  const [breakupPending, setBreakupPending] = useState<{
    reaction: 'accept' | 'hurt' | 'plead';
    characterId: string;
  } | null>(null);
  const [brokeUp, setBrokeUp] = useState(false);
  // A resumed transcript ended on a walkout/leave/farewell line the live SSE
  // handlers never got to act on (tab closed mid-turn) — conclude the date as
  // soon as the resumed session is on screen, like the live handlers would have.
  const [autoEnd, setAutoEnd] = useState(false);
  // First-date walkthrough: auto-opens once EVER (client-global localStorage,
  // across worlds and saves), and reopenable from the rail's "How dating works".
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const closeOnboarding = () => {
    setOnboardingOpen(false);
    localStorage.setItem(DATE_ONBOARDING_KEY, '1');
  };
  // The world already checked for an unacknowledged end-of-date report this mount.
  const replayCheckedRef = useRef<string | null>(null);
  // End-of-date reports already shown this mount. The replay check must never
  // re-apply one the player just watched live, even while its server ack is
  // still in flight — the ack is fire-and-forget, so a race is otherwise real.
  const seenResultsRef = useRef<Set<string>>(new Set());
  const messagesEnd = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Mirrors the live session id so async handlers can detect that the player
  // abandoned this date (New / world-switch) before their request resolved.
  const sessionIdRef = useRef<string | null>(null);
  const actionTargetRef = useRef<string | null>(null);
  useEffect(() => {
    sessionIdRef.current = session?.id ?? null;
  }, [session]);
  useEffect(() => {
    actionTargetRef.current = actionTargetId;
  }, [actionTargetId]);

  const selectedActionTargetId = actionTargetId ?? session?.characterId ?? null;

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Show the first-date walkthrough when the FIRST date ever opens (fresh start
  // or resume alike) — the seen-flag is client-global, spanning worlds and saves.
  // Mark it seen the moment it AUTO-OPENS, not on close: a refresh, tab close, or
  // dev hot-reload while the modal is up would otherwise never write the flag,
  // and the walkthrough would greet every subsequent date mount. Worst case the
  // player glimpsed card one — the rail's "How dating works" button is the
  // deliberate way back in.
  useEffect(() => {
    if (session?.mode === 'date' && localStorage.getItem(DATE_ONBOARDING_KEY) !== '1') {
      localStorage.setItem(DATE_ONBOARDING_KEY, '1');
      setOnboardingOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  // Unsent-message draft: a single slot (there's one live date at a time), so a
  // refresh or accidental navigation mid-thought doesn't eat the line you were
  // composing. Restores only into an empty box, for this session only; sending
  // clears the box, which clears the slot; a new session's empty box sweeps a
  // stale slot from a finished date.
  useEffect(() => {
    if (!session) return;
    try {
      const raw = localStorage.getItem(DATE_DRAFT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { sessionId?: string; text?: string };
      if (saved.sessionId === session.id && typeof saved.text === 'string' && saved.text) {
        setInput((cur) => (cur ? cur : saved.text!));
      }
    } catch {
      /* a corrupt slot is just dropped */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);
  useEffect(() => {
    if (!session) return;
    try {
      if (input.trim()) localStorage.setItem(DATE_DRAFT_KEY, JSON.stringify({ sessionId: session.id, text: input }));
      else localStorage.removeItem(DATE_DRAFT_KEY);
    } catch {
      /* storage full — losing a draft is acceptable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, session?.id]);

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

  // Keep the scene card (day / weather / mood) in sync if the world clock
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
          moodsByCharacter: Object.fromEntries(
            ww.characters.map((entry) => [entry.id, { moodIcon: entry.moodIcon ?? null, mood: entry.mood ?? null }]),
          ),
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

  // Estimate the actual next model request after each completed turn. Group dates
  // use the largest attendee-specific prompt, so the meter reflects the request
  // most likely to hit the configured model limit rather than an optimistic average.
  useEffect(() => {
    const sessionId = session?.id;
    if (!sessionId) {
      setContextEstimate(null);
      return;
    }
    if (streaming.active || dateConcluded) return;

    let live = true;
    void api
      .getConversationContextEstimate(sessionId)
      .then((estimate) => {
        if (live && sessionIdRef.current === sessionId) setContextEstimate(estimate);
      })
      .catch(() => {
        if (live && sessionIdRef.current === sessionId) setContextEstimate(null);
      });
    return () => {
      live = false;
    };
  }, [session?.id, messages, participants, streaming.active, dateConcluded]);

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
    setAutoEnd(false);
    setRapportPulse(null);
    setParticipantPulses({});
    setActionTargetId(null);
    setIntent(null);
    setFailed(null);
    try {
      // Pull the character, transcript, and FRESH date state together. The `ad`
      // snapshot handed to us can be stale — the context's activeDate is only
      // refetched when a date starts/ends (and on world change), so mid-date its
      // rapport/vibe/mood still read the start-of-date null; trusting it would empty
      // the bar and drop the mood on a leave-and-return. Fetch server truth here.
      const [c, sm, fresh] = await Promise.all([
        api.getCharacter(ad.characterId),
        api.getConversation(ad.sessionId),
        refreshActiveDate(),
      ]);
      const rosterCharacters = await loadParticipantCharacters(sm.participants, [c]);
      // The context can briefly point at a session that just ended elsewhere — never
      // reopen a finished date. Reconcile (await, so the lock clears) and fall back
      // to setup; the resumeFailed flag is a harmless no-op once activeDate is null.
      if (sm.session.ended) {
        await refreshActiveDate();
        setResumeFailed(true);
        return;
      }
      setSetup((s) => ({
        ...s,
        characterId: ad.characterId,
        participantId: sm.participants.find((participant) => participant.characterId !== ad.characterId)?.characterId ?? '',
        locationId: sm.session.locationId ?? '',
      }));
      setSession(sm.session);
      setCharacter(c);
      setActionTargetId(ad.characterId);
      setParticipants(sm.participants);
      setParticipantCharacters(rosterCharacters);
      setMessages(sm.messages);
      // Re-derive the retry bar from server truth so it survives a refresh / resume:
      // a transcript ending in an unanswered player turn means the reply never came.
      const lastMsg = sm.messages[sm.messages.length - 1];
      if (hasUnansweredAttendee(sm.session, sm.messages, sm.participants)) setFailed({ kind: 'reply' });
      // Re-derive a terminal exit the SSE stream never delivered (tab closed/refreshed
      // mid-turn): a trailing consequence-bearing character line means the scene
      // already ended in-fiction. Restore the matching moment and conclude the date —
      // exactly what the live handlers do — instead of letting the player chat past a
      // walkout/goodbye they never saw. A pending breakup re-raises its confirm.
      if (lastMsg && lastMsg.role === 'character') {
        const md = lastMsg.metadata ?? {};
        const terminal = !sm.participants.some((participant) => participant.state === 'present');
        if (md.walkout === true) {
          if (terminal) {
            setWalkout(t('chat.walkoutDefault'));
            setAutoEnd(true);
          }
        } else if (md.left === true) {
          if (terminal) {
            setLeftEarly(true);
            setVibe(null);
            setAutoEnd(true);
          }
        } else if (md.farewell === true) {
          if (terminal) setAutoEnd(true);
        } else if (md.breakupIntent === true) {
          const r = md.breakupReaction;
          setBreakupPending({
            reaction: r === 'accept' || r === 'hurt' || r === 'plead' ? r : 'hurt',
            characterId: lastMsg.characterId ?? sm.session.characterId,
          });
        }
      }
      setRelationship(await api.getRelationship(c.id));
      // Restore the live trajectory + mood from the fresh read fetched above (matched
      // by session id), falling back to the `ad` snapshot only if it drifted.
      const live = fresh && fresh.sessionId === ad.sessionId ? fresh : ad;
      setParticipants(live.participants);
      setExpression(live.expression);
      setVibe(live.vibe);
      setRapport(live.rapport);
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
          moodsByCharacter: Object.fromEntries(
            ww.characters.map((entry) => [entry.id, { moodIcon: entry.moodIcon ?? null, mood: entry.mood ?? null }]),
          ),
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

  // If the selected addressee leaves, move the action focus to the next person
  // still at the table and refresh the relationship shown in the rail.
  useEffect(() => {
    if (!session || participants.length < 2) return;
    if (participants.some((entry) => entry.characterId === actionTargetId && entry.state === 'present')) return;
    const next = participants.find((entry) => entry.state === 'present');
    if (!next) return;
    setActionTargetId(next.characterId);
    actionTargetRef.current = next.characterId;
    setGiftPicker(false);
    void api.getRelationship(next.characterId).then((rel) => {
      if (actionTargetRef.current === next.characterId) setRelationship(rel);
    }).catch(() => undefined);
  }, [actionTargetId, participants, session]);

  // Replay an end-of-date report whose HTTP response was lost (the tab closed or
  // refreshed while the evaluator ran): the server persists the report as the date
  // concludes, so instead of silently dropping the player onto the plan-a-date
  // screen — with the date's costs and consequences already applied — restore the
  // concluded date and its recap card once, then acknowledge it.
  useEffect(() => {
    if (!activeWorldId || !activeDateLoaded || activeDate || session || starting || resuming) return;
    if (replayCheckedRef.current === activeWorldId) return; // once per world per mount
    replayCheckedRef.current = activeWorldId;
    let live = true;
    void (async () => {
      try {
        const { result } = await api.pendingDateResult(activeWorldId);
        if (!live || !result || !result.session.ended) return;
        if (seenResultsRef.current.has(result.session.id)) return; // shown live already
        seenResultsRef.current.add(result.session.id);
        const [c, sm, rel] = await Promise.all([
          api.getCharacter(result.session.characterId),
          api.getConversation(result.session.id),
          api.getRelationship(result.session.characterId),
        ]);
        if (!live || sessionIdRef.current) return; // a date opened meanwhile — don't clobber it
        setSetup((s) => ({
          ...s,
          characterId: c.id,
          participantId: sm.participants.find((participant) => participant.characterId !== c.id)?.characterId ?? '',
          locationId: result.session.locationId ?? '',
        }));
        setSession(result.session);
        setCharacter(c);
        setActionTargetId(c.id);
        setParticipants(sm.participants);
        setParticipantCharacters(await loadParticipantCharacters(sm.participants, [c]));
        setMessages(sm.messages);
        setRelationship(rel);
        setEvalResult(result);
        setMilestone(result.milestone ?? null);
        if (result.expression) setExpression(result.expression);
      } catch {
        /* replay is best-effort — the plan-a-date screen is a fine fallback */
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorldId, activeDateLoaded, activeDate, session, starting, resuming]);

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
    setRapport(null);
    setRapportPulse(null);
    setParticipantPulses({});
    setActionTargetId(null);
    setParticipants([]);
    setParticipantCharacters([]);
    setLeftEarly(false);
    setBreakupPending(null);
    setBrokeUp(false);
    setAutoEnd(false);
    setResumeFailed(false);
    setScene(null);
    setIntent(null);
    setFailed(null);
    try {
      const c = await api.getCharacter(setup.characterId);
      const created = await api.createConversation({
        characterId: setup.characterId,
        participantIds: setup.participantId ? [setup.participantId] : [],
        mode: setup.mode,
        locationId: setup.locationId || null,
      });
      setSession(created);
      setCharacter(c);
      setActionTargetId(c.id);
      // A date is now open server-side — engage the world's "date underway" lock
      // (Sleep / Work / Minigames) and light the Date-tab badge.
      void refreshActiveDate();
      setRelationship(await api.getRelationship(c.id));
      // On a first date the character opens the conversation, so load any message
      // the server already persisted (empty for repeat dates → the player opens).
      try {
        const sm = await api.getConversation(created.id);
        setParticipants(sm.participants);
        setParticipantCharacters(await loadParticipantCharacters(sm.participants, [c]));
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
              moodsByCharacter: Object.fromEntries(
                ww.characters.map((entry) => [entry.id, { moodIcon: entry.moodIcon ?? null, mood: entry.mood ?? null }]),
              ),
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
  const send = async (resend?: { text: string; intent?: Intent; targetCharacterId?: string }) => {
    const text = (resend?.text ?? input).trim();
    if (!text || !session || streaming.active || busy) return;
    const chosenIntent = resend ? resend.intent : intent ?? undefined;
    const chosenTarget = resend?.targetCharacterId ?? selectedActionTargetId ?? undefined;
    if (!resend) {
      setInput('');
      setIntent(null);
    }
    setError(undefined);
    setNotice(undefined);
    setFailed(null);
    // A new turn supersedes a transient DTR read: clear a lingering "not yet" (deflect)
    // banner so it can't stay pinned all date or shadow the end-of-date evaluation. An
    // accepted DTR is a milestone we keep as the primary outcome.
    if (dtrOutcome && dtrOutcome.decision !== 'accept') setDtrOutcome(null);
    setStreaming({ active: true, text: '' });
    setStreamingCharacterId(null);
    const controller = new AbortController();
    abortRef.current = controller;
    let playerPersisted = false;
    let settled = false; // a terminal event (done/error/walkout/…) arrived
    // Baseline to detect (on a retry) whether THIS turn persisted despite a missed
    // 'player' event — by the player-turn count growing, not the trailing role.
    const priorPlayerTurns = messages.filter((m) => m.role === 'player').length;
    const recover = () =>
      playerPersisted
        ? { kind: 'reply' as const }
        : { kind: 'send' as const, text, intent: chosenIntent, targetCharacterId: chosenTarget, priorPlayerTurns };
    try {
      await streamChat(
        session.id,
        text,
        {
          onPlayer: (m) => {
            playerPersisted = true;
            setMessages((prev) => [...prev, m]);
          },
          onSpeaker: (characterId) => {
            setStreamingCharacterId(characterId);
            setStreaming({ active: true, text: '' });
          },
          onDelta: (delta, characterId) => {
            if (characterId) setStreamingCharacterId(characterId);
            setStreaming((s) => ({ active: true, text: s.text + delta }));
          },
          onDone: (m, complete) => {
            settled = complete;
            setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
            setStreaming({ active: !complete, text: '' });
            setStreamingCharacterId(null);
          },
          onError: (msg) => {
            settled = true;
            setError(msg);
            setStreaming({ active: false, text: '' });
            setStreamingCharacterId(null);
            setFailed(recover());
          },
          onNotice: (msg) => setNotice(msg),
          onWalkout: (m, reason, characterId, terminal = true) => {
            setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
            if (characterId) {
              setParticipants((prev) =>
                prev.map((participant) =>
                  participant.characterId === characterId ? { ...participant, state: 'walked_out' } : participant,
                ),
              );
            }
            if (terminal) {
              settled = true;
              setStreaming({ active: false, text: '' });
              setStreamingCharacterId(null);
              setWalkout(reason || t('chat.walkoutDefault'));
              void endDate();
            }
          },
          onBreakupIntent: (m, reaction, characterId) => {
            settled = true;
            setMessages((prev) => [...prev, m]);
            setStreaming({ active: false, text: '' });
            setStreamingCharacterId(null);
            setBreakupPending({ reaction, characterId: characterId ?? session.characterId });
          },
          onRapport: (label, expr, rap, delta, engagement, messageId, characterId) => {
            const targetId = characterId ?? session.characterId;
            setParticipants((prev) =>
              prev.map((participant) =>
                participant.characterId === targetId
                  ? { ...participant, vibe: label, expression: expr || participant.expression, rapport: rap, judged: true }
                  : participant,
              ),
            );
            if (targetId === session.characterId) {
              setVibe(label);
              if (expr) setExpression(expr);
              setRapport(rap);
            }
            if (delta) {
              setRapportPulse((p) => ({ delta, key: (p?.key ?? 0) + 1 }));
              setParticipantPulses((prev) => ({
                ...prev,
                [targetId]: { delta, key: (prev[targetId]?.key ?? 0) + 1 },
              }));
            }
            // Mirror the server's metadata stamp so the reaction chip appears live.
            if (engagement !== undefined && messageId) {
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== messageId) return m;
                  const prior = m.metadata.engagementByCharacter;
                  const engagementByCharacter =
                    prior && typeof prior === 'object' && !Array.isArray(prior)
                      ? { ...(prior as Record<string, unknown>), [targetId]: engagement }
                      : { [targetId]: engagement };
                  return {
                    ...m,
                    metadata: {
                      ...m.metadata,
                      engagementByCharacter,
                      ...(targetId === session.characterId ? { engagement } : {}),
                    },
                  };
                }),
              );
            }
          },
          onLeft: (m, _reason, characterId, terminal = true) => {
            setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
            if (characterId) {
              setParticipants((prev) =>
                prev.map((participant) =>
                  participant.characterId === characterId ? { ...participant, state: 'left_early' } : participant,
                ),
              );
            }
            if (terminal) {
              settled = true;
              setStreaming({ active: false, text: '' });
              setStreamingCharacterId(null);
              setLeftEarly(true);
              setVibe(null);
              void endDate();
            }
          },
          onFarewell: (m, expr, characterId, terminal = true) => {
            // The player ended the date by chatting (a natural goodbye). Show the
            // character's send-off, then run the normal end-and-evaluate flow so the
            // date is scored in full — no need to click "End & evaluate".
            settled = true;
            setMessages((prev) => (prev.some((entry) => entry.id === m.id) ? prev : [...prev, m]));
            setStreaming({ active: false, text: '' });
            setStreamingCharacterId(null);
            if (characterId) {
              setParticipants((prev) =>
                prev.map((participant) =>
                  participant.characterId === characterId
                    ? { ...participant, state: 'departed', expression: expr || participant.expression }
                    : participant,
                ),
              );
              if (characterId === session.characterId && expr) setExpression(expr);
            }
            if (terminal) void endDate();
          },
        },
        controller.signal,
        chosenIntent,
        chosenTarget,
      );
      // The stream ended with no terminal event (the connection dropped mid-reply):
      // recover instead of leaving the typing indicator spinning forever.
      if (!settled && !controller.signal.aborted) {
        setStreaming({ active: false, text: '' });
        setStreamingCharacterId(null);
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
      setStreamingCharacterId(null);
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
        setParticipants(sm.participants);
        const newPlayerTurns = sm.messages.filter((m) => m.role === 'player').length;
        if (newPlayerTurns > failed.priorPlayerTurns) {
          // The turn WAS saved (count grew). It is complete only once every attendee
          // who is still present has answered it.
          if (!hasUnansweredAttendee(sm.session, sm.messages, sm.participants)) {
            setMessages(sm.messages);
            setFailed(null);
            return;
          }
          setMessages(sm.messages);
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
      const { text, intent: keptIntent, targetCharacterId } = failed;
      setFailed(null);
      await send({ text, intent: keptIntent, targetCharacterId });
      return;
    }

    setFailed(null);
    setError(undefined);
    setNotice(undefined);
    setStreaming({ active: true, text: '' });
    setStreamingCharacterId(null);
    const controller = new AbortController();
    abortRef.current = controller;
    let settled = false;
    try {
      await streamRetry(
        session.id,
        {
          onSpeaker: (characterId) => {
            setStreamingCharacterId(characterId);
            setStreaming({ active: true, text: '' });
          },
          onDelta: (delta, characterId) => {
            if (characterId) setStreamingCharacterId(characterId);
            setStreaming((s) => ({ active: true, text: s.text + delta }));
          },
          onDone: (m, complete) => {
            settled = complete;
            setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
            setStreaming({ active: !complete, text: '' });
            setStreamingCharacterId(null);
          },
          onError: (msg) => {
            settled = true;
            setError(msg);
            setStreaming({ active: false, text: '' });
            setStreamingCharacterId(null);
            setFailed({ kind: 'reply' });
          },
          onNotice: (msg) => setNotice(msg),
          onWalkout: (m, reason, characterId, terminal = true) => {
            setMessages((prev) => (prev.some((entry) => entry.id === m.id) ? prev : [...prev, m]));
            if (characterId) {
              setParticipants((prev) =>
                prev.map((participant) =>
                  participant.characterId === characterId ? { ...participant, state: 'walked_out' } : participant,
                ),
              );
            }
            if (terminal) {
              settled = true;
              setStreaming({ active: false, text: '' });
              setStreamingCharacterId(null);
              setWalkout(reason || t('chat.walkoutDefault'));
              void endDate();
            }
          },
          onLeft: (m, _reason, characterId, terminal = true) => {
            setMessages((prev) => (prev.some((entry) => entry.id === m.id) ? prev : [...prev, m]));
            if (characterId) {
              setParticipants((prev) =>
                prev.map((participant) =>
                  participant.characterId === characterId ? { ...participant, state: 'left_early' } : participant,
                ),
              );
            }
            if (terminal) {
              settled = true;
              setStreaming({ active: false, text: '' });
              setStreamingCharacterId(null);
              setLeftEarly(true);
              setVibe(null);
              void endDate();
            }
          },
        },
        controller.signal,
      );
      if (!settled && !controller.signal.aborted) {
        setStreaming({ active: false, text: '' });
        setStreamingCharacterId(null);
        setError(t('chat.replyDropped'));
        setFailed({ kind: 'reply' });
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(errorMessage(e));
        setFailed({ kind: 'reply' });
      }
      setStreaming({ active: false, text: '' });
      setStreamingCharacterId(null);
    }
  };

  // Rewrite the character's MOST RECENT reply (a bad/looping line) without re-judging
  // the turn. Optimistically drop the old reply — the server deletes it and streams a
  // fresh one against the same player turn. On ANY failure, resync the transcript from
  // the server: the drop itself may have been refused (the old reply still exists) or
  // may have succeeded before generation failed (it's gone) — only the server knows
  // which, and guessing left the on-screen thread silently diverged from the server's.
  const regenerate = async () => {
    if (!session || streaming.active || busy || locked) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'character') return;
    const sid = session.id;
    const resync = () =>
      void api
        .getConversation(sid)
        .then((sm) => {
          if (sessionIdRef.current === sid) setMessages(sm.messages);
        })
        .catch(() => undefined); // keep the optimistic view — the retry affordance still recovers
    setError(undefined);
    setNotice(undefined);
    setFailed(null);
    setMessages((prev) => prev.slice(0, -1));
    setStreaming({ active: true, text: '' });
    setStreamingCharacterId(last.characterId ?? session.characterId);
    const controller = new AbortController();
    abortRef.current = controller;
    let settled = false;
    try {
      await streamRegenerate(
        sid,
        {
          onSpeaker: (characterId) => {
            setStreamingCharacterId(characterId);
            setStreaming({ active: true, text: '' });
          },
          onDelta: (delta, characterId) => {
            if (characterId) setStreamingCharacterId(characterId);
            setStreaming((s) => ({ active: true, text: s.text + delta }));
          },
          onDone: (m, complete) => {
            settled = complete;
            setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
            setStreaming({ active: false, text: '' });
            setStreamingCharacterId(null);
          },
          onError: (msg) => {
            settled = true;
            setError(msg);
            setStreaming({ active: false, text: '' });
            setStreamingCharacterId(null);
            setFailed({ kind: 'reply' });
            resync();
          },
          onNotice: (msg) => setNotice(msg),
        },
        controller.signal,
      );
      if (!settled && !controller.signal.aborted) {
        setStreaming({ active: false, text: '' });
        setStreamingCharacterId(null);
        setError(t('chat.replyDropped'));
        setFailed({ kind: 'reply' });
        resync();
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(errorMessage(e));
        setFailed({ kind: 'reply' });
        resync();
      }
      setStreaming({ active: false, text: '' });
      setStreamingCharacterId(null);
    }
  };

  const newConversation = () => {
    abortRef.current?.abort();
    setStreaming({ active: false, text: '' });
    setStreamingCharacterId(null);
    setSession(null);
    setCharacter(null);
    setParticipants([]);
    setParticipantCharacters([]);
    setActionTargetId(null);
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
    setParticipantPulses({});
    setLeftEarly(false);
    setBreakupPending(null);
    setBrokeUp(false);
    setAutoEnd(false);
    setScene(null);
    setIntent(null);
    setFailed(null);
  };

  // The report was already acknowledged when it was shown (live in endDate) or
  // delivered (the replay fetch retires it server-side) — leaving the recap is
  // purely a client-state reset.
  const dismissRecap = () => newConversation();

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

  const selectActionTarget = async (characterId: string) => {
    if (characterId === selectedActionTargetId) return;
    setActionTargetId(characterId);
    actionTargetRef.current = characterId;
    setGiftPicker(false);
    setDtrOutcome(null);
    setDeltas(null);
    try {
      const rel = await api.getRelationship(characterId);
      if (actionTargetRef.current === characterId) setRelationship(rel);
    } catch (e) {
      if (actionTargetRef.current === characterId) setError(errorMessage(e));
    }
  };

  const defineRelationship = async () => {
    if (!session) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.defineRelationship(session.id, selectedActionTargetId ?? undefined);
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
      const res = await api.giftOnDate(sid, inventoryItemId, selectedActionTargetId ?? undefined);
      if (sessionIdRef.current !== sid) return; // player switched dates mid-gift
      // The "🎁 you gave …" beat + the character's reaction land in the transcript.
      setMessages((prev) => [...prev, res.narratorMessage, res.message]);
      setRelationship(res.relationship);
      setParticipants((prev) =>
        prev.map((participant) =>
          participant.characterId === res.characterId
            ? { ...participant, expression: res.expression || participant.expression }
            : participant,
        ),
      );
      if (res.characterId === session.characterId && res.expression) setExpression(res.expression);
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
      const res = await api.confirmBreakup(session.id, breakupPending?.characterId);
      setRelationship(res.relationship);
      setSession((s) => (s ? { ...s, ended: res.ended || s.ended } : s));
      if (!res.ended) {
        setParticipants((prev) =>
          prev.map((participant) =>
            participant.characterId === res.characterId ? { ...participant, state: 'departed' } : participant,
          ),
        );
      }
      setBreakupPending(null);
      setBrokeUp(res.ended);
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
      // The evaluator is required to conclude a manual end. If it failed, the server
      // keeps the date OPEN (session.ended stays false, evaluated=false) — surface a
      // retryable error and do NOT conclude/lock the date, so the player can try again
      // once the model is back. (A walkout/farewell still ends: session.ended is true.)
      if (!result.session.ended && !result.evaluated) {
        setError(result.evalError || t('chat.evalFailed'));
        return;
      }
      setEvalResult(result);
      setSession(result.session);
      // The recap is on screen — acknowledge the durable report NOW, not on the
      // dismiss click. The persisted copy exists to recover a LOST response; this
      // one arrived, and deferring the ack to a button the player may never press
      // made the recap replay on Date-tab visits for days afterwards.
      seenResultsRef.current.add(sid);
      void api.markDateResultSeen(sid).catch(() => undefined);
      const selectedResult = result.participantResults.find(
        (entry) => entry.characterId === selectedActionTargetId,
      );
      const resultRelationship = selectedResult?.relationship ?? result.relationship;
      if (resultRelationship) {
        // Surface the date's net change as floating chips, then clear them so the
        // animation can replay on the next date.
        if (prev) {
          const d: Partial<Record<RelationshipStatKey, number>> = {};
          for (const k of RELATIONSHIP_STAT_KEYS) {
            const diff = resultRelationship[k] - prev[k];
            if (diff !== 0) d[k] = diff;
          }
          setDeltas(Object.keys(d).length ? d : null);
          setTimeout(() => setDeltas(null), 1800);
        }
        setRelationship(resultRelationship);
      }
      setMilestone(selectedResult?.milestone ?? result.milestone ?? null);
      const resultExpression = selectedResult?.expression ?? result.expression;
      if (resultExpression) setExpression(resultExpression);
      await reloadPlayer();
      await refreshWorldState();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // Conclude a date whose exit line was restored by resume(): the live SSE handlers
  // call endDate() the moment a walkout/leave/farewell lands, but during resume()
  // the session state isn't committed yet — so it raises the flag and the end runs
  // here once the resumed session is on screen.
  useEffect(() => {
    if (!autoEnd || !session || busy) return;
    setAutoEnd(false);
    void endDate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEnd, session, busy]);

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
      const openIsHangout = activeDate.mode === 'hangout';
      return (
        <div className="stack">
          <div className="page-head">
            <div className="kicker">{t(openIsHangout ? 'chat.todaysPlan' : 'chat.tonightsPlan')}</div>
            <h1>{t(openIsHangout ? 'chat.onAHangoutTitle' : 'chat.onADateTitle')}</h1>
            <p>{t(openIsHangout ? 'chat.onAHangoutBody' : 'chat.onADateBody', { name: activeDateParticipantNames(activeDate) })}</p>
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
                  <Icon name="date" size={16} />{' '}
                  {t(openIsHangout ? 'chat.resumeHangout' : 'chat.resumeDate', { name: activeDateParticipantNames(activeDate) })}
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
    // A hangout is the same evening, minus the occasion: no venue spend (so only
    // free spots are offered) and none of the date machinery once it starts.
    const planningHangout = setup.mode === 'hangout';
    return (
      <div className="stack">
        <div className="page-head">
          <div className="kicker">{t(planningHangout ? 'chat.todaysPlan' : 'chat.tonightsPlan')}</div>
          <h1>{t(planningHangout ? 'chat.planAHangout' : 'chat.planADate')}</h1>
          <p>{t(planningHangout ? 'chat.planSubHangout' : 'chat.planSub')}</p>
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
                <div className="kicker date-setup-kicker">
                  {t(planningHangout ? 'chat.arrangeAfternoon' : 'chat.arrangeEvening')}
                </div>
                <h2>{t('chat.whoWhereWhen')}</h2>
              </div>
            </div>
            {/* Date or hangout. Picked first because it changes which venues are on
                offer (a hangout is always free) and everything that follows. */}
            <div className="date-mode-pick" role="radiogroup" aria-label={t('chat.modeField')}>
              <div className="kicker">{t('chat.modeField')}</div>
              <div className="date-mode-grid">
                {(['date', 'hangout'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={setup.mode === m}
                    className={`date-mode-card${setup.mode === m ? ' selected' : ''}`}
                    // Switching modes resets the venue: the free-only list a hangout
                    // offers may not contain whatever a date had selected.
                    onClick={() =>
                      setSetup((s) => ({
                        ...s,
                        mode: m,
                        participantId: s.participantId,
                        locationId: 'anywhere',
                      }))
                    }
                  >
                    <span className="date-mode-glyph" aria-hidden="true">{m === 'date' ? '🕯' : '🌿'}</span>
                    <span className="date-mode-copy">
                      <span className="date-mode-name">{t(m === 'date' ? 'chat.modeDate' : 'chat.modeHangout')}</span>
                      <span className="date-mode-sub">
                        {t(m === 'date' ? 'chat.modeDateSub' : 'chat.modeHangoutSub')}
                      </span>
                    </span>
                  </button>
                ))}
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
                        onClick={() =>
                          setSetup((s) => ({ ...s, characterId: c.id, participantId: '', locationId: 'anywhere' }))
                        }
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
            {setupWorld?.featureFlags.groupDates && setup.characterId && (
              <div className="date-invite">
                <div className="kicker">{t('chat.groupInvite')}</div>
                <p className="muted date-invite-note">{t('chat.groupInviteNote')}</p>
                <div className="date-invite-grid" role="radiogroup" aria-label={t('chat.groupInvite')}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!setup.participantId}
                    className={`date-invite-card${!setup.participantId ? ' selected' : ''}`}
                    onClick={() => setSetup((s) => ({ ...s, participantId: '' }))}
                  >
                    <span className="date-invite-none" aria-hidden="true">1:1</span>
                    <span>{t('chat.justUs')}</span>
                  </button>
                  {characters
                    .filter(
                      (candidate) =>
                        candidate.id !== setup.characterId &&
                        (!activeWorldId || candidate.worldId === activeWorldId),
                    )
                    .map((candidate) => {
                      const avail = availability[candidate.id];
                      const unavailable = !!avail && !avail.available;
                      const selected = setup.participantId === candidate.id;
                      return (
                        <button
                          key={candidate.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          className={`date-invite-card${selected ? ' selected' : ''}${unavailable ? ' unavailable' : ''}`}
                          onClick={() => setSetup((s) => ({ ...s, participantId: candidate.id }))}
                          disabled={unavailable}
                          title={
                            unavailable
                              ? t('chat.cardTitleUnavailable', {
                                  name: candidate.name,
                                  reason: avail?.reason ?? t('chat.unavailableToday'),
                                })
                              : t('chat.inviteAlong', { name: candidate.name })
                          }
                        >
                          <span className="date-invite-portrait"><Portrait character={candidate} /></span>
                          <span>{candidate.name}</span>
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
            {((setupWorld && setupWorld.locations.length > 0) || roomUnlocked || setupProperties.length > 0) && (
              <Field label={t(planningHangout ? 'chat.hangoutLocationField' : 'chat.locationField')}>
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
                  // A hangout never spends, so paid venues aren't on offer at all —
                  // the server refuses them, and "Anywhere" resolves to a free spot.
                  const locs = (setupWorld?.locations ?? []).filter(
                    (l) => !planningHangout || venueCost(l.priceTier) === 0,
                  );
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
                  for (const l of locs) {
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
                  {planningHangout ? t('chat.hangoutFreeNote') : t('chat.walletNote', { wallet })}
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
            {setup.participantId && availability[setup.participantId] && !availability[setup.participantId]!.available && (
              <div className="banner error" style={{ fontSize: '0.82rem' }}>
                {t('chat.inviteeUnavailable', {
                  name: characters.find((candidate) => candidate.id === setup.participantId)?.name ?? '',
                  reason: availability[setup.participantId]!.reason ?? t('chat.isUnavailableToday'),
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
                (setup.participantId && availability[setup.participantId] && !availability[setup.participantId]!.available) ||
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
                  <Icon name="date" size={16} /> {t(planningHangout ? 'chat.beginHangout' : 'chat.begin')}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    );
  }

  // --- chat screen ---
  // A hangout runs the same conversation with none of the date apparatus: nothing is
  // judging it turn by turn (no trajectory, no intents, no reaction chips), nobody
  // walks out, and you can't define the relationship over one. Every date-only
  // surface below hangs off this.
  const hangout = session.mode === 'hangout';
  const groupDate = participants.length > 1;
  const participantCharacterById = new Map(participantCharacters.map((entry) => [entry.id, entry]));
  const participantName = (characterId: string | null | undefined) =>
    participants.find((participant) => participant.characterId === (characterId ?? session.characterId))?.characterName ??
    participantCharacterById.get(characterId ?? session.characterId)?.name ??
    character.name;
  const companyName = groupDate
    ? participants.map((participant) => participant.characterName).join(' & ')
    : character.name;
  const selectedParticipant = participants.find(
    (participant) => participant.characterId === selectedActionTargetId,
  ) ?? participants[0];
  const selectedTargetName = selectedParticipant?.characterName ?? character.name;
  // The relationship tab targets personal actions (gift/DTR); ordinary dialogue is
  // still table talk shared by the whole group, so its composer must name everyone.
  const composerTargetName = groupDate
    ? participants.map((participant) => participant.characterName).join(' and ')
    : selectedTargetName;
  const status = relationship ? currentStatus(relationship) : 'none';
  const rung = relationship ? nextDtrRung(relationship) : null;
  const spokeThisSession = messages.some((m) => m.role === 'player');
  // The server enforces a same-day cooldown after any DTR attempt (a deflect sets
  // `dtr:lastAttemptDay`). Mirror it here so the commit button hides instead of staying
  // active and only surfacing a "give it time" error when re-clicked.
  const dtrLastAttempt = relationship?.flags['dtr:lastAttemptDay'];
  const dtrOnCooldown =
    scene != null && typeof dtrLastAttempt === 'number' && scene.day - dtrLastAttempt < DTR_COOLDOWN_DAYS;
  const dtrReady = !hangout && !!rung && rung.warmthMet && spokeThisSession && !dtrOnCooldown;
  // The date is over (evaluated or any terminal path) → no more composing, and the
  // actions collapse to "New date". Mirrors dateConcluded so the lock clears in step.
  const locked = !!evalResult || !!walkout || leftEarly || !!dtrOutcome?.ended || brokeUp;
  const contextWindowKnown =
    contextEstimate?.contextWindowSource === 'model' && contextEstimate.contextWindowTokens != null;
  const contextPercent = contextWindowKnown
    ? contextUsagePercent(contextEstimate.estimatedPromptTokens, contextEstimate.contextWindowTokens!)
    : null;
  const contextTone = contextPercent == null ? 'normal' : contextUsageTone(contextPercent);
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
    // Mirrors dropReplyForRegen: gift reactions / DTR answers already applied
    // their consequences and their metadata drives the evaluator's gift filter.
    !lastMsg.metadata?.gift &&
    !lastMsg.metadata?.dtr &&
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

  const renderParticipantRecap = (entry: EndSessionResponse['participantResults'][number]) => (
    <article
      className={`date-recap-leaf${entry.jealousy?.triggered || entry.breakup ? ' strained' : ''}`}
      key={entry.characterId}
    >
      <div className="date-recap-leaf-head">
        <span className="date-recap-leaf-name">{entry.characterName}</span>
        {entry.mood && <span className="date-recap-mood">{entry.mood}</span>}
      </div>
      {entry.summaryLine && <p className="date-recap-summary">{entry.summaryLine}</p>}
      {entry.bestLine && (
        <blockquote className={`date-recap-line ${entry.bestLine.engagement > 0 ? 'warm' : 'cool'}`}>
          <span className="date-recap-line-kicker">
            {entry.bestLine.engagement > 0 ? t('chat.lineOfNight') : t('chat.lineThatStung')}
          </span>
          <p>&ldquo;{entry.bestLine.text}&rdquo;</p>
        </blockquote>
      )}
      {entry.jealousy?.triggered && <p className="date-recap-consequence">{entry.jealousy.message}</p>}
      {entry.breakup?.line && <p className="date-recap-consequence">{entry.breakup.line}</p>}
      {entry.milestone?.line && <p className="date-recap-consequence warm">{entry.milestone.line}</p>}
      <div className="date-recap-ledger">
        <span className="date-recap-keepsake">
          <Icon name="chronicle" size={13} /> {t('chat.recapMemories', { count: entry.memoriesWritten })}
        </span>
      </div>
    </article>
  );

  // The end-of-date evaluation note (mood, summary, memories) — or a safe-failure
  // notice. Extracted so it can stand in as the primary moment OR ride along as a
  // secondary note when a milestone/DTR moment takes the primary slot (going
  // official otherwise hid the evaluation entirely).
  const evalBanner = evalResult
    ? evalResult.evaluated
      ? groupDate && evalResult.participantResults.length > 1
        ? (
          <div className="date-moment date-recap date-recap-group">
            <div className="date-moment-seal" aria-hidden="true">&#10087;</div>
            <div className="date-recap-head">
              <div>
                <div className="date-moment-kicker">{t('chat.groupRecapKicker')}</div>
                <div className="date-recap-group-title">{t('chat.groupRecapTitle')}</div>
              </div>
            </div>
            <div className="date-recap-spread">
              {evalResult.participantResults.map(renderParticipantRecap)}
            </div>
          </div>
        )
        : (
        <div className="date-moment date-recap">
          <div className="date-moment-seal" aria-hidden="true">❧</div>
          <div className="date-recap-head">
            <div className="date-moment-kicker">{t(hangout ? 'chat.recapKickerHangout' : 'chat.recapKicker')}</div>
            {evalResult.mood && <span className="date-recap-mood">{evalResult.mood}</span>}
          </div>
          {evalResult.summaryLine && <p className="date-recap-summary">{evalResult.summaryLine}</p>}
          {evalResult.bestLine && (
            <blockquote className={`date-recap-line ${evalResult.bestLine.engagement > 0 ? 'warm' : 'cool'}`}>
              <span className="date-recap-line-kicker">
                {evalResult.bestLine.engagement > 0 ? t('chat.lineOfNight') : t('chat.lineThatStung')}
              </span>
              <p>“{evalResult.bestLine.text}”</p>
            </blockquote>
          )}
          <div className="date-recap-ledger">
            <span className="date-recap-keepsake">
              <Icon name="chronicle" size={13} /> {t('chat.recapMemories', { count: evalResult.memoriesWritten })}
            </span>
          </div>
        </div>
        )
      : (
        <div className="date-moment date-recap date-recap-failed">
          <div className="date-moment-seal" aria-hidden="true">⚠</div>
          <div className="date-moment-kicker">{t('chat.evalFailedTitle')}</div>
          <p className="date-recap-summary">{t('chat.recapFailedBody', { error: evalResult.evalError })}</p>
        </div>
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
          <div className="date-moment-title">{t('chat.youEndedTitle', { name: selectedTargetName })}</div>
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
        // A backfire's tension spike can push a committed relationship onto the
        // rocks or into a full breakup (applied server-side) — surface that here,
        // it must not vanish behind the generic backfire card.
        const strainBreakup = dtrOutcome.strain?.kind === 'broke_up';
        return (
          <div className={`date-moment ${strainBreakup ? 'date-moment-breakup' : 'date-moment-walkout'}`}>
            <div className="date-moment-seal" aria-hidden="true">{strainBreakup ? '💔' : '⚠'}</div>
            <div className="date-moment-kicker">{t('chat.dtrBackfireKicker')}</div>
            <div className="date-moment-title">{t('chat.dtrBackfireTitle')}</div>
            {dtrOutcome.strain?.line && <p className="date-moment-body">{dtrOutcome.strain.line}</p>}
            {dtrOutcome.ended && <p className="date-moment-note">{t('chat.dtrEnded')}</p>}
          </div>
        );
      }
      // A non-terminal 'deflect' is only transient feedback — show it while the date is
      // live, but never let it shadow the end-of-date evaluation (returned just below).
      // A soft, moonlit "not yet" card (sibling to the accept/backfire moments above).
      if (!evalResult)
        return (
          <div className="date-moment date-moment-deflect">
            <div className="date-moment-seal" aria-hidden="true">☾</div>
            <div className="date-moment-kicker">{t('chat.dtrNotYetKicker')}</div>
            <p className="date-moment-body">{t('chat.dtrNotYet')}</p>
          </div>
        );
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
          {/* Portrait-led identity plate: the group shares two equal columns, while
              a solo date uses the same composition at a modestly larger scale. */}
          {groupDate ? (
            <div className="date-company-plate group">
              <div className="kicker date-company-title">{t('chat.yourCompany')}</div>
              <div className="date-company-grid">
                {participants.map((participant) => {
                  const person = participantCharacterById.get(participant.characterId);
                  return (
                    <div
                      key={participant.characterId}
                      className={`date-company-person state-${participant.state}`}
                    >
                      <div className="date-company-frame">
                        <div className="date-company-portrait">
                          {person && <Portrait character={person} expression={participant.expression} crossfade />}
                        </div>
                      </div>
                      <div className="date-company-copy">
                        <div className="date-company-name">{participant.characterName}</div>
                        {participant.state !== 'present' ? (
                          <div className="date-company-emotion departed">
                            {t(
                              participant.state === 'walked_out'
                                ? 'chat.walkedOut'
                                : participant.state === 'departed'
                                  ? 'chat.saidGoodnight'
                                  : 'chat.leftDate',
                            )}
                          </div>
                        ) : participant.expression ? (
                          <div className="date-company-emotion">{participant.expression}</div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="date-company-plate solo">
              <div className="date-company-person">
                <div className="date-company-frame">
                  <div className="date-company-portrait">
                    <Portrait character={character} expression={expression} crossfade />
                  </div>
                </div>
                <div className="date-company-copy">
                  <div className="date-company-name">{character.name}</div>
                  {expression && <div className="date-company-emotion">{expression}</div>}
                </div>
              </div>
            </div>
          )}

          {/* The scene, staged as a playbill card: where, when, weather, mood.
              (Replaces the chip row that used to sit atop the conversation. The
              venue photo shows once, behind the stage — not here too.) */}
          <div className="card date-scene-card">
            <div className="kicker">{t('chat.sceneKicker')}</div>
            <div className="dsc-place">{locationName}</div>
            {scene && cal && (
              <div className="dsc-row">
                <span className="dsc-label">{t('chat.sceneWhen')}</span>
                <span title={t('chat.sceneLeadTitle', { weekday: weekdayLabel(cal.dayOfWeek), season: seasonLabel(cal.season) })}>
                  {PHASE_ICONS[scene.phase]} {t('chat.sceneDay', { day: scene.day })} {phaseLabel(scene.phase)}
                </span>
              </div>
            )}
            {scene?.weatherLabel && (
              <div className="dsc-row">
                <span className="dsc-label">{t('chat.sceneWeather')}</span>
                <span>{scene.weatherIcon} {scene.weatherLabel}</span>
              </div>
            )}
            {scene && groupDate ? (
              <div className="dsc-row dsc-row-moods">
                <span className="dsc-label">{t('chat.sceneMood')}</span>
                <div className="dsc-mood-list">
                  {participants.map((participant) => {
                    const arrival = scene.moodsByCharacter[participant.characterId];
                    return arrival?.mood ? (
                      <span className="dsc-mood" key={participant.characterId}>
                        <strong>{participant.characterName}</strong>
                        <span>{arrival.moodIcon} {arrival.mood}</span>
                      </span>
                    ) : null;
                  })}
                </div>
              </div>
            ) : scene?.mood ? (
              <div className="dsc-row">
                <span className="dsc-label">{t('chat.sceneMood')}</span>
                <span className="dsc-mood">{scene.moodIcon} {t('chat.seems', { name: character.name, mood: scene.mood })}</span>
              </div>
            ) : null}
          </div>

          {!hangout && relationship && (
            <div className={`card date-gauges${groupDate ? ' date-bond-tabs' : ''} ${milestone ? 'stage-up' : ''}`}>
              {groupDate && (
                <div className="date-bond-tablist" role="tablist" aria-label={t('chat.relationshipTabs')}>
                  {participants.map((participant) => {
                    const person = participantCharacterById.get(participant.characterId);
                    const selected = participant.characterId === selectedActionTargetId;
                    return (
                      <button
                        type="button"
                        role="tab"
                        key={participant.characterId}
                        className={`date-bond-tab${selected ? ' active' : ''}`}
                        aria-selected={selected}
                        aria-controls="date-selected-bond"
                        disabled={busy || streaming.active || (!locked && participant.state !== 'present')}
                        onClick={() => void selectActionTarget(participant.characterId)}
                      >
                        {person && <Portrait character={person} expression={participant.expression} crossfade />}
                        <span>{participant.characterName}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div id={groupDate ? 'date-selected-bond' : undefined} role={groupDate ? 'tabpanel' : undefined}>
              <div className="date-gauges-head">
                  <div className="kicker">{t('chat.whereYouStand')}</div>
                <div className="trail" />
                  {groupDate && isBrokenUp(relationship) ? (
                    <span className="badge danger">{t('chat.brokenUp')}</span>
                  ) : groupDate && status !== 'none' ? (
                    <span className="badge accent">{relationshipStatusLabel(status)}</span>
                  ) : null}
              </div>
              <RelationshipBars relationship={relationship} deltas={deltas ?? undefined} />
                {groupDate && !locked && (
                  <div className="date-bond-actions">
                    {dtrReady && (
                      <button className="btn primary block date-dtr" onClick={defineRelationship} disabled={busy || streaming.active} title={t('chat.dtrTitleFor', { name: selectedTargetName })}>
                        <Icon name="commit" size={16} /> {rung!.rung.label}
                      </button>
                    )}
                    <button
                      className="btn ghost block date-gift-btn"
                      onClick={() => (giftPicker ? setGiftPicker(false) : void openGiftPicker())}
                      disabled={busy || streaming.active}
                      title={t('chat.giveSomething')}
                    >
                      <Icon name="gift" size={15} /> {giftPicker ? t('chat.neverMind') : t('chat.giveGift')}
                    </button>
                    {giftPicker && (
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
                              <span className="date-gift-item-qty">&times;{e.inventoryItem.quantity}</span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="card date-actions">
            {!groupDate && dtrReady && !locked && (
              <button className="btn primary block date-dtr" onClick={defineRelationship} disabled={busy || streaming.active} title={t('chat.dtrTitleFor', { name: selectedTargetName })}>
                <Icon name="commit" size={16} /> {rung!.rung.label}
              </button>
            )}
            {!hangout && !groupDate && !locked && relationship && (
              <button
                className="btn ghost block date-gift-btn"
                onClick={() => (giftPicker ? setGiftPicker(false) : void openGiftPicker())}
                disabled={busy || streaming.active}
                title={t('chat.giveSomething')}
              >
                <Icon name="gift" size={15} /> {giftPicker ? t('chat.neverMind') : t('chat.giveGift')}
              </button>
            )}
            {!hangout && !groupDate && giftPicker && !locked && (
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
              <button
                className="btn ghost block"
                onClick={dismissRecap}
                disabled={busy}
                title={t(hangout ? 'chat.newHangoutTitle' : 'chat.newDateTitle')}
              >
                <Icon name="recap" size={14} /> {t(hangout ? 'chat.newHangout' : 'chat.newDate')}
              </button>
            ) : spokeThisSession ? (
              <>
                <button className="btn sm block" onClick={summarize} disabled={busy || streaming.active}>
                  <Icon name="recap" size={14} /> {t('chat.recap')}
                </button>
                <button className="btn ghost block date-end-btn" onClick={endDate} disabled={busy || streaming.active}>
                  {busy ? t('chat.evaluating') : <><Icon name="end" size={14} /> {t(hangout ? 'chat.endHangout' : 'chat.endEvaluate')}</>}
                </button>
              </>
            ) : (
              <button className="btn ghost block date-end-btn" onClick={cancelDate} disabled={busy || streaming.active}>
                {busy ? t('chat.leaving') : <><Icon name="leave" size={14} /> {t(hangout ? 'chat.cancelHangout' : 'chat.cancelDate')}</>}
              </button>
            )}
            {/* The walkthrough is about dating — it has nothing to say about a hangout. */}
            {!hangout && (
              <button className="btn sm ghost block date-howto" onClick={() => setOnboardingOpen(true)}>
                <Icon name="info" size={13} /> {t('chat.howDating')}
              </button>
            )}
          </div>
        </aside>

        <section className="framed date-stage">
          {locationImage && (
            <div className="date-stage-bg" aria-hidden="true">
              <img src={assetUrl(locationImage)} alt="" />
            </div>
          )}
          {/* The trajectory bar reads the live rapport. A hangout has none, so it
              takes the bar's place with a line saying exactly why. */}
          {!locked &&
            (hangout ? (
              <div className="date-hangout-ribbon">
                <span className="date-hangout-tag">{t('chat.hangoutBadge')}</span>
                <span className="date-hangout-note">{t('chat.hangoutRibbon')}</span>
              </div>
            ) : groupDate ? (
              <div className="date-group-trajectories">
                {participants.map((participant) => {
                  const person = participantCharacterById.get(participant.characterId);
                  const stateLabel =
                    participant.state === 'walked_out'
                      ? t('chat.walkedOut')
                      : participant.state === 'departed'
                        ? t('chat.saidGoodnight')
                      : participant.state === 'left_early'
                        ? t('chat.leftDate')
                        : participant.vibe ?? t('chat.settlingIn');
                  return (
                    <div
                      className={`date-participant-trajectory state-${participant.state}`}
                      key={participant.characterId}
                    >
                      <div className="date-participant-trajectory-name">{participant.characterName}</div>
                      <DateTrajectory
                        value={participant.judged ? participant.rapport : null}
                        anchor={startingRapport(person?.guardedness ?? character.guardedness)}
                        label={stateLabel}
                        pulse={participantPulses[participant.characterId] ?? null}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <DateTrajectory
                value={rapport}
                anchor={startingRapport(character.guardedness)}
                label={vibe ?? t('chat.settlingIn')}
                pulse={rapportPulse}
              />
            ))}
          <div className="messages date-reel">
            {messages.length === 0 && !streaming.active && (
              <div className="date-opening">
                <div className={`date-opening-portrait${groupDate ? ' group' : ''}`}>
                  {groupDate
                    ? participants.map((participant) => {
                        const person = participantCharacterById.get(participant.characterId);
                        return person ? (
                          <Portrait
                            key={participant.characterId}
                            character={person}
                            expression={participant.expression}
                            crossfade
                          />
                        ) : null;
                      })
                    : <Portrait character={character} expression={expression} crossfade />}
                </div>
                <div className="date-opening-copy">
                  <div className="date-opening-name">
                    {companyName}
                  </div>
                  <p className="date-opening-scene">
                    {scene?.mood
                      ? t('chat.openingWithMood', {
                          name: companyName,
                          mood: scene.mood,
                          atLocation: locationName !== t('chat.loc.anywhere') ? t('chat.openingAtLocation', { location: locationName }) : '',
                          weather: scene.weatherLabel ? t('chat.openingWeather', { weather: scene.weatherLabel.toLowerCase() }) : '',
                        })
                      : locationName !== t('chat.loc.anywhere')
                        ? t('chat.openingWaitingAt', { name: companyName, location: locationName })
                        : t('chat.openingWaiting', { name: companyName })}
                  </p>
                  <div className="date-opening-cue">{t('chat.sayHello')}</div>
                </div>
              </div>
            )}
            {messages.map((m) => {
              // The per-turn judge's read, stamped on the player's message — a
              // qualitative chip under the bubble (no numbers, like the bar).
              const engagement =
                m.role === 'player' && typeof m.metadata?.engagement === 'number'
                  ? Math.max(-3, Math.min(3, Math.round(m.metadata.engagement)))
                  : null;
              const rawEngagements = m.metadata?.engagementByCharacter;
              const groupEngagements =
                groupDate && m.role === 'player' && rawEngagements && typeof rawEngagements === 'object' && !Array.isArray(rawEngagements)
                  ? Object.entries(rawEngagements as Record<string, unknown>)
                      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
                      .map(([characterId, value]) => ({
                        characterId,
                        engagement: Math.max(-3, Math.min(3, Math.round(value))),
                      }))
                  : [];
              return (
                <Fragment key={m.id}>
                  <div
                    className={`date-msg ${m.role}${m.role === 'narrator' && m.metadata?.venueFlavor === true ? ' venue-flavor' : ''}`}
                  >
                    {groupDate && m.role === 'character' && (
                      <span className="date-msg-speaker">{participantName(m.characterId)}</span>
                    )}
                    {m.role === 'character' || m.metadata?.venueFlavor === true
                      ? <RichLine text={m.text} sceneLead={m.metadata?.venueFlavor === true} />
                      : m.text}
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
                  {groupEngagements.length > 0 ? (
                    <span className="date-react-group">
                      {groupEngagements.map((read) => (
                        <span
                          key={read.characterId}
                          className={`date-react ${read.engagement > 0 ? 'warm' : read.engagement < 0 ? 'cool' : 'flat'}`}
                          title={t('chat.reactionTitle')}
                        >
                          <span className="date-react-name">{participantName(read.characterId)}</span>
                          <span className="date-react-pip" aria-hidden="true">◆</span>
                          {t(REACTION_KEYS[read.engagement + 3]!)}
                        </span>
                      ))}
                    </span>
                  ) : engagement !== null && (
                    <span
                      className={`date-react ${engagement > 0 ? 'warm' : engagement < 0 ? 'cool' : 'flat'}`}
                      title={t('chat.reactionTitle')}
                    >
                      <span className="date-react-pip" aria-hidden="true">◆</span>
                      {t(REACTION_KEYS[engagement + 3]!)}
                    </span>
                  )}
                </Fragment>
              );
            })}
            {streaming.active && (
              <div className="date-msg character">
                {groupDate && streamingCharacterId && (
                  <span className="date-msg-speaker">{participantName(streamingCharacterId)}</span>
                )}
                {streaming.text.trim() ? (
                  <>
                    <RichLine text={streaming.text.trimStart()} open />
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
              <button className="btn" onClick={dismissRecap}>
                <Icon name="recap" size={14} /> {t('chat.startOver')}
              </button>
            </div>
          ) : breakupPending ? (
            <div className="date-breakup">
              <div className="date-breakup-title"><Icon name="breakup" size={16} /> {t('chat.breakupConfirmTitle', { name: participantName(breakupPending.characterId) })}</div>
              <p>
                {t('chat.breakupConfirmBody', { name: participantName(breakupPending.characterId) })}
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
              {/* One instrument: the message box with the intent moves docked
                  inside it. An intent is a claim over your NEXT line — the
                  character reacts to the move and the judges grade its fit
                  (each button's title spells that out). */}
              <div className="chat-input date-composer">
                <textarea
                  value={input}
                  placeholder={intent ? t('chat.composerIntent', { intent: intentLabel(intent), name: composerTargetName }) : t('chat.composerPlain', { name: composerTargetName })}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="date-composer-bar">
                  {/* Intents are a claim the judges grade. Nothing judges a hangout,
                      so offering them would promise a mechanic that isn't running. */}
                  {relationship && !hangout && (
                    <div className="date-intents" role="group" aria-label={t('chat.intentComing')}>
                      {availableIntents(relationship).map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          className={`date-intent t-${opt}${intent === opt ? ' active' : ''}`}
                          aria-pressed={intent === opt}
                          disabled={streaming.active}
                          title={intentTip(opt)}
                          onClick={() => setIntent((cur) => (cur === opt ? null : opt))}
                        >
                          <span className="date-intent-emoji" aria-hidden="true">{INTENT_ICONS[opt]}</span>
                          {intentLabel(opt)}
                        </button>
                      ))}
                    </div>
                  )}
                  <span className="date-composer-spacer" />
                  <button className="date-send" onClick={() => void send()} disabled={streaming.active || !input.trim()}>
                    {t('chat.sendLabel')}
                  </button>
                </div>
              </div>
              {contextEstimate && (
                <div
                  className={`date-context-meter ${contextWindowKnown ? contextTone : 'estimate-only'}`}
                  role="status"
                  title={
                    contextWindowKnown
                      ? t('chat.contextUsageTitle', {
                          used: contextEstimate.estimatedPromptTokens.toLocaleString(),
                          window: contextEstimate.contextWindowTokens!.toLocaleString(),
                        })
                      : t('chat.promptEstimateTitle')
                  }
                >
                  <div className="date-context-summary">
                    <span>{t(contextWindowKnown ? 'chat.contextUsage' : 'chat.promptEstimate')}</span>
                    <strong>
                      {contextWindowKnown && contextPercent != null
                        ? `≈${contextPercent}%`
                        : t('chat.promptEstimateTokens', {
                            tokens: contextEstimate.estimatedPromptTokens.toLocaleString(),
                          })}
                    </strong>
                  </div>
                  {contextWindowKnown && contextPercent != null && (
                    <div
                      className="date-context-track"
                      role="progressbar"
                      aria-label={t('chat.contextUsage')}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.min(100, contextPercent)}
                    >
                      <span style={{ width: `${Math.min(100, contextPercent)}%` }} />
                    </div>
                  )}
                  {contextTone === 'critical' && (
                    <div className="date-context-warning">
                      <Icon name="warn" size={12} />
                      <span>{t('chat.contextWarning')}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          </div>
        </section>
      </div>

      {onboardingOpen && <DateOnboarding onClose={closeOnboarding} />}
    </div>
  );
}
