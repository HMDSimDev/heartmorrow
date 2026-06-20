import {
  DEFAULT_PLAYER_ID,
  DEFAULT_STARTING_MONEY,
  PlayerProfileSchema,
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
