import {
  GamblingRoundSchema,
  resolveBetLimits,
  validateBet,
  shuffledDeck,
  blackjackHandValue,
  dealerShouldHit,
  settleBlackjack,
  spinSlots,
  slotResult,
  spinRoulette,
  rouletteColor,
  rouletteBetWins,
  rouletteBetPayout,
  classifyVideoPokerHand,
  videoPokerPayout,
  type BetLimits,
  type Card,
  type RouletteBet,
  type BlackjackOutcome,
  type VideoPokerRank,
  type GamblingRound,
  type GamblingWallet,
  type GamblingStateView,
  type BlackjackView,
  type VideoPokerView,
  type SlotsResult,
  type RouletteResult,
  type BlackjackResponse,
  type VideoPokerResponse,
} from '@dsim/shared';
import { getDb } from '../db/index';
import { worldsRepo, worldStatesRepo, gamblingRoundsRepo } from '../db/repositories';
import { newId, playerIdForWorld } from '../lib/ids';
import { badRequest, notFound } from '../lib/errors';
import { addMoney, getOrCreatePlayer, spendMoney } from './player-service';
import { recordEvent } from './event-service';

/**
 * The casino, behind the per-world `gambling` feature flag. The SERVER owns the
 * RNG and the money: every play debits the stake with {@link spendMoney}, draws
 * the outcome here (never trusting the client), credits winnings with
 * {@link addMoney}, and writes a `gambling_rounds` row — which doubles as the
 * settled-bet log and the per-day wager-cap ledger (SUM(bet) for the in-world
 * day). Interactive hands (blackjack / video poker) persist as `active` rounds
 * so a refresh resumes them, like an active date.
 *
 * The pure odds/paytable math lives in `@dsim/shared/gambling`; randomness is
 * injected (`rng: () => number = Math.random`) so tests are fully deterministic.
 */

type Rng = () => number;

// --- internal round state (stored in gambling_rounds.state JSON) ------------

interface BlackjackState {
  deck?: Card[]; // remaining shoe (present only while the hand is active)
  player: Card[];
  dealer: Card[];
  bet: number; // INITIAL bet (the doubled total lives on round.bet)
  doubled: boolean;
}

interface VideoPokerState {
  deck?: Card[];
  cards: Card[];
  held: boolean[];
  bet: number;
  rank?: VideoPokerRank;
}

// --- shared helpers ---------------------------------------------------------

function currentDay(worldId: string): number {
  return worldStatesRepo.get(worldId)?.day ?? 1;
}

function limitsFor(worldId: string): BetLimits {
  return resolveBetLimits(worldsRepo.get(worldId)?.gamblingConfig);
}

function walletFor(worldId: string, limits = limitsFor(worldId)): GamblingWallet {
  const playerId = playerIdForWorld(worldId);
  const money = getOrCreatePlayer(playerId).money;
  const wageredToday = gamblingRoundsRepo.wageredOn(worldId, playerId, currentDay(worldId));
  return {
    money,
    minBet: limits.minBet,
    maxBet: limits.maxBet,
    dailyLimit: limits.dailyLimit,
    wageredToday,
    remainingToday: Math.max(0, limits.dailyLimit - wageredToday),
  };
}

/** Enforce the per-bet + per-day wager caps for a new `stake`. Throws on failure. */
function assertWagerAllowed(worldId: string, stake: number, limits: BetLimits): void {
  const playerId = playerIdForWorld(worldId);
  const wageredToday = gamblingRoundsRepo.wageredOn(worldId, playerId, currentDay(worldId));
  const check = validateBet(stake, wageredToday, limits);
  if (!check.ok) throw badRequest(check.reason ?? 'That bet is not allowed.');
}

/**
 * Forfeit any active hand left over from a PRIOR in-world day (its stake was
 * already debited at deal time), then return a still-live SAME-DAY active hand
 * if one exists. Keeps "one open hand at a time" without stranding a stale row.
 */
function reapStaleActive(worldId: string, playerId: string, day: number): GamblingRound | undefined {
  const active = gamblingRoundsRepo.getActive(worldId, playerId);
  if (!active) return undefined;
  if (active.day < day) {
    gamblingRoundsRepo.upsert(
      GamblingRoundSchema.parse({
        ...active,
        status: 'settled',
        outcome: 'forfeit',
        payout: 0,
        state: { ...active.state, forfeited: true },
        updatedAt: Date.now(),
      }),
    );
    return undefined;
  }
  return active;
}

function recordRound(round: GamblingRound): void {
  recordEvent('gambling_round', {
    worldId: round.worldId,
    playerId: round.playerId,
    game: round.game,
    bet: round.bet,
    payout: round.payout,
    net: round.payout - round.bet,
    outcome: round.outcome,
    day: round.day,
  });
}

