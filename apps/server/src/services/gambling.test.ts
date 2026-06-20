import { describe, it, expect, beforeEach } from 'vitest';
import { WorldStateSchema } from '@dsim/shared';
import { resetDb } from '../test/helpers';
import { createWorld, updateWorld } from '../services/world-service';
import { ensureWorldState } from '../services/world-clock-service';
import { worldStatesRepo, gamblingRoundsRepo } from '../db/repositories';
import { playerIdForWorld } from '../lib/ids';
import { addMoney, spendMoney, getOrCreatePlayer } from '../services/player-service';
import { requireFeature } from '../services/world-feature-service';
import { exportAll, resetProgress } from '../services/data-service';
import { AppError } from '../lib/errors';
import {
  getGamblingState,
  playSlots,
  playRoulette,
  startBlackjack,
  blackjackAction,
  startVideoPoker,
  videoPokerDraw,
} from '../services/gambling-service';

function casinoWorld(balance = 10_000, config?: { maxBet?: number; dailyWagerLimit?: number }) {
  const world = createWorld({ name: 'Casino World', featureFlags: { gambling: true } });
  ensureWorldState(world.id);
  if (config) updateWorld(world.id, { gamblingConfig: config });
  // Set the wallet to EXACTLY `balance` (the per-world player starts at 250).
  const pid = playerIdForWorld(world.id);
  const cur = getOrCreatePlayer(pid).money;
  if (balance > cur) addMoney(balance - cur, pid);
  else if (balance < cur) spendMoney(cur - balance, pid);
  return world;
}
const moneyOf = (worldId: string) => getOrCreatePlayer(playerIdForWorld(worldId)).money;
/** rng yielding a fixed sequence, repeating the last value. */
const seq = (...vals: number[]) => {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)]!;
};
function bumpDay(worldId: string) {
  const st = worldStatesRepo.get(worldId)!;
  worldStatesRepo.update(WorldStateSchema.parse({ ...st, day: st.day + 1, updatedAt: Date.now() }));
}

describe('gambling feature gate', () => {
  beforeEach(() => resetDb());
  it('requireFeature throws 403 when gambling is off, passes when on', () => {
    const off = createWorld({ name: 'Plain', featureFlags: { gambling: false } });
    try {
      requireFeature(off.id, 'gambling');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(403);
    }
    const on = casinoWorld();
    expect(() => requireFeature(on.id, 'gambling')).not.toThrow();
  });
});

describe('slots', () => {
  beforeEach(() => resetDb());
  it('debits the stake and credits a winning line (server RNG)', () => {
    const w = casinoWorld(10_000);
    const before = moneyOf(w.id);
    const res = playSlots(w.id, 10, () => 0.95); // every reel lands on a seven → triple
    expect(res.reels).toEqual(['seven', 'seven', 'seven']);
    expect(res.payout).toBe(2500);
    expect(res.net).toBe(2490);
    expect(moneyOf(w.id)).toBe(before - 10 + 2500);
    expect(res.wallet.money).toBe(moneyOf(w.id));
    expect(res.wallet.wageredToday).toBe(10);
  });
  it('a losing spin keeps only the stake', () => {
    const w = casinoWorld(10_000);
    const res = playSlots(w.id, 10, seq(0, 0.13, 0.42)); // cherry/lemon/plum → no pay
    expect(res.payout).toBe(0);
    expect(moneyOf(w.id)).toBe(9_990);
  });
});

describe('wager limits', () => {
  beforeEach(() => resetDb());
  it('enforces the per-bet cap', () => {
    const w = casinoWorld(10_000, { maxBet: 50, dailyWagerLimit: 1_000 });
    expect(() => playSlots(w.id, 51, seq(0, 0.13, 0.42))).toThrow(/Maximum bet/);
    expect(() => playSlots(w.id, 50, seq(0, 0.13, 0.42))).not.toThrow();
  });
  it('enforces the per-day wager cap and resets it on a new day', () => {
    const w = casinoWorld(10_000, { maxBet: 50, dailyWagerLimit: 100 });
    const loss = () => seq(0, 0.13, 0.42);
    playSlots(w.id, 50, loss());
    playSlots(w.id, 50, loss()); // 100 wagered → at the cap
    expect(() => playSlots(w.id, 50, loss())).toThrow(/Daily wager limit/);
    bumpDay(w.id);
    expect(getGamblingState(w.id).wallet.wageredToday).toBe(0);
    expect(() => playSlots(w.id, 50, loss())).not.toThrow(); // fresh day
  });
  it('rejects a bet the wallet cannot cover (atomic — no debit on failure)', () => {
    const w = casinoWorld(30);
    expect(() => playSlots(w.id, 50, seq(0, 0.13, 0.42))).toThrow(/Insufficient/);
    expect(moneyOf(w.id)).toBe(30);
    expect(gamblingRoundsRepo.wageredOn(w.id, playerIdForWorld(w.id), 1)).toBe(0);
  });
});

