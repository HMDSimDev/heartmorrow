import { z } from 'zod';
import { GAMBLING } from './constants';

/**
 * Gambling domain primitives: the casino games behind the world `gambling`
 * feature flag (slots, blackjack, roulette, video poker).
 *
 * Like {@link ./wealth}, this module is PURE and deterministic — no persistence,
 * no LLM, and crucially NO internal randomness. Every game of chance takes its
 * randomness as an injected roll (a `() => number` rng yielding [0,1), mirroring
 * the `rng: () => number = Math.random` convention used elsewhere on the server).
 * That keeps the server the money authority while letting tests feed a stubbed
 * rng for fully deterministic outcomes. The web client imports the pure helpers
 * (labels, hand values, paytables) so its animations land on the same result the
 * server settled.
 */

// --- Games ------------------------------------------------------------------

/** The casino games shipped in v1. `videoPoker` is single-player Jacks-or-Better
 *  draw poker (the future "poker" feature is the multiplayer table game). */
export const CasinoGameSchema = z.enum(['slots', 'blackjack', 'roulette', 'videoPoker']);
export type CasinoGame = z.infer<typeof CasinoGameSchema>;

export const CASINO_GAME_LABELS: Record<CasinoGame, string> = {
  slots: 'Lucky Sevens',
  blackjack: 'Blackjack',
  roulette: 'Roulette',
  videoPoker: 'Video Poker',
};

/** One-line house blurb shown on each game's lobby tile. */
export const CASINO_GAME_BLURBS: Record<CasinoGame, string> = {
  slots: 'Three reels. Match the line and the lamps light up.',
  blackjack: 'Beat the dealer to 21. Hit, stand, or double down.',
  roulette: 'One green zero. Place your chips and watch the wheel.',
  videoPoker: 'Jacks or better pays. Hold the keepers, draw the rest.',
};

export const CASINO_GAMES: CasinoGame[] = ['slots', 'blackjack', 'roulette', 'videoPoker'];

// --- Cards ------------------------------------------------------------------

export const SuitSchema = z.enum(['clubs', 'diamonds', 'hearts', 'spades']);
export type Suit = z.infer<typeof SuitSchema>;

export const RankSchema = z.enum(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
export type Rank = z.infer<typeof RankSchema>;

export const CardSchema = z.object({ suit: SuitSchema, rank: RankSchema });
export type Card = z.infer<typeof CardSchema>;

/** Unicode pip for a suit (diegetic card art — allowed, like the ◈ currency mark). */
export const SUIT_PIP: Record<Suit, string> = {
  clubs: '♣',
  diamonds: '♦',
  hearts: '♥',
  spades: '♠',
};

/** Whether a suit renders red (hearts/diamonds) vs ink (clubs/spades). */
export function isRedSuit(suit: Suit): boolean {
  return suit === 'hearts' || suit === 'diamonds';
}

/** High-card value of a rank (Ace high = 14). The blackjack/wheel low-ace cases
 *  are handled in their own evaluators. */
export function rankValue(rank: Rank): number {
  switch (rank) {
    case 'A':
      return 14;
    case 'K':
      return 13;
    case 'Q':
      return 12;
    case 'J':
      return 11;
    default:
      return Number(rank);
  }
}

/** A fresh, ordered 52-card deck (deterministic order; shuffle before dealing). */
export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SuitSchema.options) {
    for (const rank of RankSchema.options) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

/**
 * Fisher-Yates shuffle into a NEW array using an injected rng. Pure given the
 * rng — feed a stubbed sequence in tests. The server draws the live rng.
 */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(clamp(rng(), 0, 0.9999999) * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** A freshly shuffled 52-card shoe. */
export function shuffledDeck(rng: () => number): Card[] {
  return shuffle(makeDeck(), rng);
}

// --- Blackjack --------------------------------------------------------------

export interface HandValue {
  /** Best total <= 21 when possible (aces softened as needed). */
  total: number;
  /** True if an ace is still counted as 11 (a "soft" hand). */
  soft: boolean;
  /** A two-card natural 21. */
  blackjack: boolean;
  bust: boolean;
}

/** Evaluate a blackjack hand, softening aces from 11→1 to avoid busting. */
export function blackjackHandValue(cards: Card[]): HandValue {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 'A') {
      aces += 1;
      total += 11;
    } else if (c.rank === 'K' || c.rank === 'Q' || c.rank === 'J' || c.rank === '10') {
      total += 10;
    } else {
      total += Number(c.rank);
    }
  }
  let softAces = aces;
  while (total > 21 && softAces > 0) {
    total -= 10;
    softAces -= 1;
  }
  return {
    total,
    soft: softAces > 0,
    blackjack: cards.length === 2 && total === 21,
    bust: total > 21,
  };
}