// --- read surface -----------------------------------------------------------

export function getGamblingState(worldId: string): GamblingStateView {
  const limits = limitsFor(worldId);
  const playerId = playerIdForWorld(worldId);
  const day = currentDay(worldId);
  const active = gamblingRoundsRepo.getActive(worldId, playerId);
  // Only resume a hand from TODAY (a stale one is forfeited on the next deal).
  const live = active && active.day === day ? active : undefined;
  return {
    wallet: walletFor(worldId, limits),
    activeBlackjack: live?.game === 'blackjack' ? blackjackView(live) : null,
    activeVideoPoker: live?.game === 'videoPoker' ? videoPokerView(live) : null,
  };
}

// --- Slots ------------------------------------------------------------------

export function playSlots(worldId: string, bet: number, rng: Rng = Math.random): SlotsResult {
  const limits = limitsFor(worldId);
  assertWagerAllowed(worldId, bet, limits);
  const playerId = playerIdForWorld(worldId);
  const day = currentDay(worldId);
  return getDb().transaction<SlotsResult>(() => {
    spendMoney(bet, playerId); // throws on insufficient funds → rolls back
    const spin = spinSlots(rng);
    const result = slotResult(spin.reels);
    const payout = Math.round(result.multiplier * bet);
    if (payout > 0) addMoney(payout, playerId);
    const now = Date.now();
    const round = gamblingRoundsRepo.upsert(
      GamblingRoundSchema.parse({
        id: newId('gmb'),
        worldId,
        playerId,
        game: 'slots',
        status: 'settled',
        bet,
        payout,
        outcome: payout > 0 ? 'win' : 'lose',
        state: { stops: spin.stops, reels: spin.reels, multiplier: result.multiplier, line: result.line },
        day,
        createdAt: now,
        updatedAt: now,
      }),
    );
    recordRound(round);
    return {
      stops: spin.stops,
      reels: spin.reels,
      multiplier: result.multiplier,
      line: result.line,
      bet,
      payout,
      net: payout - bet,
      wallet: walletFor(worldId, limits),
    };
  });
}

// --- Roulette ---------------------------------------------------------------

export function playRoulette(worldId: string, bets: RouletteBet[], rng: Rng = Math.random): RouletteResult {
  if (bets.length === 0) throw badRequest('Place at least one bet.');
  for (const b of bets) {
    if (!Number.isInteger(b.stake) || b.stake <= 0) throw badRequest('Every chip must be a positive amount.');
    if (b.kind === 'straight' && (b.value < 0 || b.value > 36)) throw badRequest('Pick a number from 0 to 36.');
    if ((b.kind === 'dozen' || b.kind === 'column') && (b.value < 1 || b.value > 3)) {
      throw badRequest('Pick dozen/column 1, 2, or 3.');
    }
  }
  const totalStake = bets.reduce((a, b) => a + b.stake, 0);
  const limits = limitsFor(worldId);
  assertWagerAllowed(worldId, totalStake, limits);
  const playerId = playerIdForWorld(worldId);
  const day = currentDay(worldId);
  return getDb().transaction<RouletteResult>(() => {
    spendMoney(totalStake, playerId);
    const number = spinRoulette(rng);
    const color = rouletteColor(number);
    const results = bets.map((bet) => ({ bet, won: rouletteBetWins(bet, number), payout: rouletteBetPayout(bet, number) }));
    const totalPayout = results.reduce((a, r) => a + r.payout, 0);
    if (totalPayout > 0) addMoney(totalPayout, playerId);
    const net = totalPayout - totalStake;
    const now = Date.now();
    const round = gamblingRoundsRepo.upsert(
      GamblingRoundSchema.parse({
        id: newId('gmb'),
        worldId,
        playerId,
        game: 'roulette',
        status: 'settled',
        bet: totalStake,
        payout: totalPayout,
        outcome: net > 0 ? 'win' : net === 0 ? 'push' : 'lose',
        state: { number, color, results },
        day,
        createdAt: now,
        updatedAt: now,
      }),
    );
    recordRound(round);
    return { number, color, bets: results, totalStake, totalPayout, net, wallet: walletFor(worldId, limits) };
  });
}

// --- Blackjack --------------------------------------------------------------

