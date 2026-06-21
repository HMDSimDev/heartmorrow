/**
 * Project-wide constants shared between the server and web client.
 */

/** Minimum allowed character age. Characters under this are rejected at validation time. */
export const MIN_CHARACTER_AGE = 18;

/** The default single-player profile id. This app models one player. */
export const DEFAULT_PLAYER_ID = 'player-default';

/** Starting money for a fresh player profile. Zero by design — money is something
 *  you EARN (work shifts, minigames, wealth-system yield), never handed out. */
export const DEFAULT_STARTING_MONEY = 0;

/** Prompt-builder budget approximations (rough char-based, not real tokens). */
export const PROMPT_LIMITS = {
  /** Max recent messages included verbatim in a prompt. */
  recentMessages: 16,
  /** Max memories included, selected by importance + recency. */
  topMemories: 10,
  /** Approximate character budget for the assembled context (soft cap). */
  approxCharBudget: 12_000,
  /** Trigger a rolling summary once a session exceeds this many messages. */
  summarizeEveryMessages: 24,
  /** Soft char cap for the cross-date chronicle injected into prompts. Kept at
   * or above the chronicle's hard ceiling so a complete narrative is never
   * re-truncated mid-sentence when fed back into a prompt. */
  chronicleChars: 5000,
} as const;

/** Fold the chronicle (compress recent date-lines into the narrative) every N dates. */
export const CHRONICLE_FOLD_EVERY = 5;

/** Bounds applied to LLM-proposed relationship deltas before the server clamps stats. */
export const MAX_EVAL_DELTA = 15;

/** Default guardedness (0..100) for a character — how slow they are to warm up on
 *  a date. Mild by default; reserved/guarded characters are authored higher. */
export const GUARDEDNESS_DEFAULT = 30;

/**
 * Image MIME types accepted for asset uploads.
 *
 * Deliberately limited to PNG and JPEG — the universally vision-model-safe set.
 * Uploaded portraits and chat photos are base64-encoded and sent to the
 * configured (OpenAI-compatible) vision model, and many such models reject
 * webp / gif / avif outright. Keeping the allow-list to the two formats every
 * vision model accepts turns "silent unsupported-image failure at request time"
 * into a clear up-front rejection. The web client derives both its file-picker
 * filter ({@link IMAGE_UPLOAD_ACCEPT}) and its guard from this same list, so the
 * picker, the client guard, and the server validation all stay in lockstep.
 */
export const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'] as const;
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/** `accept` attribute value for vision-bound image-upload `<input type="file">`
 *  elements. Derived from {@link ALLOWED_IMAGE_MIME_TYPES} so the browser file
 *  picker only offers formats the server (and the vision model) will accept. */
export const IMAGE_UPLOAD_ACCEPT = ALLOWED_IMAGE_MIME_TYPES.join(',');

/** Human-readable list of accepted image formats, for UI error messages
 *  (e.g. "PNG or JPEG"). Auto-tracks {@link ALLOWED_IMAGE_MIME_TYPES}. */
export const ALLOWED_IMAGE_LABEL = ALLOWED_IMAGE_MIME_TYPES
  .map((m) => m.replace('image/', '').toUpperCase())
  .join(' or ');

/** Max upload size in bytes (8 MiB). */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

// --- Time / stamina (per-world game clock) ----------------------------------

/** Daily action budget. A date or a minigame play each cost 1 stamina. */
export const DEFAULT_STAMINA_MAX = 3;
export const ACTION_STAMINA_COST = 1;

/** In-world days a character can go unseen before neglect decay begins (~2 weeks). */
export const NEGLECT_GRACE_DAYS = 14;
/** Per-day relationship decay once a character has been neglected past the grace window. */
export const NEGLECT_DAILY_DECAY = { affection: -1, comfort: -1, chemistry: -1, tension: 1 } as const;

/** Relationship-flag key that stamps the world-day a character was last seen. */
export const LAST_SEEN_FLAG = 'lastSeenDay';
/** Relationship-flag key for the world-day of the last IN-PERSON meeting (date /
 *  activity / minigame). The date greeting reads THIS, not lastSeen, so heavy texting
 *  — which resets lastSeen to keep the neglect clock warm — can't suppress the
 *  "it's been a while since we spent time together" beat. */
export const LAST_DATE_FLAG = 'lastDateDay';

// --- Phone (Messages / Email) -----------------------------------------------

/** Max length of a player-sent text. */
export const TEXT_MAX_LEN = 1000;
/** Max length of a character's text bubble. */
export const TEXT_BUBBLE_MAX = 280;
/** Max daily texts a single character may send. */
export const DAILY_TEXTS_MAX = 3;
/** Days unseen before a character's daily text turns "forlorn" (missing you). */
export const FORLORN_NEGLECT_DAYS = 4;
/** Item rarities a character is allowed to gift via a text attachment. */
export const GIFTABLE_RARITIES = ['common', 'uncommon'] as const;