/** Dealer policy: hit until reaching 17 (STANDS on all 17s, including soft 17). */
export function dealerShouldHit(cards: Card[]): boolean {
  return blackjackHandValue(cards).total < 17;
}

export const BlackjackOutcomeSchema = z.enum(['blackjack', 'win', 'push', 'lose']);
export type BlackjackOutcome = z.infer<typeof BlackjackOutcomeSchema>;

export interface BlackjackSettlement {
  outcome: BlackjackOutcome;
  /** Gross return credited to the player (stake INCLUDED). 0 = lost the stake,
   *  `bet` = push, `2*bet` = even-money win, `bet + floor(1.5*bet)` = natural. */
  payout: number;
}

/**
 * Settle a finished blackjack hand. `bet` is the TOTAL staked on this hand
 * (already doubled if the player doubled down). A natural blackjack only counts
 * when the player did not draw extra cards (2 cards) and did not double.
 */
export function settleBlackjack(player: Card[], dealer: Card[], bet: number): BlackjackSettlement {
  const p = blackjackHandValue(player);
  const d = blackjackHandValue(dealer);
  if (p.bust) return { outcome: 'lose', payout: 0 };
  const playerNatural = p.blackjack;
  const dealerNatural = d.blackjack;
  if (playerNatural && !dealerNatural) {
    // 3:2 on a natural (house-favourable floor on odd stakes).
    return { outcome: 'blackjack', payout: bet + Math.floor((bet * GAMBLING.BLACKJACK_NUMERATOR) / GAMBLING.BLACKJACK_DENOMINATOR) };
  }
  if (playerNatural && dealerNatural) return { outcome: 'push', payout: bet };
  if (dealerNatural) return { outcome: 'lose', payout: 0 };
  if (d.bust) return { outcome: 'win', payout: bet * 2 };
  if (p.total > d.total) return { outcome: 'win', payout: bet * 2 };
  if (p.total < d.total) return { outcome: 'lose', payout: 0 };
  return { outcome: 'push', payout: bet };
}

// --- Video poker (Jacks or Better) ------------------------------------------

export const VideoPokerRankSchema = z.enum([
  'none',
  'jacksOrBetter',
  'twoPair',
  'threeKind',
  'straight',
  'flush',
  'fullHouse',
  'fourKind',
  'straightFlush',
  'royalFlush',
]);
export type VideoPokerRank = z.infer<typeof VideoPokerRankSchema>;

export const VIDEO_POKER_RANK_LABELS: Record<VideoPokerRank, string> = {
  none: 'No pay',
  jacksOrBetter: 'Jacks or Better',
  twoPair: 'Two Pair',
  threeKind: 'Three of a Kind',
  straight: 'Straight',
  flush: 'Flush',
  fullHouse: 'Full House',
  fourKind: 'Four of a Kind',
  straightFlush: 'Straight Flush',
  royalFlush: 'Royal Flush',
};

/**
 * Gross return-for-one paytable (8/5 Jacks-or-Better). The credited payout is
 * `multiplier * bet` (stake included), so `jacksOrBetter` (1) returns the stake
 * — a push — and `none` (0) loses it. ~97% RTP under optimal play; the daily
 * wager cap is the real guard against it becoming a money faucet.
 */
export const VIDEO_POKER_PAYTABLE: Record<VideoPokerRank, number> = {
  none: 0,
  jacksOrBetter: 1,
  twoPair: 2,
  threeKind: 3,
  straight: 4,
  flush: 5,
  fullHouse: 8,
  fourKind: 25,
  straightFlush: 50,
  royalFlush: 250,
};

/** Classify a 5-card hand into its Jacks-or-Better payout rank. */
export function classifyVideoPokerHand(cards: Card[]): VideoPokerRank {
  if (cards.length !== 5) return 'none';
  const values = cards.map((c) => rankValue(c.rank)).sort((a, b) => a - b);
  const flush = cards.every((c) => c.suit === cards[0]!.suit);
  const straightInfo = straightHighCard(values);
  const straight = straightInfo > 0;

  // Rank frequency for pairs / trips / quads.
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const groups = [...counts.values()].sort((a, b) => b - a);

  if (straight && flush) {
    // Royal = ace-high straight flush (10-J-Q-K-A → high card 14).
    return straightInfo === 14 ? 'royalFlush' : 'straightFlush';
  }
  if (groups[0] === 4) return 'fourKind';
  if (groups[0] === 3 && groups[1] === 2) return 'fullHouse';
  if (flush) return 'flush';
  if (straight) return 'straight';
  if (groups[0] === 3) return 'threeKind';
  if (groups[0] === 2 && groups[1] === 2) return 'twoPair';
  if (groups[0] === 2) {
    // A single pair only pays at Jacks or Better.
    for (const [val, cnt] of counts) {
      if (cnt === 2) return val >= 11 ? 'jacksOrBetter' : 'none';
    }
  }
  return 'none';
}