function blackjackView(round: GamblingRound): BlackjackView {
  const s = round.state as unknown as BlackjackState;
  const pv = blackjackHandValue(s.player);
  const done = round.status === 'settled';
  if (done) {
    const dv = blackjackHandValue(s.dealer);
    return {
      roundId: round.id,
      bet: round.bet,
      phase: 'done',
      player: s.player,
      playerTotal: pv.total,
      playerSoft: pv.soft,
      dealer: s.dealer,
      dealerTotal: dv.total,
      canHit: false,
      canStand: false,
      canDouble: false,
      outcome: (round.outcome as BlackjackOutcome) || 'lose',
      payout: round.payout,
      net: round.payout - round.bet,
    };
  }
  // Active: hide the dealer's hole card (only the up-card is visible).
  return {
    roundId: round.id,
    bet: round.bet,
    phase: 'player',
    player: s.player,
    playerTotal: pv.total,
    playerSoft: pv.soft,
    dealer: s.dealer.slice(0, 1),
    dealerTotal: null,
    canHit: true,
    canStand: true,
    canDouble: s.player.length === 2 && !s.doubled,
    outcome: null,
    payout: 0,
    net: 0,
  };
}

export function startBlackjack(worldId: string, bet: number, rng: Rng = Math.random): BlackjackResponse {
  const limits = limitsFor(worldId);
  assertWagerAllowed(worldId, bet, limits);
  const playerId = playerIdForWorld(worldId);
  const day = currentDay(worldId);
  return getDb().transaction<BlackjackResponse>(() => {
    if (reapStaleActive(worldId, playerId, day)) throw badRequest('Finish your current hand first.');
    spendMoney(bet, playerId);
    const deck = shuffledDeck(rng);
    const player = [deck.pop()!, deck.pop()!];
    const dealer = [deck.pop()!, deck.pop()!];
    const now = Date.now();
    const pv = blackjackHandValue(player);
    const dv = blackjackHandValue(dealer);
    const state: BlackjackState = { deck, player, dealer, bet, doubled: false };
    let round: GamblingRound;
    if (pv.blackjack || dv.blackjack) {
      // A natural ends the hand immediately (reveal both, no deck left needed).
      const settlement = settleBlackjack(player, dealer, bet);
      if (settlement.payout > 0) addMoney(settlement.payout, playerId);
      round = gamblingRoundsRepo.upsert(
        GamblingRoundSchema.parse({
          id: newId('gmb'), worldId, playerId, game: 'blackjack', status: 'settled',
          bet, payout: settlement.payout, outcome: settlement.outcome,
          state: { player, dealer, bet, doubled: false }, day, createdAt: now, updatedAt: now,
        }),
      );
      recordRound(round);
    } else {
      round = gamblingRoundsRepo.upsert(
        GamblingRoundSchema.parse({
          id: newId('gmb'), worldId, playerId, game: 'blackjack', status: 'active',
          bet, payout: 0, outcome: '', state, day, createdAt: now, updatedAt: now,
        }),
      );
    }
    return { view: blackjackView(round), wallet: walletFor(worldId, limits) };
  });
}

export function blackjackAction(
  worldId: string,
  roundId: string,
  action: 'hit' | 'stand' | 'double',
  rng: Rng = Math.random,
): BlackjackResponse {
  const limits = limitsFor(worldId);
  const playerId = playerIdForWorld(worldId);
  return getDb().transaction<BlackjackResponse>(() => {
    const round = gamblingRoundsRepo.get(roundId);
    if (!round || round.worldId !== worldId || round.playerId !== playerId) throw notFound('Hand not found.');
    if (round.game !== 'blackjack' || round.status !== 'active') throw badRequest('That hand is already finished.');
    const s = round.state as unknown as BlackjackState;
    const deck = s.deck ?? [];
    let totalBet = round.bet;

    const settle = (): GamblingRound => {
      // Dealer reveals and draws to 17.
      while (dealerShouldHit(s.dealer)) s.dealer.push(deck.pop()!);
      const settlement = settleBlackjack(s.player, s.dealer, totalBet);
      if (settlement.payout > 0) addMoney(settlement.payout, playerId);
      const done = gamblingRoundsRepo.upsert(
        GamblingRoundSchema.parse({
          ...round,
          status: 'settled',
          bet: totalBet,
          payout: settlement.payout,
          outcome: settlement.outcome,
          state: { player: s.player, dealer: s.dealer, bet: s.bet, doubled: s.doubled },
          updatedAt: Date.now(),
        }),
      );
      recordRound(done);
      return done;
    };

    let next: GamblingRound;
    if (action === 'hit') {
      s.player.push(deck.pop()!);
      if (blackjackHandValue(s.player).bust) {
        const settlement = settleBlackjack(s.player, s.dealer, totalBet); // bust → lose
        const done = gamblingRoundsRepo.upsert(
          GamblingRoundSchema.parse({
            ...round, status: 'settled', bet: totalBet, payout: settlement.payout, outcome: settlement.outcome,
            state: { player: s.player, dealer: s.dealer, bet: s.bet, doubled: s.doubled }, updatedAt: Date.now(),
          }),
        );
        recordRound(done);
        next = done;
      } else {
        next = gamblingRoundsRepo.upsert(
          GamblingRoundSchema.parse({ ...round, state: { ...s, deck }, updatedAt: Date.now() }),
        );
      }
    } else if (action === 'double') {
      if (s.player.length !== 2 || s.doubled) throw badRequest('You can only double on your first two cards.');
      // The extra stake must clear the per-day cap and the wallet.
      const check = validateBet(s.bet, gamblingRoundsRepo.wageredOn(worldId, playerId, round.day), limits);
      if (!check.ok) throw badRequest(check.reason ?? 'Cannot double down.');
      spendMoney(s.bet, playerId);
      totalBet = round.bet + s.bet;
      s.doubled = true;
      s.player.push(deck.pop()!);
      if (blackjackHandValue(s.player).bust) {
        const settlement = settleBlackjack(s.player, s.dealer, totalBet);
        const done = gamblingRoundsRepo.upsert(
          GamblingRoundSchema.parse({
            ...round, status: 'settled', bet: totalBet, payout: settlement.payout, outcome: settlement.outcome,
            state: { player: s.player, dealer: s.dealer, bet: s.bet, doubled: true }, updatedAt: Date.now(),
          }),
        );
        recordRound(done);
        next = done;
      } else {
        // Persist the doubled stake before the dealer resolves it.
        round.bet = totalBet; // settle() reads totalBet, but keep the row consistent
        next = settle();
      }
    } else {
      next = settle();
    }
    return { view: blackjackView(next), wallet: walletFor(worldId, limits) };
  });
}

