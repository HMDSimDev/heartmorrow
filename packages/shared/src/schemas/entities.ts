import { z } from 'zod';
import { MIN_CHARACTER_AGE, GUARDEDNESS_DEFAULT, GAMBLING } from '../constants';
import { CasinoGameSchema } from '../gambling';
import { DatingStatsSchema, RelationshipStatsSchema, RelationshipStatKeySchema } from '../stats';
import { PhaseSchema } from '../time';
import { RelationshipStyleSchema, CharacterLinkSchema, EmploymentSchema, GenderSchema, SexualitySchema } from '../social';
import { PropertyCategorySchema, StockSectorSchema, RentCadenceSchema } from '../wealth';
import { MemoryTagArraySchema } from '../vocab';
import { ItemEffectSchema, ItemRaritySchema, ItemCategorySchema } from './items';

/**
 * Persisted entity schemas. These describe the canonical shape of rows after
 * they have been read from SQLite and decoded (JSON columns parsed). Create /
 * update input shapes live in `api.ts`.
 *
 * Timestamps are epoch milliseconds (integers).
 */

export const MetadataSchema = z.record(z.string(), z.unknown());
export type Metadata = z.infer<typeof MetadataSchema>;

export const FlagsSchema = z.record(
  z.string(),
  z.union([z.boolean(), z.number(), z.string()]),
);
export type Flags = z.infer<typeof FlagsSchema>;

const id = z.string().min(1);
const ts = z.number().int().nonnegative();

// --- World ------------------------------------------------------------------

export const LocationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  /** Whether this venue is sheltered from the weather (affects outdoor-date penalties). */
  indoor: z.boolean().default(false),
  /** Cost tier of dating here: 0 free · 1 modest · 2 nice · 3 lavish. Maps to a
   *  money cost (charged per-world when a real date ends) and to how a character
   *  judges the spend. Defaults to free so existing authored venues cost nothing. */
  priceTier: z.number().int().min(0).max(3).default(0),
  /** Optional uploaded photo for this venue (an Asset id). Shown in the date
   *  location picker and the date scene. Null = use the generic placeholder. */
  imageAssetId: id.nullable().default(null),
});
export type Location = z.infer<typeof LocationSchema>;

/**
 * Which optional GAME MECHANICS a world turns on: these gate whole subsystems
 * that don't fit every setting — property ownership and the stock market. Default
 * OFF so a world opts in. The server is the authority (route handlers call
 * `requireFeature`); the client merely hides surfaces for a clean UI.
 */
export const FeatureFlagsSchema = z.object({
  /** Property ownership: buy/rent places, collect rent, date there for a buff. */
  property: z.boolean().default(false),
  /** The fictional stock market: trade shares of in-world companies. */
  stockMarket: z.boolean().default(false),
  /** The casino: wager money on slots/blackjack/roulette/video poker, behind a
   *  flat per-bet cap and a per-day wager cap so it never becomes a money engine. */
  gambling: z.boolean().default(false),
});
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;

/**
 * Per-world casino limits, set by the creator in the World editor (only meaningful
 * when `featureFlags.gambling` is on). Stored as one JSON blob on the world, like
 * {@link FeatureFlagsSchema}. The values are CAPS, deliberately flat (they never
 * scale with the player's wealth); the server clamps them to the floors/ceilings
 * in `GAMBLING` (see `resolveBetLimits`). The daily limit tracks total money
 * WAGERED in a day, not net result.
 */
export const GamblingConfigSchema = z.object({
  /** Largest single stake allowed at the table. */
  maxBet: z.number().int().positive().default(GAMBLING.DEFAULT_MAX_BET),
  /** Cap on total money wagered per in-world day. */
  dailyWagerLimit: z.number().int().positive().default(GAMBLING.DEFAULT_DAILY_WAGER_LIMIT),
});
export type GamblingConfig = z.infer<typeof GamblingConfigSchema>;

export const WorldSchema = z.object({
  id,
  name: z.string().min(1),
  summary: z.string().default(''),
  tone: z.string().default(''),
  globalNotes: z.string().default(''),
  locations: z.array(LocationSchema).default([]),
  /** Free-form rules / lore the LLM should treat as world DATA, not commands. */
  rules: z.string().default(''),
  lore: z.string().default(''),
  /** Which optional mechanics (property / stock market / gambling) this world enables. */
  featureFlags: FeatureFlagsSchema.default({}),
  /** Casino limits when `featureFlags.gambling` is on (per-bet + per-day caps). */
  gamblingConfig: GamblingConfigSchema.default({}),
  createdAt: ts,
  updatedAt: ts,
});
export type World = z.infer<typeof WorldSchema>;

