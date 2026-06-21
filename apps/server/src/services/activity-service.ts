import {
  ACTIVITIES,
  HARSH_WEATHER,
  PLEASANT_WEATHER,
  PerformActivitySchema,
  resolveTogether,
  type ActivityDef,
  type Character,
  type PerformActivity,
  type Relationship,
  type TogetherResult,
  type WorldState,
} from '@dsim/shared';
import { badRequest } from '../lib/errors';
import { getDb } from '../db/index';
import { assertCanAct, ensureWorldState, spendStamina } from './world-clock-service';
import { getCharacterAvailability } from './availability-service';
import { weatherForDay } from './ambiance-service';
import { addMoney, spendMoney } from './player-service';
import { applyRelationshipChange, setRelationshipFlag, stampLastDate } from './stat-service';
import { getCharacter } from './character-service';
import { getRelationship } from './relationship-service';
import { addMemoriesFromEvaluation } from './memory-service';
import { appendChronicleLine } from './chronicle-service';
import { detectMilestoneCrossing } from './milestone-service';
import { recordEvent } from './event-service';
import { hashFloat } from '../lib/seeded-random';
import { playerIdForWorld } from '../lib/ids';

export function listActivities(): readonly ActivityDef[] {
  return ACTIVITIES;
}

export interface ActivityResult {
  activityId: string;
  kind: ActivityDef['kind'];
  money: number;
  relationship: Relationship | null;
  /** Together: the structured read of how the outing landed (null for work). */
  together: TogetherResult | null;
  state: WorldState;
}

/**
 * Perform a work/together activity. Costs 1 stamina (passes time). Rewards are
 * server-defined — the client only chooses which activity (and, for Together,
 * which character). WORK earns money; TOGETHER spends time with someone and is
 * resolved by {@link resolveTogether} (fit, diminishing returns, a per-person
 * daily cap, and risk).
 */
export function performActivity(input: PerformActivity): ActivityResult {
  const data = PerformActivitySchema.parse(input);
  const activity = ACTIVITIES.find((a) => a.id === data.activityId);
  if (!activity) throw badRequest('Unknown activity.');

  const worldId = data.worldId;
  let character: Character | null = null;
  if (activity.kind === 'together') {
    if (!data.characterId) throw badRequest('Choose someone to spend time with.');
    character = getCharacter(data.characterId);
    if (!character.worldId) throw badRequest('That character is not part of a world.');
    if (character.worldId !== worldId) throw badRequest(`${character.name} isn't part of the active world.`);
    const day = ensureWorldState(worldId).day;
    const avail = getCharacterAvailability(worldId, day, character.id);
    if (!avail.available) {
      throw badRequest(`${character.name} ${avail.reason ?? 'is unavailable today'}.`);
    }
  }

  assertCanAct(worldId); // throws if out of stamina

  // A heavier shift can cost more than one action; assertCanAct only guards the
  // out-of-energy (>0) case, so make sure the day can actually afford this one.
  const staminaCost = activity.kind === 'work' ? activity.staminaCost ?? 1 : 1;
  const preState = ensureWorldState(worldId);
  if (staminaCost > preState.stamina) {
    throw badRequest(
      `That shift takes ${staminaCost} energy, but you only have ${preState.stamina} left today.`,
    );
  }

  // Apply the reward and spend the action in ONE transaction, so a failure
  // can't leave a free reward (or a spent action with no reward).
  return getDb().transaction<ActivityResult>(() => {
    let money = 0;
    let relationship: Relationship | null = null;
    let together: TogetherResult | null = null;
    if (activity.kind === 'work') {
      // Pay can vary by the day's weather + a deterministic spread (see computeWorkPay).
      money = computeWorkPay(activity, worldId, preState.day, preState.actionsToday);
      addMoney(money, playerIdForWorld(worldId));
    } else {
      const out = performTogether(activity, worldId, character!, ensureWorldState(worldId).day);
      relationship = out.relationship;
      together = out.together;
    }
    const state = spendStamina(worldId, staminaCost);
    recordEvent('activity', { worldId, activityId: activity.id, kind: activity.kind, characterId: data.characterId, money });
    return { activityId: activity.id, kind: activity.kind, money, relationship, together, state };
  });
}

/** Storm/salvage premium vs fair-weather ease, for weather-priced outdoor jobs. */
const HARSH_WEATHER_PAY_MULT = 1.4;
const PLEASANT_WEATHER_PAY_MULT = 0.85;