// --- Video poker ------------------------------------------------------------

function videoPokerView(round: GamblingRound): VideoPokerView {
  const s = round.state as unknown as VideoPokerState;
  const done = round.status === 'settled';
  return {
    roundId: round.id,
    bet: round.bet,
    phase: done ? 'done' : 'draw',
    cards: s.cards,
    held: s.held,
    rank: done ? (s.rank ?? classifyVideoPokerHand(s.cards)) : null,
    payout: round.payout,
    net: done ? round.payout - round.bet : 0,
  };
}

export function startVideoPoker(worldId: string, bet: number, rng: Rng = Math.random): VideoPokerResponse {
  const limits = limitsFor(worldId);
  assertWagerAllowed(worldId, bet, limits);
  const playerId = playerIdForWorld(worldId);
  const day = currentDay(worldId);
  return getDb().transaction<VideoPokerResponse>(() => {
    if (reapStaleActive(worldId, playerId, day)) throw badRequest('Finish your current hand first.');
    spendMoney(bet, playerId);
    const deck = shuffledDeck(rng);
    const cards = [deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!];
    const now = Date.now();
    const state: VideoPokerState = { deck, cards, held: [false, false, false, false, false], bet };
    const round = gamblingRoundsRepo.upsert(
      GamblingRoundSchema.parse({
        id: newId('gmb'), worldId, playerId, game: 'videoPoker', status: 'active',
        bet, payout: 0, outcome: '', state, day, createdAt: now, updatedAt: now,
      }),
    );
    return { view: videoPokerView(round), wallet: walletFor(worldId, limits) };
  });
}

export function videoPokerDraw(worldId: string, roundId: string, holds: boolean[], rng: Rng = Math.random): VideoPokerResponse {
  const limits = limitsFor(worldId);
  const playerId = playerIdForWorld(worldId);
  if (holds.length !== 5) throw badRequest('Hold exactly five slots.');
  return getDb().transaction<VideoPokerResponse>(() => {
    const round = gamblingRoundsRepo.get(roundId);
    if (!round || round.worldId !== worldId || round.playerId !== playerId) throw notFound('Hand not found.');
    if (round.game !== 'videoPoker' || round.status !== 'active') throw badRequest('That hand is already finished.');
    const s = round.state as unknown as VideoPokerState;
    const deck = s.deck ?? [];
    const final = s.cards.map((c, i) => (holds[i] ? c : deck.pop()!));
    const { rank, payout } = videoPokerPayout(final, round.bet);
    if (payout > 0) addMoney(payout, playerId);
    const done = gamblingRoundsRepo.upsert(
      GamblingRoundSchema.parse({
        ...round,
        status: 'settled',
        payout,
        outcome: rank === 'none' ? 'lose' : 'win',
        state: { cards: final, held: holds, bet: round.bet, rank },
        updatedAt: Date.now(),
      }),
    );
    recordRound(done);
    return { view: videoPokerView(done), wallet: walletFor(worldId, limits) };
  });
}
