import {
  WorldStateSchema,
  DayRecapSchema,
  DEFAULT_STAMINA_MAX,
  ACTION_STAMINA_COST,
  LAST_SEEN_FLAG,
  WEEKEND_BONUS_STAMINA,
  currentStatus,
  neglectTuningFor,
  deriveCalendar,
  phaseForStaminaSpent,
  type DayRecap,
  type GameEvent,
  type NeglectedCharacter,
  type Phase,
  type WorldState,
  type WorldSimResult,
} from '@dsim/shared';
import { charactersRepo, eventsRepo, worldStatesRepo } from '../db/repositories';
import { badRequest } from '../lib/errors';
import { ensureRelationship } from './relationship-service';
import { applyNeglectDecay } from './stat-service';
import { evaluateRelationshipStrain } from './breakup-service';
import { evaluateDespairArc } from './crisis-service';
import { weatherForDay } from './ambiance-service';
import { recordEvent } from './event-service';
import { recordDay } from './day-record-service';
import { runDailyWealth } from './wealth-service';
import { getLlmSettings } from './settings-service';
import { callStructuredLlm } from '../llm/structured';
import { buildDayRecapMessages } from '../prompt/prompt-builder';
import { formatEventsForRecap } from '../lib/day-events';

/**
 * Sole owner of the per-world game clock: day, time-of-day phase, stamina, and
 * day advancement (with neglect decay + end-of-day recap). All mutations here
 * record GameEvents; nothing else writes world_states.
 */

// Lifecycle hooks let the phone subsystem react to time without an import
// cycle. Registered at startup (see phone-bootstrap.ts).
type DayStartedHook = (worldId: string, day: number) => void;
type PhaseAdvancedHook = (worldId: string, day: number, phase: Phase) => void;
// The world-sim runs SYNCHRONOUSLY inside advanceDay (awaited) — the player waits
// once on Sleep and sees its results in the recap popup. May be sync or async.
type WorldSimHook = (worldId: string, day: number) => Promise<WorldSimResult> | WorldSimResult;
let onDayStartedHook: DayStartedHook | null = null;
let onPhaseAdvancedHook: PhaseAdvancedHook | null = null;
let onWorldSimHook: WorldSimHook | null = null;

export function registerClockHooks(hooks: {
  onDayStarted?: DayStartedHook;
  onPhaseAdvanced?: PhaseAdvancedHook;
  onWorldSim?: WorldSimHook;
}): void {
  if (hooks.onDayStarted) onDayStartedHook = hooks.onDayStarted;
  if (hooks.onPhaseAdvanced) onPhaseAdvancedHook = hooks.onPhaseAdvanced;
  if (hooks.onWorldSim) onWorldSimHook = hooks.onWorldSim;
}