// --- Text / email / gift cadence (server-decided, deterministic per day) ----

/** Per-dated-character daily chance of sending ONE text. Most days: no text. */
export const DAILY_TEXT_CHANCE = 0.4;
/** Lower daily text chance for a long-neglected character (>= FORLORN_NEGLECT_DAYS unseen). */
export const FORLORN_TEXT_CHANCE = 0.25;
/** A daily text is scheduled to ONE of these phases — never the afternoon. */
export const DAILY_TEXT_PHASES = ['morning', 'evening', 'night'] as const;

/** Chance that ANY in-world emails arrive on a given day. Most days: none. */
export const EMAIL_DAY_CHANCE = 0.25;
/** Cap on emails generated on a day that does have them. */
export const EMAILS_MAX_PER_DAY = 2;

/** Gift-attachment chance at MAX warmth (sweethearts), on a day a text is sent. Very rare. */
export const GIFT_BASE_CHANCE = 0.04;
/** Below this relationship warmth, a character NEVER gifts (poor/new relationships). */
export const GIFT_MIN_WARMTH = 25;
/** Warmth at/above which the full GIFT_BASE_CHANCE applies. */
export const GIFT_WARMTH_FULL = 82;

// --- Faces (the in-world social feed) cadence -------------------------------

/** Per-character daily chance of an ambient "life" post — EVERY character in the
 *  world can post (not just the ones you've dated), so the feed feels populated. */
export const FEED_AMBIENT_CHANCE = 0.22;
/** Cap on ambient (non-event) NPC posts generated per world per day. */
export const FEED_AMBIENT_MAX_PER_DAY = 5;
/** Max NPCs who comment on a single player post (chosen by warmth + relevance). */
export const FEED_COMMENTERS_MAX = 3;
/** Max OTHER characters who comment on a single NPC's post (friends/exes/rivals
 *  reacting to each other's posts — see FEED_NPC_COMMENT_CHANCE). */
export const FEED_NPC_COMMENTERS_MAX = 2;
/** Cap on event-driven NPC posts (jealousy/breakup/reconcile/milestone) authored
 *  per world per day — bounds the day-start LLM fan-out on a busy day. */
export const FEED_EVENT_POSTS_MAX_PER_DAY = 8;
/** Cap on how many of a day's NPC posts receive NPC↔NPC engagement (comments +
 *  reactions) — bounds the worst-case comment fan-out per day-advance. */
export const FEED_NPC_ENGAGE_POSTS_MAX = 12;
/** Chance an engaged character reacts (likes) a fresh player post, at full warmth. */
export const FEED_REACT_BASE_CHANCE = 0.5;
/** Below this relationship warmth, a character won't comment on / react to the feed. */
export const FEED_MIN_WARMTH = 15;

/** Per-dated-character daily chance of texting the player a bit of neighborhood
 *  gossip drawn from the world-sim knowledge graph (the phone echo of the dialogue
 *  "what you've heard lately" surface). Capped to one such text per world per day. */
export const KNOWLEDGE_GOSSIP_CHANCE = 0.35;
/** A character won't pass on knowledge garbled below this fidelity (0–100). */
export const KNOWLEDGE_GOSSIP_MIN_FIDELITY = 40;
/** Max knowledge-gossip texts queued per world per day (keeps the chatter low-key). */
export const KNOWLEDGE_GOSSIP_MAX_PER_DAY = 1;

/**
 * Word-about-the-player tuning. When you're seeing someone, that partner carries
 * first-hand knowledge of you (extracted from your dates); these gate how readily
 * it travels their social web and how it surfaces when you meet someone who's only
 * "heard of you". Distinct from neighborhood gossip so your dating life staying
 * semi-private is a deliberate, tunable thing.
 */
export const PLAYER_GOSSIP = {
  /** Per-meeting chance the partner brings YOU up to a friend they run into (seeds
   *  a secondhand player-fact on that friend). Modest so it spreads over days, not all at once. */
  shareProb: 0.4,
  /** Fidelity lost per hop as word about you travels (mirrors world-sim gossip decay). */
  fidelityDecay: 22,
  /** A character won't pass on / surface word about you once it's garbled below this. */
  minFidelity: 35,
  /** Max distinct things-about-you one character can hold (keeps a single NPC from reciting a dossier). */
  maxHeardPerCharacter: 3,
  /** Lifetime cap of first-hand player-facts one partner extracts (anti-grind). */
  maxFactsPerPartner: 8,
  /** Max player-facts extracted from a single date. */
  maxFactsPerDate: 3,
} as const;

// --- Wealth: property ownership + the stock market --------------------------