export const WorldNoteScopeSchema = z.enum([
  'global',
  'location',
  'faction',
  'lore',
  'rule',
  'character',
  'misc',
]);
export type WorldNoteScope = z.infer<typeof WorldNoteScopeSchema>;

export const WorldNoteSchema = z.object({
  id,
  worldId: id,
  title: z.string().min(1),
  body: z.string().default(''),
  tags: z.array(z.string()).default([]),
  scope: WorldNoteScopeSchema.default('global'),
  importance: z.number().int().min(1).max(5).default(3),
  createdAt: ts,
  updatedAt: ts,
});
export type WorldNote = z.infer<typeof WorldNoteSchema>;

// --- Character --------------------------------------------------------------

export const CharacterSchema = z.object({
  id,
  worldId: id.nullable().default(null),
  name: z.string().min(1),
  age: z.number().int().min(MIN_CHARACTER_AGE, `Characters must be at least ${MIN_CHARACTER_AGE}.`),
  pronouns: z.string().default('they/them'),
  /** Gender, separate from pronouns — half of the attraction-compatibility pair. */
  gender: GenderSchema.default('unspecified'),
  /** Who they're oriented toward. With gender, gates whether romance can progress. */
  sexuality: SexualitySchema.default('unspecified'),
  shortDescription: z.string().default(''),
  personality: z.string().default(''),
  /** Private creator notes — included in prompts as guidance, never shown raw to players. */
  creatorNotes: z.string().default(''),
  speechStyle: z.string().default(''),
  likes: z.array(z.string()).default([]),
  dislikes: z.array(z.string()).default([]),
  boundaries: z.array(z.string()).default([]),
  goals: z.array(z.string()).default([]),
  relationshipPreferences: z.string().default(''),
  /** Whether the character is okay with you dating others. Drives jealousy. */
  relationshipStyle: RelationshipStyleSchema.default('monogamous'),
  /** How slow this character is to warm up on a date (0 = an open book, 100 = walled
   *  off). Lowers their opening rapport and dampens how fast warmth builds — guarded
   *  people have to be earned. Does NOT change how fast a bad date cools. */
  guardedness: z.number().int().min(0).max(100).default(GUARDEDNESS_DEFAULT),
  /** Directed links to other characters (friend/rival/ex/family/partner) — the social web. */
  links: z.array(CharacterLinkSchema).default([]),
  /** What this character does for work (drives NPC encounters/availability); null = unemployed. */
  employment: EmploymentSchema.nullable().default(null),
  /** Authored opt-in: may OTHER characters establish canon facts about this one by
   *  revealing them as their ex on a date? Default false = this character's truth is
   *  immutable by play (the safety gate for ex-canonization). */
  allowsExCanonization: z.boolean().default(false),
  /** Weather kinds this character loves / can't stand — colors their mood and dates. */
  favoriteWeather: z.array(z.string()).default([]),
  dislikedWeather: z.array(z.string()).default([]),
  /** LLM-generated description of this character's private room/home (their personal date venue). */
  roomDescription: z.string().default(''),
  /** Physical/appearance descriptor for the bio — lets prompts reference how they look. */
  appearance: z.string().default(''),
  /** Physical/sensory needs to feel good (rest, alone time, physical affection…). */
  physicalNeeds: z.array(z.string()).default([]),
  /** What physically/sensorially draws them in (kept tasteful). */
  physicalDesires: z.array(z.string()).default([]),
  /** Physical/sensory turn-offs. */
  physicalDislikes: z.array(z.string()).default([]),
  /** How this character writes TEXTS / feed posts — distinct from spoken `speechStyle`. */
  textingStyle: z.string().default(''),
  /** How they behave on the social feed (oversharer, lurker, cryptic poster, hype-friend…). */
  onlinePersona: z.string().default(''),
  /** Their love language (words / acts of service / gifts / touch / quality time). */
  loveLanguage: z.string().default(''),
  /** Quiet fears / insecurities — powers vulnerable & forlorn beats. */
  insecurities: z.array(z.string()).default([]),
  /** Verbal tics, catchphrases, little habits that make their voice distinct. */
  quirks: z.array(z.string()).default([]),
  datingStats: DatingStatsSchema,
  portraitAssetId: id.nullable().default(null),
  /** expression label -> asset id (e.g. { happy: "asset-1", sad: "asset-2" }). */
  expressionAssets: z.record(z.string(), z.string()).default({}),
  createdAt: ts,
  updatedAt: ts,
});
export type Character = z.infer<typeof CharacterSchema>;

