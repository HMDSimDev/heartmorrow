import { describe, it, expect } from 'vitest';
import {
  makeDeck,
  shuffle,
  blackjackHandValue,
  dealerShouldHit,
  settleBlackjack,
  classifyVideoPokerHand,
  videoPokerPayout,
  VIDEO_POKER_PAYTABLE,
  SLOT_REEL,
  slotResult,
  spinSlots,
  rouletteColor,
  rouletteBetWins,
  rouletteBetPayout,
  spinRoulette,
  resolveBetLimits,
  validateBet,
  GAMBLING,
  type Card,
  type Rank,
  type Suit,
  type RouletteBet,
} from './index';

const card = (rank: Rank, suit: Suit = 'spades'): Card => ({ rank, suit });
/** A tiny deterministic LCG for shuffle tests (NOT used by game logic). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('cards', () => {
  it('builds a full unique 52-card deck', () => {
    const deck = makeDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((c) => `${c.rank}${c.suit}`)).size).toBe(52);
  });

  it('shuffle is deterministic given the rng and preserves the multiset', () => {
    const a = shuffle(makeDeck(), lcg(42));
    const b = shuffle(makeDeck(), lcg(42));
    const c = shuffle(makeDeck(), lcg(7));
    expect(a).toEqual(b); // same seed → same order
    expect(a).not.toEqual(c); // different seed → different order
    expect(new Set(a.map((x) => `${x.rank}${x.suit}`)).size).toBe(52);
  });
});

describe('blackjack hand value', () => {
  it('scores a natural blackjack', () => {
    expect(blackjackHandValue([card('A'), card('K')])).toMatchObject({ total: 21, blackjack: true, bust: false });
  });
  it('softens aces to avoid busting', () => {
    expect(blackjackHandValue([card('A'), card('6'), card('10')])).toMatchObject({ total: 17, soft: false });
    expect(blackjackHandValue([card('A'), card('A')])).toMatchObject({ total: 12, soft: true });
    expect(blackjackHandValue([card('A'), card('9')])).toMatchObject({ total: 20, soft: true });
  });
  it('detects a bust', () => {
    expect(blackjackHandValue([card('10'), card('9'), card('5')])).toMatchObject({ total: 24, bust: true });
  });
  it('dealer hits below 17 and stands on soft 17', () => {
    expect(dealerShouldHit([card('10'), card('6')])).toBe(true); // 16
    expect(dealerShouldHit([card('A'), card('6')])).toBe(false); // soft 17 → stand
    expect(dealerShouldHit([card('10'), card('7')])).toBe(false); // 17
  });
});

describe('blackjack settlement', () => {
  it('pays 3:2 on a natural vs a non-natural dealer', () => {
    const s = settleBlackjack([card('A'), card('K')], [card('10'), card('7')], 10);
    expect(s.outcome).toBe('blackjack');
    expect(s.payout).toBe(10 + 15); // 3:2 on 10
  });
  it('pushes two naturals; loses to a dealer natural', () => {
    expect(settleBlackjack([card('A'), card('K')], [card('A'), card('Q')], 10).outcome).toBe('push');
    expect(settleBlackjack([card('10'), card('8')], [card('A'), card('K')], 10)).toMatchObject({ outcome: 'lose', payout: 0 });
  });
  it('settles ordinary win / push / lose / bust', () => {
    expect(settleBlackjack([card('10'), card('9')], [card('10'), card('8')], 10)).toMatchObject({ outcome: 'win', payout: 20 });
    expect(settleBlackjack([card('10'), card('8')], [card('10'), card('8')], 10)).toMatchObject({ outcome: 'push', payout: 10 });
    expect(settleBlackjack([card('10'), card('7')], [card('10'), card('9')], 10)).toMatchObject({ outcome: 'lose', payout: 0 });
    expect(settleBlackjack([card('10'), card('9'), card('5')], [card('10'), card('7')], 10)).toMatchObject({ outcome: 'lose', payout: 0 });
  });
  it('a dealer bust wins for a standing player', () => {
    expect(settleBlackjack([card('10'), card('7')], [card('10'), card('6'), card('9')], 10)).toMatchObject({ outcome: 'win', payout: 20 });
  });
});

describe('video poker classification', () => {
  const S = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as const;
  const h = (...cs: Array<[Rank, keyof typeof S]>): Card[] => cs.map(([r, s]) => card(r, S[s]));
  it('classifies each pay rank', () => {
    expect(classifyVideoPokerHand(h(['10', 's'], ['J', 's'], ['Q', 's'], ['K', 's'], ['A', 's']))).toBe('royalFlush');
    expect(classifyVideoPokerHand(h(['5', 'h'], ['6', 'h'], ['7', 'h'], ['8', 'h'], ['9', 'h']))).toBe('straightFlush');
    expect(classifyVideoPokerHand(h(['9', 's'], ['9', 'h'], ['9', 'd'], ['9', 'c'], ['2', 's']))).toBe('fourKind');
    expect(classifyVideoPokerHand(h(['K', 's'], ['K', 'h'], ['K', 'd'], ['2', 's'], ['2', 'h']))).toBe('fullHouse');
    expect(classifyVideoPokerHand(h(['2', 's'], ['5', 's'], ['9', 's'], ['J', 's'], ['K', 's']))).toBe('flush');
    expect(classifyVideoPokerHand(h(['5', 's'], ['6', 'h'], ['7', 'd'], ['8', 'c'], ['9', 's']))).toBe('straight');
    expect(classifyVideoPokerHand(h(['A', 's'], ['2', 'h'], ['3', 'd'], ['4', 'c'], ['5', 's']))).toBe('straight'); // wheel
    expect(classifyVideoPokerHand(h(['7', 's'], ['7', 'h'], ['7', 'd'], ['2', 's'], ['3', 'h']))).toBe('threeKind');
    expect(classifyVideoPokerHand(h(['7', 's'], ['7', 'h'], ['3', 'd'], ['3', 's'], ['K', 'h']))).toBe('twoPair');
    expect(classifyVideoPokerHand(h(['J', 's'], ['J', 'h'], ['2', 'd'], ['3', 's'], ['4', 'h']))).toBe('jacksOrBetter');
    expect(classifyVideoPokerHand(h(['5', 's'], ['5', 'h'], ['2', 'd'], ['3', 's'], ['K', 'h']))).toBe('none'); // low pair
    expect(classifyVideoPokerHand(h(['2', 's'], ['5', 'h'], ['9', 'd'], ['J', 'c'], ['K', 's']))).toBe('none'); // high card
  });
  it('pays the paytable multiplier on the bet', () => {
    const full = videoPokerPayout(h(['K', 's'], ['K', 'h'], ['K', 'd'], ['2', 's'], ['2', 'h']), 10);
    expect(full).toEqual({ rank: 'fullHouse', payout: VIDEO_POKER_PAYTABLE.fullHouse * 10 });
    expect(videoPokerPayout(h(['2', 's'], ['5', 'h'], ['9', 'd'], ['J', 'c'], ['K', 's']), 10).payout).toBe(0);
  });
});

describe('slots', () => {
  it('has a house edge in a sane band (exact enumeration)', () => {
    let total = 0;
    for (const a of SLOT_REEL) for (const b of SLOT_REEL) for (const c of SLOT_REEL) {
      total += slotResult([a, b, c]).multiplier;
    }
    const rtp = total / SLOT_REEL.length ** 3;
    // Gross return-for-one averaged over every line = RTP. House keeps 7–12%.
    expect(rtp).toBeGreaterThan(0.88);
    expect(rtp).toBeLessThan(0.93);
  });
  it('pays triples and two-cherry consolation; everything else loses', () => {
    expect(slotResult(['seven', 'seven', 'seven']).multiplier).toBe(250);
    expect(slotResult(['cherry', 'cherry', 'lemon']).multiplier).toBe(3);
    expect(slotResult(['bar', 'bell', 'seven']).multiplier).toBe(0);
  });
  it('spins land on the reel symbol the rng selects', () => {
    const spin = spinSlots(() => 0); // index 0 on every reel → first symbol
    expect(spin.reels).toEqual([SLOT_REEL[0], SLOT_REEL[0], SLOT_REEL[0]]);
  });
});

describe('roulette', () => {
  it('colors pockets correctly', () => {
    expect(rouletteColor(0)).toBe('green');
    expect(rouletteColor(1)).toBe('red');
    expect(rouletteColor(2)).toBe('black');
  });
  it('pays straight 35:1 and even-money outside bets; the zero sinks outside bets', () => {
    const straight: RouletteBet = { kind: 'straight', value: 17, stake: 10 };
    expect(rouletteBetPayout(straight, 17)).toBe(360); // 10 * 36
    expect(rouletteBetPayout(straight, 18)).toBe(0);
    const red: RouletteBet = { kind: 'red', value: 0, stake: 10 };
    expect(rouletteBetPayout(red, 1)).toBe(20);
    expect(rouletteBetPayout(red, 2)).toBe(0);
    expect(rouletteBetWins({ kind: 'even', value: 0, stake: 5 }, 0)).toBe(false);
    expect(rouletteBetPayout({ kind: 'dozen', value: 2, stake: 10 }, 15)).toBe(30); // 13-24 → 2:1
  });
  it('spins within 0..36', () => {
    expect(spinRoulette(() => 0)).toBe(0);
    expect(spinRoulette(() => 0.9999999)).toBe(36);
  });
});

describe('limits + bet validation', () => {
  it('clamps per-world overrides to the global floors/ceilings', () => {
    expect(resolveBetLimits(undefined)).toEqual({
      minBet: GAMBLING.MIN_BET,
      maxBet: GAMBLING.DEFAULT_MAX_BET,
      dailyLimit: GAMBLING.DEFAULT_DAILY_WAGER_LIMIT,
    });
    const huge = resolveBetLimits({ maxBet: 9_999_999, dailyWagerLimit: 9_999_999 });
    expect(huge.maxBet).toBe(GAMBLING.ABSOLUTE_MAX_BET);
    expect(huge.dailyLimit).toBe(GAMBLING.ABSOLUTE_MAX_DAILY_WAGER);
    // daily limit can never sit below the per-bet cap.
    expect(resolveBetLimits({ maxBet: 200, dailyWagerLimit: 5 }).dailyLimit).toBe(200);
  });
  it('rejects bets outside the caps', () => {
    const limits = resolveBetLimits(undefined);
    expect(validateBet(GAMBLING.MIN_BET - 1, 0, limits).ok).toBe(false);
    expect(validateBet(limits.maxBet + 1, 0, limits).ok).toBe(false);
    expect(validateBet(100, limits.dailyLimit - 50, limits).ok).toBe(false);
    expect(validateBet(100, 0, limits).ok).toBe(true);
  });
});