/**
 * Tunables for the wealth-management systems (property + stocks). The LLM-generation
 * BOUNDS live separately in schemas/llm.ts (PROPERTY_GEN / STOCK_GEN); these are the
 * runtime gameplay/math constants shared by the deterministic price walk, the
 * rented-vs-owned date buff, and net-worth aggregation in wealth.ts.
 */
export const WEALTH = {
  /** Fraction of an owned property's full date-buff granted while you LEASE it
   *  (owning is the premium tier — see {@link propertyDateBuff}). */
  RENTED_BUFF_FRACTION: 0.5,
  /** Days of grace after rent goes overdue before the landlord evicts you. */
  RENT_GRACE_DAYS: 3,
  /** A stock price floor — a company never trades below this (and never hits 0). */
  STOCK_MIN_PRICE: 1,
  /** Safety ceiling the price-walk math clamps volatility to (above the generation
   *  cap so a hand-authored company can be a little wilder, but never absurd). */
  STOCK_MAX_VOLATILITY: 0.25,
  /** Max single-day event SHOCK (fraction) a world happening can add to a stock on
   *  top of its random walk — keeps "reacts to the world" bounded + non-explosive. */
  STOCK_EVENT_SHOCK_MAX: 0.12,
  /** Dividend-per-share cap as a fraction of base price (anti-money-printer: a
   *  holding can never out-earn its cost). Mirrored by STOCK_GEN. */
  MAX_DIVIDEND_YIELD: 0.02,
} as const;

// --- Gambling: the casino Phone app -----------------------------------------

/**
 * Tunables for the casino (slots / blackjack / roulette / video poker), behind
 * the per-world `gambling` feature flag. The pure payout + odds math lives in
 * `gambling.ts`; the server `gambling-service` is the money authority and
 * enforces these caps. The RNG is INJECTED (Math.random live, a stub in tests),
 * so none of these are randomness params.
 *
 * Design intent: gambling is FLAVOR and risk, never a wealth engine. The per-bet
 * cap is FLAT — it never scales with how rich you are — and the per-day cap
 * bounds a session, so a hot streak can't be farmed and the realistic house
 * edge grinds you down over time. Per-world overrides (`World.gamblingConfig`)
 * are clamped to the floors/ceilings here.
 */
export const GAMBLING = {
  /** Smallest stake allowed on any game. */
  MIN_BET: 5,
  /** Default per-bet cap (a few days' active income). World-overridable. */
  DEFAULT_MAX_BET: 250,
  /** Hard ceiling a creator may raise the per-bet cap to. */
  ABSOLUTE_MAX_BET: 1_000,
  /** Default cap on total money WAGERED per in-world day (a strong week's income). */
  DEFAULT_DAILY_WAGER_LIMIT: 1_500,
  /** Hard ceiling a creator may raise the per-day wager cap to. */
  ABSOLUTE_MAX_DAILY_WAGER: 10_000,
  /** Blackjack pays 3:2 on a natural (numerator/denominator of the bonus). */
  BLACKJACK_NUMERATOR: 3,
  BLACKJACK_DENOMINATOR: 2,
} as const;

// --- Career / job skills ----------------------------------------------------

/**
 * Tunables for the work-system's per-world job mastery (see `career.ts`). A job
 * grants XP to its skill; the skill level scales that job's pay via masteryMult.
 * Progression is deliberately FLAT-capped (never scales with wealth) so leveling
 * speeds the grind but can't runaway-inflate — the 3-action stamina budget stays
 * the real throttle, and `ABSOLUTE_MAX_PAY` caps any single shift.
 */
export const CAREER = {
  /** Highest level any skill can reach. */
  MAX_LEVEL: 5,
  /** Pay multiplier per level: 1 + STEP·level (L0 = 1.0 … L5 = 1.75). */
  MASTERY_STEP: 0.15,
  /** Base of the cumulative XP curve: xpToReach(L) = XP_BASE·L·(L+1)/2 (L1=100 … L5=1500). */
  XP_BASE: 100,
  /** Flat, wealth-independent ceiling on any single work shift's pay (post-mastery). */
  ABSOLUTE_MAX_PAY: 250,
} as const;

// --- Availability (Do Not Disturb) ------------------------------------------

/** Per-day chance a given character is unavailable (busy) and can't be dated/texted. */
export const UNAVAILABLE_CHANCE = 0.28;

/** Lore-flavored reasons a character is unavailable on a given day. */
export const AVAILABILITY_REASONS = [
  'is buried in work today',
  'is out of town until tomorrow',
  'needs some time alone to recharge',
  'is tied up with family business',
  'is feeling under the weather',
  'has a packed schedule today',
  'is off the grid, dealing with something personal',
  'asked for a quiet day to themselves',
] as const;