export const CharacterMemorySchema = z.object({
  id,
  characterId: id,
  text: z.string().min(1),
  importance: z.number().int().min(1).max(5).default(3),
  /** Canonical memory tags only; legacy/off-list tags are dropped on read. */
  tags: MemoryTagArraySchema,
  sourceEventId: id.nullable().default(null),
  /** The OTHER person this memory is about, when it's a shared/social moment (e.g.
   *  a world-sim meeting) — lets a memory be looked up by "who it involves" and the
   *  two parties' memories of the same encounter be cross-referenced. Null otherwise. */
  relatedCharacterId: id.nullable().default(null),
  createdAt: ts,
  lastUsedAt: ts.nullable().default(null),
});
export type CharacterMemory = z.infer<typeof CharacterMemorySchema>;

// --- Relationship -----------------------------------------------------------

export const RelationshipSchema = z.object({
  id,
  characterId: id,
  playerId: id,
  affection: z.number().int().min(0).max(100),
  trust: z.number().int().min(0).max(100),
  chemistry: z.number().int().min(0).max(100),
  comfort: z.number().int().min(0).max(100),
  respect: z.number().int().min(0).max(100),
  curiosity: z.number().int().min(0).max(100),
  tension: z.number().int().min(0).max(100),
  flags: FlagsSchema.default({}),
  updatedAt: ts,
});
export type Relationship = z.infer<typeof RelationshipSchema>;

// --- Player -----------------------------------------------------------------

export const PlayerProfileSchema = z.object({
  id,
  name: z.string().min(1).default('Player'),
  pronouns: z.string().default('they/them'),
  /** Your gender — half of the attraction-compatibility pair (separate from pronouns). */
  gender: GenderSchema.default('unspecified'),
  /** Who you're oriented toward. Gates which characters a romance can deepen with. */
  sexuality: SexualitySchema.default('unspecified'),
  personaNotes: z.string().default(''),
  money: z.number().int().nonnegative().default(0),
  createdAt: ts,
  updatedAt: ts,
});
export type PlayerProfile = z.infer<typeof PlayerProfileSchema>;

// --- Asset ------------------------------------------------------------------

export const AssetTypeSchema = z.enum([
  'portrait',
  'expression',
  'background',
  'location',
  'item',
  'other',
]);
export type AssetType = z.infer<typeof AssetTypeSchema>;

export const AssetSchema = z.object({
  id,
  type: AssetTypeSchema,
  /** Path RELATIVE to the controlled uploads directory. Never an absolute path. */
  path: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  altText: z.string().default(''),
  tags: z.array(z.string()).default([]),
  metadata: MetadataSchema.default({}),
  createdAt: ts,
});
export type Asset = z.infer<typeof AssetSchema>;

// --- Conversation -----------------------------------------------------------

export const ConversationModeSchema = z.enum(['chat', 'date', 'event', 'minigame']);
export type ConversationMode = z.infer<typeof ConversationModeSchema>;