/** Gross payout (stake included) for a settled video-poker hand at `bet`. */
export function videoPokerPayout(cards: Card[], bet: number): { rank: VideoPokerRank; payout: number } {
  const rank = classifyVideoPokerHand(cards);
  return { rank, payout: VIDEO_POKER_PAYTABLE[rank] * bet };
}

/**
 * Return the high-card value of a 5-card straight (0 if not a straight). Handles
 * the wheel (A-2-3-4-5, high card 5) and ace-high (10-J-Q-K-A, high card 14).
 * Input `values` must be sorted ascending Ace-high (A = 14).
 */
function straightHighCard(values: number[]): number {
  const uniq = [...new Set(values)];
  if (uniq.length !== 5) return 0;
  // Wheel: A,2,3,4,5 reads as 14,2,3,4,5 sorted → treat ace as 1.
  if (uniq[0] === 2 && uniq[1] === 3 && uniq[2] === 4 && uniq[3] === 5 && uniq[4] === 14) return 5;
  if (uniq[4]! - uniq[0]! === 4) return uniq[4]!;
  return 0;
}

// --- Slots (3-reel single line) ---------------------------------------------

export const SlotSymbolSchema = z.enum(['cherry', 'lemon', 'plum', 'bell', 'bar', 'seven']);
export type SlotSymbol = z.infer<typeof SlotSymbolSchema>;

/** Diegetic glyph for each reel symbol (no UI emoji rules — these are game art). */
export const SLOT_SYMBOL_GLYPH: Record<SlotSymbol, string> = {
  cherry: '\u{1F352}',
  lemon: '\u{1F34B}',
  plum: '\u{1F347}',
  bell: '\u{1F514}',
  bar: '\u{1F4A0}',
  seven: '7',
};

export const SLOT_SYMBOL_LABELS: Record<SlotSymbol, string> = {
  cherry: 'Cherries',
  lemon: 'Lemon',
  plum: 'Plum',
  bell: 'Bell',
  bar: 'Bar',
  seven: 'Lucky Seven',
};

/**
 * The virtual reel strip (identical on all three reels). Repetition sets each
 * symbol's hit frequency; rarer symbols pay more. 39 stops total. Tuned with the
 * paytable below to ~90.5% RTP / 9.5% house edge (verified by exact enumeration
 * in gambling.test.ts).
 */
export const SLOT_REEL: SlotSymbol[] = [
  'cherry', 'cherry', 'cherry', 'cherry', 'cherry',
  'lemon', 'lemon', 'lemon', 'lemon', 'lemon', 'lemon', 'lemon', 'lemon', 'lemon', 'lemon', 'lemon',
  'plum', 'plum', 'plum', 'plum', 'plum', 'plum', 'plum', 'plum', 'plum', 'plum',
  'bell', 'bell', 'bell', 'bell', 'bell', 'bell', 'bell',
  'bar', 'bar', 'bar', 'bar',
  'seven', 'seven',
];

/** Gross return-for-one for three matching symbols on the line. */
export const SLOT_TRIPLE_PAYOUT: Record<SlotSymbol, number> = {
  cherry: 24,
  lemon: 9,
  plum: 13,
  bell: 30,
  bar: 90,
  seven: 250,
};

/** Consolation pay for exactly two cherries on the line (no full triple). */
export const SLOT_CHERRY_TWO_PAYOUT = 3;

export interface SlotSpin {
  /** The three stop indices into {@link SLOT_REEL} (drives the reel animation). */
  stops: [number, number, number];
  /** The symbols showing on the payline. */
  reels: [SlotSymbol, SlotSymbol, SlotSymbol];
}

/** Spin three reels from an injected rng (one draw per reel). */
export function spinSlots(rng: () => number): SlotSpin {
  const stop = (): number => Math.floor(clamp(rng(), 0, 0.9999999) * SLOT_REEL.length);
  const a = stop();
  const b = stop();
  const c = stop();
  return {
    stops: [a, b, c],
    reels: [SLOT_REEL[a]!, SLOT_REEL[b]!, SLOT_REEL[c]!],
  };
}

export interface SlotResult {
  /** Gross return-for-one (0 = loss). Credited payout = `multiplier * bet`. */
  multiplier: number;
  /** A short label for the win line, or null for a loss. */
  line: string | null;
}

/** Evaluate a spun payline. */
export function slotResult(reels: [SlotSymbol, SlotSymbol, SlotSymbol]): SlotResult {
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    return { multiplier: SLOT_TRIPLE_PAYOUT[reels[0]], line: `Triple ${SLOT_SYMBOL_LABELS[reels[0]]}` };
  }
  const cherries = reels.filter((s) => s === 'cherry').length;
  if (cherries === 2) return { multiplier: SLOT_CHERRY_TWO_PAYOUT, line: 'Two Cherries' };
  return { multiplier: 0, line: null };
}