export function ensureWorldState(worldId: string): WorldState {
  const existing = worldStatesRepo.get(worldId);
  if (existing) return existing;
  const now = Date.now();
  const state = WorldStateSchema.parse({
    worldId,
    day: 1,
    phase: 'morning',
    stamina: DEFAULT_STAMINA_MAX,
    staminaMax: DEFAULT_STAMINA_MAX,
    actionsToday: 0,
    lastRecapDay: 0,
    dayStartedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return worldStatesRepo.insert(state);
}

export function getWorldState(worldId: string): WorldState {
  return ensureWorldState(worldId);
}

export interface TimeContext {
  day: number;
  phase: Phase;
  stamina: number;
  staminaMax: number;
}

export function getTimeContext(worldId: string): TimeContext {
  const s = ensureWorldState(worldId);
  return { day: s.day, phase: s.phase, stamina: s.stamina, staminaMax: s.staminaMax };
}

/** Throw if the world is out of stamina for today (caller is about to start an action). */
export function assertCanAct(worldId: string): void {
  const s = ensureWorldState(worldId);
  if (s.stamina <= 0) {
    throw badRequest('You are out of energy for today. Sleep to begin a new day.');
  }
}

/** Spend stamina for a completed action; advances the time-of-day phase. */
export function spendStamina(worldId: string, cost: number = ACTION_STAMINA_COST): WorldState {
  const s = ensureWorldState(worldId);
  const stamina = Math.max(0, s.stamina - cost);
  const spent = s.staminaMax - stamina;
  const phase = phaseForStaminaSpent(spent, s.staminaMax);
  const next = WorldStateSchema.parse({
    ...s,
    stamina,
    actionsToday: s.actionsToday + 1,
    phase,
    updatedAt: Date.now(),
  });
  worldStatesRepo.update(next);
  recordEvent('stamina_spent', { worldId, cost, remaining: stamina, phase });
  try {
    onPhaseAdvancedHook?.(worldId, next.day, next.phase);
  } catch {
    /* phone delivery is best-effort */
  }
  return next;
}

export interface SleepResult {
  state: WorldState;
  recap: DayRecap | null;
  recapError: string | null;
  decayed: NeglectedCharacter[];
  /** Morning-briefing context for the new day. */
  calendar: { dayOfWeek: string; season: string; isWeekend: boolean } | null;
  weather: { label: string; icon: string } | null;
  holiday: { name: string; blurb: string } | null;
  /** What the NPC world did on the day that just ended (the "Around town" beats). */
  worldSim: WorldSimResult | null;
  /** Passive money credited to this world's wallet for the new day. */
  income: number;
  /** False when a stale `expectedDay` made this a no-op (the day already advanced). */
  advanced: boolean;
}

/**
 * Advance to the next day: recap the day that ended, apply neglect decay, reset stamina.
 *
 * `expectedDay` is optimistic-concurrency protection against a DOUBLE day-advance:
 * the client passes the day it currently believes it's on, and if the world has
 * already moved past it (a second tab / a retry / a double-fire that beat the client
 * button-disable), we NO-OP instead of burning another day + charging another round
 * of rent/dividends. The caller (the route) also serializes this whole function
 * under a per-world lock so the read-check-commit below can't interleave.
 */
export async function advanceDay(worldId: string, expectedDay?: number): Promise<SleepResult> {
  const state = ensureWorldState(worldId);
  // Stale intent: the day already rolled over — return the current state untouched.
  if (expectedDay != null && state.day !== expectedDay) {
    return {
      state,
      recap: null,
      recapError: null,
      decayed: [],
      calendar: null,
      weather: null,
      holiday: null,
      worldSim: null,
      income: 0,
      advanced: false,
    };
  }
  const simDay = state.day; // the day that is ENDING — what we simulate + recap

  // 1. Capture THIS WORLD's events for the ending day BEFORE anything new is
  //    recorded. World-scoped (not a bare wall-clock listSince) so the recap can
  //    never narrate another world's dates/breakups/purchases that happened in the
  //    same real-time window — the day-recap cross-world leak.
  const events = eventsRepo.listSinceByWorld(worldId, state.dayStartedAt);

  // 2. Advance the clock + apply neglect decay as of the new day.
  const newDay = state.day + 1;
  const decayed = applyWorldNeglect(worldId, newDay);
  const cal = deriveCalendar(newDay);
  const weather = weatherForDay(worldId, newDay);

  const now = Date.now();
  // Weekends grant a little extra energy — raise the CAP (not just the pool), so
  // stamina never exceeds staminaMax and the time-of-day clock paces against the
  // real day budget (phaseForStaminaSpent divides by staminaMax). Derived from the
  // base constant so it self-resets to 3 on weekdays.
  const staminaMax = DEFAULT_STAMINA_MAX + (cal.isWeekend ? WEEKEND_BONUS_STAMINA : 0);
  const next = WorldStateSchema.parse({
    ...state,
    day: newDay,
    phase: 'morning',
    staminaMax,
    stamina: staminaMax,
    actionsToday: 0,
    lastRecapDay: state.day,
    dayStartedAt: now,
    updatedAt: now,
  });
  worldStatesRepo.update(next);

  // 2b. There is NO free daily stipend — the only passive income for the new day
  //     is stock dividends from holdings you own (credited in 2c below). Real
  //     spending money is earned from work shifts and minigames.
  let income = 0;

  // 2c. Wealth systems (per-world opt-in): charge due lease rent (warn + evict on
  //     default), roll the stock market forward (deterministic walk + event shocks
  //     from the day that just ended), and pay dividends. Idempotent per (world,
  //     newDay). Only DIVIDENDS are income; lease rent is an expense already deducted.
  try {
    const { dividends } = runDailyWealth(worldId, newDay, events);
    income += dividends;
  } catch {
    /* wealth is best-effort; never block the day rollover */
  }

  // 3. SYNCHRONOUS world-sim for the day that just ended — the ONE awaited extra
  //    call on the Sleep path. The player waits once for this, then the popup shows
  //    everything that happened. Best-effort: a failure still advances the day.
  let worldSim: WorldSimResult | null = null;
  try {
    worldSim = (await onWorldSimHook?.(worldId, simDay)) ?? null;
  } catch {
    /* world-sim is best-effort; the day still advances with no "around town" beats */
  }

  // 4. Recap LAST, fed the world-sim beats so the narrator can weave "Around town"
  //    into the SAME call (no extra LLM round-trip; npc_* events are deliberately
  //    NOT in RECAP_EVENT_TYPES, so the worldSim param is their only path in).
  const { recap, recapError } = await generateDayRecap(simDay, events, worldSim);

  // 4b. Persist the ended day to the almanac (the Calendar app's history). Best-
  //     effort: a failure here must never block the day rollover. There is no flat
  //     passive stipend anymore, and stock dividends are credited live + surfaced as
  //     their own beats — so a recorded day carries no passive-income line.
  try {
    recordDay(worldId, simDay, { recap, worldSim, income: 0, events });
  } catch {
    /* almanac persistence is best-effort */
  }

  recordEvent('day_advanced', { worldId, day: newDay, recapped: recap != null });
  try {
    onDayStartedHook?.(worldId, newDay); // fire-and-forget daily text/email/gossip/feed
  } catch {
    /* phone generation is best-effort */
  }

  return {
    state: next,
    recap,
    recapError,
    decayed,
    calendar: { dayOfWeek: cal.dayOfWeek, season: cal.season, isWeekend: cal.isWeekend },
    weather: { label: weather.label, icon: weather.icon },
    holiday: cal.holiday ? { name: cal.holiday.name, blurb: cal.holiday.blurb } : null,
    worldSim,
    income,
    advanced: true,
  };
}

// --- internals --------------------------------------------------------------

async function generateDayRecap(
  day: number,
  events: GameEvent[],
  worldSim: WorldSimResult | null = null,
): Promise<{ recap: DayRecap | null; recapError: string | null }> {
  const townLines = (worldSim?.beats ?? []).map((b) => `- ${b.summary}`).join('\n');
  // Key "quiet" off DESCRIBABLE content, not the raw count: some event types (e.g.
  // player_money_change from passive daily income) intentionally render no line, so a
  // day carrying only those still reads as quiet. formatEventsForRecap is fed the
  // full list — it null-skips non-recap events and collapses work/bonding/texting.
  const eventsBlock = formatEventsForRecap(events);
  if (!eventsBlock.trim() && !townLines) {
    return {
      recap: { headline: `Day ${day}: a quiet day`, narrative: 'A calm, uneventful day — nothing much happened.', highlights: [] },
      recapError: null,
    };
  }
  const eventsSummary = [eventsBlock, townLines && `Around town:\n${townLines}`].filter(Boolean).join('\n');
  const settings = getLlmSettings();
  const result = await callStructuredLlm(DayRecapSchema, buildDayRecapMessages(day, eventsSummary), {
    settings,
    task: 'Write a short end-of-day recap from the listed events.',
    schemaName: 'DayRecap',
  });
  if (result.ok) {
    recordEvent('day_recap_written', { day });
    return { recap: result.data, recapError: null };
  }
  recordEvent('day_recap_failed', { day, error: result.error });
  return { recap: null, recapError: result.error };
}

function applyWorldNeglect(worldId: string, currentDay: number): NeglectedCharacter[] {
  const decayed: NeglectedCharacter[] = [];
  for (const c of charactersRepo.listByWorld(worldId)) {
    const rel = ensureRelationship(c.id);
    const lastSeen = rel.flags[LAST_SEEN_FLAG];
    if (typeof lastSeen !== 'number') continue; // never interacted — never punished
    const daysSinceSeen = currentDay - lastSeen;
    // Commitment scales how soon neglect bites and how fast it decays: you can't
    // ignore an exclusive/live-in partner the way you can a casual date.
    const { graceDays, decayMult } = neglectTuningFor(currentStatus(rel));
    if (daysSinceSeen >= graceDays) {
      applyNeglectDecay(c.id, daysSinceSeen, decayMult);
      decayed.push({ characterId: c.id, name: c.name, daysSinceSeen });
    }
    // A committed relationship that's drifting (neglect or cratered warmth/tension)
    // can go on the rocks and ultimately break up; a broken-up one may reconcile.
    try {
      evaluateRelationshipStrain(c.id, { day: currentDay, trigger: 'neglect' });
    } catch {
      /* strain is best-effort; never block the day rollover */
    }
    // (Opt-in) advance the despair spiral: heal, escalate warnings, or — only after
    // a sustained crisis with continued harm — reach the memorial outcome.
    try {
      evaluateDespairArc(c.id, { day: currentDay });
    } catch {
      /* best-effort; never block the day rollover */
    }
  }
  return decayed;
}