describe('roulette', () => {
  beforeEach(() => resetDb());
  it('pays a winning straight bet and sinks the losers', () => {
    const w = casinoWorld(10_000);
    const before = moneyOf(w.id);
    const res = playRoulette(w.id, [{ kind: 'straight', value: 17, stake: 10 }], () => 0.46); // → 17
    expect(res.number).toBe(17);
    expect(res.totalPayout).toBe(360);
    expect(moneyOf(w.id)).toBe(before - 10 + 360);
    const lose = playRoulette(w.id, [{ kind: 'straight', value: 5, stake: 10 }], () => 0.46);
    expect(lose.totalPayout).toBe(0);
  });
  it('caps total chips by the per-bet limit', () => {
    const w = casinoWorld(10_000, { maxBet: 50, dailyWagerLimit: 1_000 });
    expect(() =>
      playRoulette(w.id, [{ kind: 'red', value: 0, stake: 40 }, { kind: 'black', value: 0, stake: 40 }], () => 0.46),
    ).toThrow(/Maximum bet/);
  });
});

describe('blackjack flow', () => {
  beforeEach(() => resetDb());
  it('conserves money across many hands (final = start - bet + payout)', () => {
    const w = casinoWorld(10_000);
    for (let i = 0; i < 15; i += 1) {
      const before = moneyOf(w.id);
      let r = startBlackjack(w.id, 10);
      if (r.view.phase === 'player') r = blackjackAction(w.id, r.view.roundId, 'stand');
      expect(r.view.phase).toBe('done');
      expect(moneyOf(w.id)).toBe(before - r.view.bet + r.view.payout);
    }
  });
  it('hides the dealer hole card until the hand resolves', () => {
    const w = casinoWorld(10_000);
    const r = startBlackjack(w.id, 10);
    if (r.view.phase === 'player') {
      expect(r.view.dealer).toHaveLength(1);
      expect(r.view.dealerTotal).toBeNull();
    }
  });
  it('doubling down doubles the stake and ends the hand', () => {
    const w = casinoWorld(10_000);
    let r = startBlackjack(w.id, 10);
    if (r.view.phase === 'player' && r.view.canDouble) {
      const before = moneyOf(w.id); // already down the initial 10
      r = blackjackAction(w.id, r.view.roundId, 'double');
      expect(r.view.bet).toBe(20);
      expect(r.view.phase).toBe('done');
      // extra 10 staked; final wallet reflects the doubled bet + payout.
      expect(moneyOf(w.id)).toBe(before - 10 + r.view.payout);
    }
  });
  it('only one interactive hand may be open at a time', () => {
    const w = casinoWorld(10_000);
    startVideoPoker(w.id, 10); // active draw hand
    expect(() => startVideoPoker(w.id, 10)).toThrow(/Finish your current hand/);
    expect(() => startBlackjack(w.id, 10)).toThrow(/Finish your current hand/);
  });
});

describe('video poker flow', () => {
  beforeEach(() => resetDb());
  it('deals five, settles on draw, and conserves money', () => {
    const w = casinoWorld(10_000);
    const before = moneyOf(w.id);
    const start = startVideoPoker(w.id, 20);
    expect(start.view.cards).toHaveLength(5);
    expect(start.view.phase).toBe('draw');
    const draw = videoPokerDraw(w.id, start.view.roundId, [false, false, false, false, false]);
    expect(draw.view.phase).toBe('done');
    expect(draw.view.rank).not.toBeNull();
    expect(moneyOf(w.id)).toBe(before - 20 + draw.view.payout);
  });
  it('holding all five keeps the dealt hand', () => {
    const w = casinoWorld(10_000);
    const start = startVideoPoker(w.id, 10);
    const draw = videoPokerDraw(w.id, start.view.roundId, [true, true, true, true, true]);
    expect(draw.view.cards).toEqual(start.view.cards);
  });
});

describe('stale hands + resume', () => {
  beforeEach(() => resetDb());
  it('forfeits an active hand left from a prior day', () => {
    const w = casinoWorld(10_000);
    const stale = startVideoPoker(w.id, 10);
    bumpDay(w.id);
    // A new hand on the new day reaps the old one (its stake was already taken).
    startVideoPoker(w.id, 10);
    const old = gamblingRoundsRepo.get(stale.view.roundId)!;
    expect(old.status).toBe('settled');
    expect(old.outcome).toBe('forfeit');
  });
  it('getGamblingState resumes an active hand from today', () => {
    const w = casinoWorld(10_000);
    const start = startVideoPoker(w.id, 10);
    const state = getGamblingState(w.id);
    expect(state.activeVideoPoker?.roundId).toBe(start.view.roundId);
    expect(state.activeBlackjack).toBeNull();
  });
});

describe('persistence', () => {
  beforeEach(() => resetDb());
  it('exports settled rounds and a reset wipes them', () => {
    const w = casinoWorld(10_000);
    playSlots(w.id, 10, () => 0.95);
    expect(exportAll().gamblingRounds.length).toBe(1);
    resetProgress();
    expect(gamblingRoundsRepo.list()).toHaveLength(0);
    expect(moneyOf(w.id)).toBe(0); // DEFAULT_STARTING_MONEY (a fresh wallet starts empty)
  });
});