export const ConversationSessionSchema = z.object({
  id,
  characterId: id,
  locationId: id.nullable().default(null),
  mode: ConversationModeSchema.default('chat'),
  summary: z.string().default(''),
  /** Whether the session has been ended + evaluated. */
  ended: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type ConversationSession = z.infer<typeof ConversationSessionSchema>;

export const MessageRoleSchema = z.enum(['player', 'character', 'system', 'narrator']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageSchema = z.object({
  id,
  sessionId: id,
  role: MessageRoleSchema,
  text: z.string(),
  metadata: MetadataSchema.default({}),
  createdAt: ts,
});
export type Message = z.infer<typeof MessageSchema>;

// --- Shop / Inventory -------------------------------------------------------

export const ShopItemSchema = z.object({
  id,
  name: z.string().min(1),
  description: z.string().default(''),
  price: z.number().int().nonnegative(),
  category: ItemCategorySchema.default('gift'),
  rarity: ItemRaritySchema.default('common'),
  effects: z.array(ItemEffectSchema).default([]),
  infiniteStock: z.boolean().default(true),
  /** Remaining stock when not infinite. */
  stock: z.number().int().nonnegative().default(0),
  assetId: id.nullable().default(null),
  createdAt: ts,
  updatedAt: ts,
});
export type ShopItem = z.infer<typeof ShopItemSchema>;

export const InventoryItemSchema = z.object({
  id,
  playerId: id,
  shopItemId: id,
  quantity: z.number().int().nonnegative(),
  acquiredAt: ts,
});
export type InventoryItem = z.infer<typeof InventoryItemSchema>;

// --- Wealth: property ownership ---------------------------------------------

/**
 * An AUTHORED property definition the creator places in a world (like a Location,
 * but a leasable/buyable asset). Per-WORLD (unlike shop items, which are global) —
 * real estate is part of a setting. Two ways to use it: LEASE it (pay `rentAmount`
 * every `rentCadence` — date there with a partial buff, but fall behind and the
 * landlord evicts you), or BUY it (pay `buyPrice` once — no more rent, the full
 * date buff, and you own the equity). Sell value is flat = buyPrice (property is
 * the steady lane; the stock market is the volatile one).
 */
export const PropertySchema = z.object({
  id,
  worldId: id,
  name: z.string().min(1),
  description: z.string().default(''),
  category: PropertyCategorySchema.default('residence'),
  /** Cost to OWN it outright (no more rent afterward). */
  buyPrice: z.number().int().nonnegative().default(0),
  /** Recurring rent charged each `rentCadence` while you LEASE it (0 = not leasable). */
  rentAmount: z.number().int().nonnegative().default(0),
  /** How often the lease rent is charged. */
  rentCadence: RentCadenceSchema.default('weekly'),
  /** Sheltered from weather (mirrors Location.indoor) when used as a date venue. */
  indoor: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  /** Relationship stat a date here nudges; null = none. Owning grants the full
   *  `buffAmount`, leasing grants a fraction (server-owned + clamped). */
  buffStat: RelationshipStatKeySchema.nullable().default(null),
  buffAmount: z.number().int().min(0).default(0),
  assetId: id.nullable().default(null),
  createdAt: ts,
  updatedAt: ts,
});
export type Property = z.infer<typeof PropertySchema>;

/** A player's outright ownership of a property — playthrough state, per-world via
 *  the `player:${worldId}` id. The purchase price is snapshotted for an audit trail. */
export const PropertyOwnershipSchema = z.object({
  id,
  worldId: id,
  playerId: id,
  propertyId: id,
  purchasePrice: z.number().int().nonnegative(),
  acquiredAt: ts,
});
export type PropertyOwnership = z.infer<typeof PropertyOwnershipSchema>;

export const LeaseStatusSchema = z.enum(['active', 'overdue']);
export type LeaseStatus = z.infer<typeof LeaseStatusSchema>;

/**
 * A player's active LEASE on a property — playthrough state. Rent is charged each
 * cadence at day-advance: paying keeps it `active` and pushes `nextDueDay`; missing
 * it flips to `overdue` and arms `graceUntilDay`. If still unpaid past grace, the
 * lease is DELETED (eviction). Rent amount + cadence are read live from the property.
 */
export const PropertyLeaseSchema = z.object({
  id,
  worldId: id,
  playerId: id,
  propertyId: id,
  /** Next in-world day rent comes due. */
  nextDueDay: z.number().int().positive(),
  status: LeaseStatusSchema.default('active'),
  /** When overdue, the day eviction happens if still unpaid. Null while current. */
  graceUntilDay: z.number().int().positive().nullable().default(null),
  startedAt: ts,
});
export type PropertyLease = z.infer<typeof PropertyLeaseSchema>;

/**
 * An urgent message from a property's landlord about overdue rent or an eviction.
 * Surfaced as a pinned, distinctly-styled "Property Management" conversation in the
 * phone Messages app (it is NOT a dateable character, so it lives apart from the
 * character-keyed text threads). Written deterministically by the server, never the LLM.
 */
export const LandlordNoticeKindSchema = z.enum(['overdue', 'eviction']);
export type LandlordNoticeKind = z.infer<typeof LandlordNoticeKindSchema>;

export const LandlordNoticeSchema = z.object({
  id,
  worldId: id,
  playerId: id,
  propertyId: id,
  kind: LandlordNoticeKindSchema,
  body: z.string().min(1),
  dayNumber: z.number().int().nonnegative().default(0),
  read: z.boolean().default(false),
  createdAt: ts,
});
export type LandlordNotice = z.infer<typeof LandlordNoticeSchema>;

// --- Wealth: the stock market -----------------------------------------------

/**
 * An AUTHORED fictional company the creator places in a world's stock market.
 * Per-world. Players buy/sell shares; the price moves each in-world day via a
 * deterministic walk seeded from (world, day, company) plus optional event shocks
 * tied to `linkedCharacterId` (a company associated with a character reacts to
 * that character's news). Optionally pays `dividendPerShare` daily (capped to a
 * small yield server-side).
 */
export const CompanySchema = z.object({
  id,
  worldId: id,
  name: z.string().min(1),
  /** Short market ticker (A–Z, 1–5 chars; normalized server-side). */
  ticker: z.string().min(1).max(5),
  description: z.string().default(''),
  sector: StockSectorSchema.default('tech'),
  /** Starting / anchor share price (day-1 price before any walk). */
  basePrice: z.number().int().positive().default(100),
  /** Daily swing magnitude (±fraction); higher = wilder. */
  volatility: z.number().min(0).default(0.04),
  /** Income per share per day while held (0 = no dividend). */
  dividendPerShare: z.number().int().nonnegative().default(0),
  /** Optional character this company is tied to — their good/bad news shocks the
   *  stock ("based on the world"). Null = a pure market ticker. */
  linkedCharacterId: id.nullable().default(null),
  assetId: id.nullable().default(null),
  createdAt: ts,
  updatedAt: ts,
});
export type Company = z.infer<typeof CompanySchema>;

/** A player's holding in a company — playthrough state, per-world. `costBasis` is
 *  the total spent (for P/L); the live value is always re-derived from the current
 *  day's price, never snapshotted here. */
export const StockHoldingSchema = z.object({
  id,
  worldId: id,
  playerId: id,
  companyId: id,
  shares: z.number().int().nonnegative().default(0),
  costBasis: z.number().int().nonnegative().default(0),
  /** In-world day the shares were last acquired — dividends only pay once a holding
   *  has been held across a full day, so you can't buy-before-Sleep to collect free. */
  acquiredDay: z.number().int().nonnegative().default(0),
  updatedAt: ts,
});
export type StockHolding = z.infer<typeof StockHoldingSchema>;

/** A company's resolved share price on one in-world day — DERIVED, deterministic
 *  state stored per (world, company, day) so it survives restart and never jumps
 *  when switching worlds. Composite key keeps the day-advance walk idempotent. */
export const StockPriceSchema = z.object({
  worldId: id,
  companyId: id,
  day: z.number().int().positive(),
  price: z.number().int().positive(),
  createdAt: ts,
});
export type StockPrice = z.infer<typeof StockPriceSchema>;

/** A market-news headline written by the LLM to explain a day's price move
 *  (flavor only; prices are computed deterministically). Per (world, day). */
export const MarketNewsSchema = z.object({
  id,
  worldId: id,
  day: z.number().int().positive(),
  companyId: id.nullable().default(null),
  ticker: z.string().default(''),
  headline: z.string().min(1),
  body: z.string().default(''),
  /** Sign of the move this headline accompanies (derived from the price, not the LLM). */
  sentiment: z.enum(['up', 'down', 'flat']).default('flat'),
  createdAt: ts,
});
export type MarketNews = z.infer<typeof MarketNewsSchema>;

// --- Gambling ---------------------------------------------------------------

/**
 * One play at the casino — playthrough state, per-world. Serves THREE roles:
 *  1. in-flight state for interactive games (blackjack / video poker) so a hand
 *     survives a refresh and resumes (like an active date), held in `state` JSON;
 *  2. the settled-bet history log (slots / roulette resolve in one step);
 *  3. the per-day wager-cap ledger — today's wagered total is SUM(bet) over the
 *     player's rounds keyed on the in-world `day`, so the cap resets for free at
 *     day rollover with no clock-service change.
 *
 * `bet` is the TOTAL staked on the round (grows when a blackjack hand doubles).
 * `payout` is the gross amount returned to the wallet when it settles.
 */
export const GamblingRoundSchema = z.object({
  id,
  worldId: id,
  playerId: id,
  game: CasinoGameSchema,
  /** active = an unresolved interactive hand; settled = resolved & paid out. */
  status: z.enum(['active', 'settled']).default('settled'),
  /** Total wagered on this round (counts toward the daily cap). */
  bet: z.number().int().nonnegative().default(0),
  /** Gross return paid to the wallet on settle (0 = lost the stake). */
  payout: z.number().int().nonnegative().default(0),
  /** Short result tag for history (e.g. 'win', 'lose', 'push', 'blackjack'). */
  outcome: z.string().default(''),
  /** Game-specific state machine + result (cards, reels, wheel number, …). */
  state: MetadataSchema.default({}),
  /** The in-world day this round was played on (keys the daily wager cap). */
  day: z.number().int().positive().default(1),
  createdAt: ts,
  updatedAt: ts,
});
export type GamblingRound = z.infer<typeof GamblingRoundSchema>;

// --- Events -----------------------------------------------------------------

export const GameEventSchema = z.object({
  id,
  type: z.string().min(1),
  /** The world this event belongs to, when it can be resolved. Null for genuinely
   *  world-less events (data import, full reset) and legacy pre-migration rows.
   *  Stamped at write time (event-service) so per-world reads never mix worlds. */
  worldId: id.nullable().default(null),
  payload: MetadataSchema.default({}),
  createdAt: ts,
});
export type GameEvent = z.infer<typeof GameEventSchema>;

// --- World game state (per-world playthrough clock) -------------------------

export const WorldStateSchema = z.object({
  worldId: id,
  /** Current in-world day, starting at 1. */
  day: z.number().int().min(1).default(1),
  phase: PhaseSchema.default('morning'),
  /** Remaining action stamina for today. */
  stamina: z.number().int().min(0).default(3),
  staminaMax: z.number().int().min(1).default(3),
  actionsToday: z.number().int().min(0).default(0),
  /** Last day a recap was produced (re-entrancy guard). */
  lastRecapDay: z.number().int().min(0).default(0),
  /** Last day the NPC world-sim ran for this world — durable, eviction-proof
   *  idempotency guard so re-running a day's sim is a zero-LLM no-op. */
  lastWorldSimDay: z.number().int().min(0).default(0),
  /** Last day rent income was collected for this world (idempotency: re-advancing a
   *  day never double-credits rent). */
  lastRentCalculatedDay: z.number().int().min(0).default(0),
  /** Last day stock prices were rolled forward + dividends paid for this world
   *  (idempotency guard, like lastRentCalculatedDay). */
  lastStockCalculatedDay: z.number().int().min(0).default(0),
  /** Epoch ms marking when the current in-world day began (windows the recap). */
  dayStartedAt: ts,
  createdAt: ts,
  updatedAt: ts,
});
export type WorldState = z.infer<typeof WorldStateSchema>;

// --- World simulation (DERIVED NPC life — never authored, wiped by reset) ----

/**
 * An undirected NPC↔NPC relationship edge minted by the world-sim. Canonical
 * order: aId < bId. Lives APART from authored `Character.links` so simulated
 * acquaintances never scribble on authored truth (and so a full-row character
 * update can't lose them to a race). Merged into the social graph only at read
 * time.
 */
export const NpcEdgeSchema = z.object({
  worldId: id,
  aId: id,
  bId: id,
  warmth: z.number().int().default(0),
  meetCount: z.number().int().min(0).default(0),
  /** Last in-world day this edge was touched — guards idempotent warmth SETs. */
  lastDay: z.number().int().min(0).default(0),
  /** True once a friend edge has been minted from sustained meetings. */
  promoted: z.boolean().default(false),
});
export type NpcEdge = z.infer<typeof NpcEdgeSchema>;

/** A piece of "news" an NPC carries — who knows what about whom, and how garbled
 *  it got as it propagated (fidelity drops, hops rise, with each retelling). */
export const NpcKnowledgeSchema = z.object({
  id,
  worldId: id,
  knowerId: id,
  /** Who/what it's about — a character id, or the player id, or null (ambient). */
  subjectId: id.nullable().default(null),
  topic: z.string(),
  claim: z.string(),
  fidelity: z.number().int().min(0).max(100).default(100),
  hops: z.number().int().min(0).default(0),
  sourceEventId: id.nullable().default(null),
  /** If derived from a canon fact, links back so a rejection can cascade. */
  sourceCanonId: id.nullable().default(null),
  /** Who told THIS knower the claim (the immediate teller), so a surfaced rumor can
   *  be attributed ("your friend Mara mentioned…"). Null for first-hand knowledge
   *  (learned directly, e.g. a date partner's own read of the player). Updated to the
   *  passer on each gossip hop. */
  sourceKnowerId: id.nullable().default(null),
  day: z.number().int().min(0).default(0),
  createdAt: ts,
});
export type NpcKnowledge = z.infer<typeof NpcKnowledgeSchema>;

/** Restricted to the lowest-corruption surfaces — deliberately NO belief /
 *  personality / history (those would let dialogue rewrite who someone IS). */
export const CanonFactCategorySchema = z.enum(['habit', 'hobby', 'job', 'appearance']);
export type CanonFactCategory = z.infer<typeof CanonFactCategorySchema>;

export const CanonFactStatusSchema = z.enum(['active', 'shadow', 'rejected']);
export type CanonFactStatus = z.infer<typeof CanonFactStatusSchema>;

/**
 * A fact an NPC revealed about their EX during a date — derived canon about the
 * subject. Gated by the ex's authored `allowsExCanonization` and written ONLY
 * here, never onto the authored character row. Append-only + reversible (status
 * 'rejected'); contradictions are parked as 'shadow' rather than overwriting.
 */
export const CanonFactSchema = z.object({
  id,
  worldId: id,
  /** The character this fact is ABOUT (the ex). */
  subjectId: id,
  category: CanonFactCategorySchema,
  value: z.string(),
  sensitivity: z.enum(['neutral', 'touchy']).default('neutral'),
  sourceSessionId: id.nullable().default(null),
  sourceEventId: id.nullable().default(null),
  /** Who SAID it — must be a character, never the player (enforced server-side). */
  sourceCharId: id.nullable().default(null),
  day: z.number().int().min(0).default(0),
  status: CanonFactStatusSchema.default('active'),
  createdAt: ts,
});
export type CanonFact = z.infer<typeof CanonFactSchema>;

// --- Phone: message threads + texts -----------------------------------------

export const MessageThreadSchema = z.object({
  id,
  characterId: id,
  playerId: id,
  lastMessageAt: ts.nullable().default(null),
  unreadCount: z.number().int().nonnegative().default(0),
  createdAt: ts,
  updatedAt: ts,
});
export type MessageThread = z.infer<typeof MessageThreadSchema>;

export const TextSenderSchema = z.enum(['character', 'player']);
export type TextSender = z.infer<typeof TextSenderSchema>;

export const TextStatusSchema = z.enum(['queued', 'delivered']);
export type TextStatus = z.infer<typeof TextStatusSchema>;

/** A gift a character can attach to a text. The item is granted only when claimed. */
export const TextAttachmentSchema = z.object({
  shopItemId: id,
  name: z.string(),
  claimed: z.boolean().default(false),
});
export type TextAttachment = z.infer<typeof TextAttachmentSchema>;

export const TextMessageSchema = z.object({
  id,
  threadId: id,
  sender: TextSenderSchema,
  body: z.string().default(''),
  status: TextStatusSchema.default('delivered'),
  /** World-day this text belongs to (for queued daily texts). */
  dayNumber: z.number().int().nullable().default(null),
  /** Time-of-day phase this queued text should be delivered in. */
  scheduledPhase: PhaseSchema.nullable().default(null),
  attachment: TextAttachmentSchema.nullable().default(null),
  /** A photo the player attached, as an uploaded asset id. The browser downscales
   *  it (max ~512px tall) before upload, so a vision model reads a small, fast image. */
  imageAssetId: id.nullable().default(null),
  deliveredAt: ts.nullable().default(null),
  createdAt: ts,
});
export type TextMessage = z.infer<typeof TextMessageSchema>;

// --- Phone: emails (in-world, never from characters) ------------------------

// --- Cross-date chronicle (folded history fed into prompts) -----------------

export const ChronicleLineSchema = z.object({
  day: z.number().int(),
  mode: ConversationModeSchema,
  // Holds the evaluator's summaryLine verbatim — keep in sync with
  // SessionEvaluationSchema.summaryLine (llm.ts) and the slice in chronicle-service.
  line: z.string().max(600),
});
export type ChronicleLine = z.infer<typeof ChronicleLineSchema>;

export const CharacterChronicleSchema = z.object({
  characterId: id,
  playerId: id,
  /** The folded narrative of your history together. */
  chronicle: z.string().default(''),
  /** Recent date highlights not yet folded into the narrative. */
  recentLines: z.array(ChronicleLineSchema).default([]),
  sessionCount: z.number().int().nonnegative().default(0),
  updatedAt: ts,
});
export type CharacterChronicle = z.infer<typeof CharacterChronicleSchema>;

// --- Endings (the relationship "happy ending" — a soft win, not a game-over) ---

export const CharacterEndingSchema = z.object({
  characterId: id,
  playerId: id,
  /** Short headline for the ending (e.g. "A Life in the Glasshouse"). */
  title: z.string().min(1),
  /** The LLM-written, forward-looking epilogue of your story together. */
  epilogue: z.string().min(1),
  /** In-world day the ending was reached. */
  day: z.number().int().nonnegative().default(0),
  createdAt: ts,
});
export type CharacterEnding = z.infer<typeof CharacterEndingSchema>;

// --- Day records (the almanac: one persisted summary per world-day) ----------

/** A single "what happened" line on a day, with an emoji + good/bad/neutral tone
 *  for the Calendar app's colored rails. Derived server-side from the day's events
 *  (the player-facing beats) and the world-sim ("around town"). */
export const DayRecordBeatSchema = z.object({
  icon: z.string().max(8).default('•'),
  text: z.string().min(1).max(280),
  tone: z.enum(['good', 'bad', 'neutral']).default('neutral'),
});
export type DayRecordBeat = z.infer<typeof DayRecordBeatSchema>;

/**
 * A persisted end-of-day record — the canonical history the Calendar app reads.
 * Written going-forward by the clock when a day ends (the live LLM recap), and
 * lazily BACKFILLED for days that elapsed before this feature shipped (those carry
 * `reconstructed: true` and a synthesized narrative built from the day's events).
 * Weather / day-of-week / season / holiday are NOT stored — they are pure functions
 * of (worldId, day) and recomputed on read.
 */
export const DayRecordSchema = z.object({
  worldId: id,
  day: z.number().int().positive(),
  headline: z.string().default(''),
  narrative: z.string().default(''),
  highlights: z.array(z.string().max(280)).default([]),
  beats: z.array(DayRecordBeatSchema).default([]),
  /** Passive daily income credited as this day began. */
  income: z.number().int().nonnegative().default(0),
  /** True when the row was reconstructed from events rather than written live. */
  reconstructed: z.boolean().default(false),
  createdAt: ts,
  updatedAt: ts,
});
export type DayRecord = z.infer<typeof DayRecordSchema>;

export const EmailSchema = z.object({
  id,
  playerId: id,
  /** The world this in-world email belongs to (null for legacy/un-scoped rows). */
  worldId: id.nullable().default(null),
  senderName: z.string().min(1),
  senderHandle: z.string().min(1),
  subject: z.string().default(''),
  body: z.string().default(''),
  status: TextStatusSchema.default('delivered'),
  read: z.boolean().default(false),
  dayNumber: z.number().int().nullable().default(null),
  scheduledPhase: PhaseSchema.nullable().default(null),
  deliveredAt: ts.nullable().default(null),
  createdAt: ts,
});
export type Email = z.infer<typeof EmailSchema>;

// --- Faces: the in-world social feed (posts, comments, reactions) -----------

/** Who authored a feed post / comment / reaction. */
export const FeedAuthorTypeSchema = z.enum(['player', 'character']);
export type FeedAuthorType = z.infer<typeof FeedAuthorTypeSchema>;

/**
 * What prompted a post. `status` is player-authored; the rest are NPC-authored
 * and generated server-side (event-driven or ambient). Drives the post's accent
 * + how it reads.
 */
export const FeedPostKindSchema = z.enum([
  'status', // player status update
  'life', // NPC ambient post about their day / the world (weather, mood, needs)
  'jealousy', // NPC found out you've been seeing someone else (forlorn / hurt)
  'milestone', // NPC reacting to a milestone / new commitment in their circle
  'breakup', // NPC posting after a breakup
  'reconcile', // NPC posting after reconciling
]);
export type FeedPostKind = z.infer<typeof FeedPostKindSchema>;

/** Facebook-style reactions a post can receive. */
export const ReactionKindSchema = z.enum(['like', 'love', 'laugh', 'wow', 'sad', 'angry']);
export type ReactionKind = z.infer<typeof ReactionKindSchema>;

export const FeedPostSchema = z.object({
  id,
  worldId: id,
  authorType: FeedAuthorTypeSchema,
  /** characterId for a 'character' post, playerId for a 'player' post. */
  authorId: id,
  body: z.string().default(''),
  kind: FeedPostKindSchema.default('status'),
  /** Optional one-word mood/tone label (e.g. "wistful", "giddy"). */
  mood: z.string().default(''),
  /** The game event that spawned an NPC post (idempotency); null for player/ambient. */
  sourceEventId: id.nullable().default(null),
  dayNumber: z.number().int().nullable().default(null),
  phase: PhaseSchema.nullable().default(null),
  createdAt: ts,
});
export type FeedPost = z.infer<typeof FeedPostSchema>;

export const FeedCommentSchema = z.object({
  id,
  postId: id,
  authorType: FeedAuthorTypeSchema,
  authorId: id,
  body: z.string().default(''),
  /** In-character tone label (warm/playful/wry/cold/wistful…). Free text. */
  tone: z.string().default(''),
  createdAt: ts,
});
export type FeedComment = z.infer<typeof FeedCommentSchema>;

export const FeedReactionSchema = z.object({
  id,
  postId: id,
  actorType: FeedAuthorTypeSchema,
  actorId: id,
  kind: ReactionKindSchema.default('like'),
  createdAt: ts,
});
export type FeedReaction = z.infer<typeof FeedReactionSchema>;
