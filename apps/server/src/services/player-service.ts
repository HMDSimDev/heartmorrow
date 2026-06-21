import {
  DEFAULT_PLAYER_ID,
  DEFAULT_STARTING_MONEY,
  PlayerProfileSchema,
  levelForXp,
  type CareerSkill,
  type PlayerProfile,
  type PlayerUpdate,
} from '@dsim/shared';
import { playersRepo } from '../db/repositories';
import { badRequest } from '../lib/errors';
import { recordEvent } from './event-service';

/** Get the singleton player, creating it on first access. */
export function getOrCreatePlayer(id: string = DEFAULT_PLAYER_ID): PlayerProfile {
  const existing = playersRepo.get(id);
  if (existing) return existing;
  const now = Date.now();
  const player = PlayerProfileSchema.parse({
    id,
    name: 'Player',
    pronouns: 'they/them',
    personaNotes: '',
    money: DEFAULT_STARTING_MONEY,
    createdAt: now,
    updatedAt: now,
  });
  return playersRepo.insert(player);
}

export function updatePlayer(update: PlayerUpdate, id: string = DEFAULT_PLAYER_ID): PlayerProfile {
  const player = getOrCreatePlayer(id);
  const next = PlayerProfileSchema.parse({ ...player, ...update, updatedAt: Date.now() });
  return playersRepo.update(next);
}

/** Credit money (server-authoritative; never trusts a client-supplied amount).
 *  CREDIT-ONLY — a debit must go through {@link spendMoney} so it's gated on funds
 *  and the recorded ledger delta always equals the real balance change. */
export function addMoney(amount: number, id: string = DEFAULT_PLAYER_ID): PlayerProfile {
  if (!Number.isFinite(amount) || amount < 0) {
    throw badRequest('Add amount must be a non-negative number.');
  }
  const player = getOrCreatePlayer(id);
  const next = PlayerProfileSchema.parse({
    ...player,
    money: player.money + Math.round(amount),
    updatedAt: Date.now(),
  });
  const saved = playersRepo.update(next);
  recordEvent('player_money_change', { playerId: id, delta: saved.money - player.money, money: saved.money });
  return saved;
}

/** Current level of a career skill for a player (0 if never worked it). */
export function getSkillLevel(skill: CareerSkill, id: string = DEFAULT_PLAYER_ID): number {
  return getOrCreatePlayer(id).career[skill]?.level ?? 0;
}

/**
 * Grant career XP to a skill (server-authoritative; the client never supplies XP or
 * levels — only the work/minigame resolvers call this). Recomputes the level from the
 * new cumulative XP and persists. Returns the updated level and whether it advanced
 * (so callers can celebrate a level-up).
 */
export function grantCareerXp(
  skill: CareerSkill,
  xp: number,
  id: string = DEFAULT_PLAYER_ID,
): { level: number; leveledUp: boolean } {
  const player = getOrCreatePlayer(id);
  const prev = player.career[skill] ?? { xp: 0, level: 0 };
  const amount = Math.max(0, Math.round(xp));
  if (amount <= 0) return { level: prev.level, leveledUp: false };
  const nextXp = prev.xp + amount;
  const nextLevel = levelForXp(nextXp);
  const next = PlayerProfileSchema.parse({
    ...player,
    career: { ...player.career, [skill]: { xp: nextXp, level: nextLevel } },
    updatedAt: Date.now(),
  });
  playersRepo.update(next);
  if (nextLevel > prev.level) {
    recordEvent('career_level_up', { playerId: id, skill, level: nextLevel });
  }
  return { level: nextLevel, leveledUp: nextLevel > prev.level };
}

/** Spend money. Throws if the amount is invalid or funds are insufficient. */
export function spendMoney(amount: number, id: string = DEFAULT_PLAYER_ID): PlayerProfile {
  if (!Number.isFinite(amount) || amount < 0) {
    throw badRequest('Spend amount must be a non-negative number.');
  }
  const cost = Math.round(amount);
  const player = getOrCreatePlayer(id);
  if (player.money < cost) {
    throw badRequest(`Insufficient funds: need ${cost}, have ${player.money}.`);
  }
  const next = PlayerProfileSchema.parse({
    ...player,
    money: player.money - cost,
    updatedAt: Date.now(),
  });
  const saved = playersRepo.update(next);
  recordEvent('player_money_change', { playerId: id, delta: -cost, money: saved.money });
  return saved;
}
