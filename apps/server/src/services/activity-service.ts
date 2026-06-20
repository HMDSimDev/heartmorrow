import {
  ACTIVITIES,
  PerformActivitySchema,
  type ActivityDef,
  type PerformActivity,
  type Relationship,
  type WorldState,
} from '@dsim/shared';
import { badRequest } from '../lib/errors';
import { getDb } from '../db/index';
import { assertCanAct, ensureWorldState, spendStamina } from './world-clock-service';
import { getCharacterAvailability } from './availability-service';
import { addMoney } from './player-service';
import { applyRelationshipChange, stampLastDate } from './stat-service';
import { getCharacter } from './character-service';
import { recordEvent } from './event-service';
import { playerIdForWorld } from '../lib/ids';

export function listActivities(): readonly ActivityDef[] {
  return ACTIVITIES;
}

export interface ActivityResult {
  activityId: string;
  kind: ActivityDef['kind'];
  money: number;
  relationship: Relationship | null;
  state: WorldState;
}

/**
 * Perform a work/training activity. Costs 1 stamina (passes time). Rewards are
 * server-defined — the client only chooses which activity (and, for training,
 * which character).
 */
export function performActivity(input: PerformActivity): ActivityResult {
  const data = PerformActivitySchema.parse(input);
  const activity = ACTIVITIES.find((a) => a.id === data.activityId);
  if (!activity) throw badRequest('Unknown activity.');

  // Resolve the world the action happens in.
  const worldId = data.worldId;
  if (activity.kind === 'training') {
    if (!data.characterId) throw badRequest('Choose someone to spend time with.');
    const character = getCharacter(data.characterId);
    if (!character.worldId) throw badRequest('That character is not part of a world.');
    if (character.worldId !== worldId) throw badRequest(`${character.name} isn't part of the active world.`);
    const day = ensureWorldState(worldId).day;
    const avail = getCharacterAvailability(worldId, day, character.id);
    if (!avail.available) {
      throw badRequest(`${character.name} ${avail.reason ?? 'is unavailable today'}.`);
    }
  }

  assertCanAct(worldId); // throws if out of stamina

  // Apply the reward and spend the action in ONE transaction, so a failure
  // can't leave a free reward (or a spent action with no reward).
  return getDb().transaction<ActivityResult>(() => {
    let money = 0;
    let relationship: Relationship | null = null;
    if (activity.kind === 'work') {
      money = activity.money ?? 0;
      addMoney(money, playerIdForWorld(worldId));
    } else {
      relationship = applyRelationshipChange(
        data.characterId!,
        { [activity.relationshipStat!]: activity.amount ?? 0 },
        { source: 'training', detail: { activityId: activity.id } },
      );
      stampLastDate(data.characterId!, ensureWorldState(worldId).day);
    }
    const state = spendStamina(worldId);
    recordEvent('activity', { worldId, activityId: activity.id, kind: activity.kind, characterId: data.characterId, money });
    return { activityId: activity.id, kind: activity.kind, money, relationship, state };
  });
}