/**
 * Resolve a work shift's pay. The base ({@link ActivityDef.money}) can be:
 *  - scaled by the day's weather for outdoor jobs ({@link ActivityDef.weatherPriced}),
 *    and
 *  - given a deterministic spread ({@link ActivityDef.moneyVariance}) so a "gig" pays
 *    a different amount each shift.
 * The spread is seeded by (world, day, activity, actionsToday) so it's stable for the
 * Nth shift of a given day and fully replay-safe — never a fresh Math.random roll.
 */
function computeWorkPay(activity: ActivityDef, worldId: string, day: number, actionsToday: number): number {
  let pay = activity.money ?? 0;
  if (activity.weatherPriced) {
    const kind = weatherForDay(worldId, day).kind;
    if (HARSH_WEATHER.includes(kind)) pay *= HARSH_WEATHER_PAY_MULT;
    else if (PLEASANT_WEATHER.includes(kind)) pay *= PLEASANT_WEATHER_PAY_MULT;
  }
  const variance = activity.moneyVariance ?? 0;
  if (variance > 0) {
    const roll = hashFloat(`${worldId}|${day}|${activity.id}|work|${actionsToday}`);
    pay *= 1 - variance + roll * 2 * variance; // uniform in [base·(1−v), base·(1+v)]
  }
  return Math.max(0, Math.round(pay));
}

/**
 * Resolve + apply one Together outing inside the activity transaction: roll the
 * deterministic outcome, charge any money cost, apply the relationship deltas,
 * stamp the per-person daily cap + last-seen clocks, and — for a remembered
 * moment — write the durable memory/chronicle (and a rare milestone). A money cost
 * that can't be paid throws, rolling the whole action back (no spent stamina).
 */
function performTogether(
  activity: ActivityDef,
  worldId: string,
  character: Character,
  day: number,
): { relationship: Relationship; together: TogetherResult } {
  const before = getRelationship(character.id);
  const stat = activity.relationshipStat ?? 'comfort';

  // Per-person daily cap: how many times you've already leaned on them today.
  const timesToday =
    before.flags['together:day'] === day && typeof before.flags['together:count'] === 'number'
      ? (before.flags['together:count'] as number)
      : 0;

  // Deterministic per (world, day, character, activity, attempt) — replayable.
  const roll = hashFloat(`${worldId}|${day}|${character.id}|${activity.id}|together|${timesToday}`);

  const { result, deltas } = resolveTogether({
    activity,
    datingStats: character.datingStats,
    guardedness: character.guardedness,
    relationship: before,
    current: before[stat],
    timesToday,
    roll,
  });

  // A real outing costs real money up front — but free options exist, so being
  // broke never locks you out of spending time with someone.
  if (result.cost > 0) spendMoney(result.cost, playerIdForWorld(worldId));

  let relationship = before;
  if (Object.keys(deltas).length > 0) {
    relationship = applyRelationshipChange(character.id, deltas, {
      source: 'together',
      detail: { activityId: activity.id, outcome: result.outcome },
    });
  }

  // In-person time resets neglect + the "it's been a while" date greeting, and
  // advances the per-person daily cap.
  stampLastDate(character.id, day);
  setRelationshipFlag(character.id, 'together:day', day, { source: 'together' });
  setRelationshipFlag(character.id, 'together:count', timesToday + 1, { source: 'together' });

  // Make a spark matter: a durable memory + chronicle line (best-effort).
  if (result.memorable) {
    const moment = activity.label.toLowerCase();
    try {
      addMemoriesFromEvaluation(
        character.id,
        [{ text: `We spent a lovely afternoon together — ${moment}.`, importance: 3, tags: ['sweet'] }],
        null,
      );
    } catch {
      /* memory write is best-effort; never break the activity */
    }
    try {
      appendChronicleLine(character.id, day, 'event', `✨ A lovely afternoon together — ${moment}.`, { bumpSession: false });
    } catch {
      /* chronicle is best-effort */
    }
  }

  // Casual time rarely crosses a warmth band (it never touches affection and tapers
  // near the ceiling) — but if it ever does, celebrate it like any other crossing.
  try {
    detectMilestoneCrossing(character.id, before, relationship, { day, mode: 'event' });
  } catch {
    /* milestone detection is best-effort */
  }

  return { relationship, together: result };
}