// --- Roulette (European single-zero) ----------------------------------------

/** The red pockets on a European wheel; every other 1–36 pocket is black, 0 green. */
export const ROULETTE_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export type RouletteColor = 'red' | 'black' | 'green';

export function rouletteColor(n: number): RouletteColor {
  if (n === 0) return 'green';
  return ROULETTE_RED.has(n) ? 'red' : 'black';
}

/** The kinds of bet a player can place on the table. */
export const RouletteBetKindSchema = z.enum([
  'straight', // a single number 0..36 (value = the number) — 35:1
  'red',
  'black',
  'even',
  'odd',
  'low', // 1..18
  'high', // 19..36
  'dozen', // value 1|2|3 — 2:1
  'column', // value 1|2|3 — 2:1
]);
export type RouletteBetKind = z.infer<typeof RouletteBetKindSchema>;

export const RouletteBetSchema = z.object({
  kind: RouletteBetKindSchema,
  /** Straight: the number 0..36. Dozen/column: which one (1|2|3). Ignored otherwise. */
  value: z.number().int().min(0).max(36).default(0),
  stake: z.number().int().positive(),
});
export type RouletteBet = z.infer<typeof RouletteBetSchema>;

/** Net odds-to-one for a winning bet of each kind (gross return = stake*(odds+1)). */
export const ROULETTE_ODDS: Record<RouletteBetKind, number> = {
  straight: 35,
  red: 1,
  black: 1,
  even: 1,
  odd: 1,
  low: 1,
  high: 1,
  dozen: 2,
  column: 2,
};

/** Whether a bet wins against a spun number. The green 0 loses every outside bet. */
export function rouletteBetWins(bet: RouletteBet, n: number): boolean {
  switch (bet.kind) {
    case 'straight':
      return n === bet.value;
    case 'red':
      return rouletteColor(n) === 'red';
    case 'black':
      return rouletteColor(n) === 'black';
    case 'even':
      return n !== 0 && n % 2 === 0;
    case 'odd':
      return n % 2 === 1;
    case 'low':
      return n >= 1 && n <= 18;
    case 'high':
      return n >= 19 && n <= 36;
    case 'dozen':
      return n >= 1 && n <= 36 && Math.ceil(n / 12) === bet.value;
    case 'column':
      return n >= 1 && n <= 36 && ((n - 1) % 3) + 1 === bet.value;
    default:
      return false;
  }
}

/** Gross return for one bet against a result (0 if it loses; stake included if it wins). */
export function rouletteBetPayout(bet: RouletteBet, n: number): number {
  return rouletteBetWins(bet, n) ? bet.stake * (ROULETTE_ODDS[bet.kind] + 1) : 0;
}

/** Spin the wheel: a pocket 0..36 from an injected rng. */
export function spinRoulette(rng: () => number): number {
  return Math.floor(clamp(rng(), 0, 0.9999999) * 37);
}

// --- Bet validation (server re-checks; pure + shared) -----------------------

export interface BetLimits {
  minBet: number;
  maxBet: number;
  dailyLimit: number;
}

/**
 * Resolve a world's effective limits: per-world overrides clamped to the global
 * floors/ceilings in {@link GAMBLING}. `config` is `World.gamblingConfig`.
 */
export function resolveBetLimits(config?: { maxBet?: number; dailyWagerLimit?: number } | null): BetLimits {
  const maxBet = clampInt(
    config?.maxBet ?? GAMBLING.DEFAULT_MAX_BET,
    GAMBLING.MIN_BET,
    GAMBLING.ABSOLUTE_MAX_BET,
  );
  const dailyLimit = clampInt(
    config?.dailyWagerLimit ?? GAMBLING.DEFAULT_DAILY_WAGER_LIMIT,
    maxBet,
    GAMBLING.ABSOLUTE_MAX_DAILY_WAGER,
  );
  return { minBet: GAMBLING.MIN_BET, maxBet, dailyLimit };
}

export interface BetCheck {
  ok: boolean;
  reason?: string;
}

/** Validate a single stake against the per-bet + per-day caps. */
export function validateBet(stake: number, wageredToday: number, limits: BetLimits): BetCheck {
  if (!Number.isInteger(stake) || stake < limits.minBet) {
    return { ok: false, reason: `Minimum bet is ◈ ${limits.minBet}.` };
  }
  if (stake > limits.maxBet) {
    return { ok: false, reason: `Maximum bet is ◈ ${limits.maxBet}.` };
  }
  if (wageredToday + stake > limits.dailyLimit) {
    return { ok: false, reason: `Daily wager limit of ◈ ${limits.dailyLimit} reached. Come back tomorrow.` };
  }
  return { ok: true };
}

// --- helpers ----------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.round(clamp(v, lo, hi));
}
