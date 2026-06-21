import { z } from 'zod';
import { DatingStatsSchema, DEFAULT_DATING_STATS } from '../stats';
import { IntentSchema } from '../intent';
import { RelationshipDeltaSchema } from './llm';
import {
  AssetSchema,
  AssetTypeSchema,
  CharacterSchema,
  ConversationModeSchema,
  ConversationSessionSchema,
  MessageSchema,
  PlayerProfileSchema,
  RelationshipSchema,
  ShopItemSchema,
  WorldNoteSchema,
  WorldSchema,
  InventoryItemSchema,
  CharacterMemorySchema,
  GameEventSchema,
  WorldStateSchema,
  NpcEdgeSchema,
  NpcKnowledgeSchema,
  CanonFactSchema,
  MessageThreadSchema,
  TextMessageSchema,
  EmailSchema,
  CharacterChronicleSchema,
  CharacterEndingSchema,
  DayRecordSchema,
  FeedPostSchema,
  FeedCommentSchema,
  FeedReactionSchema,
  FeedPostKindSchema,
  FeedAuthorTypeSchema,
  ReactionKindSchema,
  PropertySchema,
  PropertyOwnershipSchema,
  PropertyLeaseSchema,
  LandlordNoticeSchema,
  CompanySchema,
  StockHoldingSchema,
  StockPriceSchema,
  MarketNewsSchema,
  GamblingRoundSchema,
} from './entities';
import { DayRecapSchema, ITEM_GEN, LOCATION_GEN, PROPERTY_GEN, STOCK_GEN, WORLD_GEN } from './llm';
import { ItemCategorySchema, ItemRaritySchema } from './items';
import { RelationshipStatusSchema } from '../social';
import { PropertyCategorySchema, StockSectorSchema } from '../wealth';
import { CardSchema, CasinoGameSchema, RouletteBetSchema, VideoPokerRankSchema, SlotSymbolSchema } from '../gambling';
import {
  GradeSchema,
  MinigameConfigSchema,
  MinigameIdSchema,
  MinigameReactionSchema,
  MinigameRewardSchema,
  MinigameSubmissionSchema,
} from './minigames';

/**
 * API request/response DTOs. Inputs are validated on EVERY route with these
 * schemas. Fields that the client must never control (ids, timestamps, money,
 * stat deltas) are deliberately omitted from input shapes.
 */

// --- World notes ------------------------------------------------------------

export const WorldNoteCreateSchema = WorldNoteSchema.omit({
  id: true,
  worldId: true,
  createdAt: true,
  updatedAt: true,
});
export type WorldNoteCreate = z.input<typeof WorldNoteCreateSchema>;

export const WorldNoteUpdateSchema = WorldNoteCreateSchema.partial();
export type WorldNoteUpdate = z.input<typeof WorldNoteUpdateSchema>;

// --- World ------------------------------------------------------------------

const WorldBaseSchema = WorldSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const WorldCreateSchema = WorldBaseSchema.extend({
  // Optional structured notes to persist alongside the world in one shot (used by
  // the onboarding world generator). Create-only — not part of WorldUpdate.
  notes: z.array(WorldNoteCreateSchema).max(WORLD_GEN.MAX_NOTES).optional(),
});
export type WorldCreate = z.input<typeof WorldCreateSchema>;

export const WorldUpdateSchema = WorldBaseSchema.partial();
export type WorldUpdate = z.input<typeof WorldUpdateSchema>;

/** Clone an existing world (definition + notes + cast) into a fresh save. */
export const CloneWorldSchema = z.object({
  name: z.string().min(1).max(120),
});
export type CloneWorld = z.input<typeof CloneWorldSchema>;

/** Copy character DEFINITIONS from other worlds into this one as fresh characters. */
export const ImportCharactersSchema = z.object({
  sourceCharacterIds: z.array(z.string().min(1)).min(1).max(50),
});
export type ImportCharacters = z.input<typeof ImportCharactersSchema>;

// --- Character --------------------------------------------------------------

export const CharacterCreateSchema = CharacterSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  datingStats: DatingStatsSchema.default(DEFAULT_DATING_STATS),
});
export type CharacterCreate = z.input<typeof CharacterCreateSchema>;

export const CharacterUpdateSchema = CharacterCreateSchema.partial();
export type CharacterUpdate = z.input<typeof CharacterUpdateSchema>;

/** Input for the LLM dating-stats generator (works on an unsaved draft). */
export const GenerateDatingStatsInputSchema = z.object({
  name: z.string().default(''),
  age: z.number().int().optional(),
  shortDescription: z.string().default(''),
  personality: z.string().default(''),
  speechStyle: z.string().default(''),
  likes: z.array(z.string()).default([]),
  dislikes: z.array(z.string()).default([]),
  goals: z.array(z.string()).default([]),
  relationshipPreferences: z.string().default(''),
});
export type GenerateDatingStatsInput = z.input<typeof GenerateDatingStatsInputSchema>;

/**
 * Input for the LLM character-PROFILE generator (creator tool) — fills the
 * narrative "feel alive" fields (appearance, texting style, online persona,
 * love language, physical needs/desires/dislikes, insecurities, quirks) from a
 * description. Works on an unsaved draft; the server owns the bounded output.
 */
export const GenerateProfileInputSchema = z.object({
  name: z.string().default(''),
  age: z.number().int().optional(),
  shortDescription: z.string().default(''),
  personality: z.string().default(''),
  speechStyle: z.string().default(''),
  likes: z.array(z.string()).default([]),
  dislikes: z.array(z.string()).default([]),
  goals: z.array(z.string()).default([]),
  relationshipPreferences: z.string().default(''),
  appearance: z.string().default(''),
});
export type GenerateProfileInput = z.input<typeof GenerateProfileInputSchema>;

/**
 * Input for the LLM character-FROM-IMAGE generator (creator tool). The client
 * sends only the id of an already-uploaded portrait asset (the image never goes
 * through the browser→model path — the server reads it from the uploads dir and
 * base64-encodes it) and an optional world to flavor the result. The server owns
 * the bounded output; nothing is persisted until the creator saves the draft.
 */
export const GenerateCharacterFromImageInputSchema = z.object({
  assetId: z.string().min(1),
  worldId: z.string().min(1).nullable().default(null),
});
export type GenerateCharacterFromImageInput = z.input<typeof GenerateCharacterFromImageInputSchema>;

// --- Character memory (manual creation) -------------------------------------

export const MemoryCreateSchema = CharacterMemorySchema.omit({
  id: true,
  characterId: true,
  sourceEventId: true,
  createdAt: true,
  lastUsedAt: true,
});
export type MemoryCreate = z.input<typeof MemoryCreateSchema>;

// --- Player -----------------------------------------------------------------

/** Money is intentionally NOT updatable here — it only changes via validated services. */
export const PlayerUpdateSchema = PlayerProfileSchema.pick({
  name: true,
  pronouns: true,
  gender: true,
  sexuality: true,
  personaNotes: true,
}).partial();
export type PlayerUpdate = z.input<typeof PlayerUpdateSchema>;

// --- Assets -----------------------------------------------------------------

/** Non-file form fields accompanying an asset upload. */
export const AssetUploadFieldsSchema = z.object({
  type: AssetTypeSchema.default('other'),
  altText: z.string().max(300).optional(),
  tags: z.string().optional(), // comma-separated; parsed server-side
});
export type AssetUploadFields = z.infer<typeof AssetUploadFieldsSchema>;

// --- Conversations ----------------------------------------------------------

export const ConversationCreateSchema = z.object({
  characterId: z.string().min(1),
  mode: ConversationModeSchema.default('chat'),
  locationId: z.string().min(1).nullable().default(null),
});
export type ConversationCreate = z.input<typeof ConversationCreateSchema>;

export const SendMessageSchema = z.object({
  text: z.string().min(1).max(4000),
  /**
   * Optional conversational intent chip the player attached to this message
   * (Flirt / Tease / etc.). Stored on the message metadata and shown to the
   * judges so they can reward a fitting move and ding a mismatch. Pure agency —
   * it never moves a stat on its own.
   */
  intent: IntentSchema.optional(),
});
export type SendMessage = z.infer<typeof SendMessageSchema>;

/**
 * The world's single live, in-progress date — surfaced so the client can RESUME it
 * after a navigation or refresh (the date lives server-side, not just in component
 * state) and lock day-spending actions while it's underway. Null when no date is
 * open. Derived from the most-recent non-ended date/event session whose character
 * belongs to the world.
 */
export const ActiveDateSchema = z.object({
  sessionId: z.string(),
  characterId: z.string(),
  characterName: z.string(),
  mode: ConversationModeSchema,
  locationId: z.string().nullable(),
  /** True once the player has actually spoken — separates a real date in progress
   *  from a just-opened one (which can be cancelled at no cost). */
  hasPlayerTurn: z.boolean(),
  /** The live rapport (0..100) if the server still holds it for this session, so a
   *  resumed date can restore its trajectory bar; null when not yet judged. */
  rapport: z.number().nullable(),
  /** Qualitative vibe label for `rapport` (null whenever `rapport` is null). */
  vibe: z.string().nullable(),
  updatedAt: z.number(),
});
export type ActiveDate = z.infer<typeof ActiveDateSchema>;

// --- Shop / Inventory -------------------------------------------------------

export const ShopItemCreateSchema = ShopItemSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type ShopItemCreate = z.input<typeof ShopItemCreateSchema>;

export const ShopItemUpdateSchema = ShopItemCreateSchema.partial();
export type ShopItemUpdate = z.input<typeof ShopItemUpdateSchema>;

/**
 * Input for the LLM shop-item generator (creator tool). All fields defaulted so
 * a partial form validates. `world` is reference DATA used only to flavor the
 * generated items — the server never executes anything from it.
 */
export const GenerateShopItemsInputSchema = z.object({
  count: z.number().int().min(1).max(ITEM_GEN.MAX_ITEMS).default(4),
  theme: z.string().max(400).default(''),
  rarityHint: ItemRaritySchema.optional(),
  categoryHint: ItemCategorySchema.optional(),
  minPrice: z.number().int().min(ITEM_GEN.MIN_PRICE).max(ITEM_GEN.MAX_PRICE).optional(),
  maxPrice: z.number().int().min(ITEM_GEN.MIN_PRICE).max(ITEM_GEN.MAX_PRICE).optional(),
  world: z
    .object({
      name: z.string().max(120).default(''),
      summary: z.string().max(1_000).default(''),
      tone: z.string().max(400).default(''),
      lore: z.string().max(2_000).default(''),
      rules: z.string().max(2_000).default(''),
    })
    .default({}),
});
export type GenerateShopItemsInput = z.input<typeof GenerateShopItemsInputSchema>;
/** Parsed form (defaults applied) used by the server prompt builder + bounding. */
export type GenerateShopItemsParsed = z.output<typeof GenerateShopItemsInputSchema>;

/**
 * Input for the LLM location generator (creator tool). `prompt` is the creator's
 * free-form initial idea ("a rainy harbor district", "places for a first date").
 * World lore is NOT taken from the client here — the server loads it from the
 * world named in the route, so the generation always reflects the real setting.
 */
export const GenerateLocationsInputSchema = z.object({
  count: z.number().int().min(1).max(LOCATION_GEN.MAX_LOCATIONS).default(4),
  prompt: z.string().max(600).default(''),
});
export type GenerateLocationsInput = z.input<typeof GenerateLocationsInputSchema>;
/** Parsed form (defaults applied) used by the server prompt builder + bounding. */
export type GenerateLocationsParsed = z.output<typeof GenerateLocationsInputSchema>;

/**
 * Input for the LLM whole-world generator (onboarding tool). The creator supplies a
 * few optional seeds (name/summary/tone) plus a free-form `prompt` idea; the server
 * fleshes out the setting + a batch of locations. No world need exist yet, so unlike
 * location generation this carries its own seed context rather than loading a world.
 */
export const GenerateWorldInputSchema = z.object({
  name: z.string().max(WORLD_GEN.MAX_NAME).default(''),
  summary: z.string().max(600).default(''),
  tone: z.string().max(300).default(''),
  prompt: z.string().max(1000).default(''),
  locationCount: z
    .number()
    .int()
    .min(WORLD_GEN.MIN_LOCATIONS)
    .max(WORLD_GEN.MAX_LOCATIONS)
    .default(5),
  noteCount: z.number().int().min(WORLD_GEN.MIN_NOTES).max(WORLD_GEN.MAX_NOTES).default(4),
});
export type GenerateWorldInput = z.input<typeof GenerateWorldInputSchema>;
export type GenerateWorldParsed = z.output<typeof GenerateWorldInputSchema>;

/**
 * The server-bounded world DRAFT returned to the client: the full setting
 * (summary/tone/lore/rules/globalNotes) + locations + structured world notes, no
 * cast. `notes` are ready-to-create WorldNoteCreate rows (the world doesn't exist
 * yet, so they're persisted right after it's created).
 */
export const WorldGenDraftSchema = WorldSchema.pick({
  name: true,
  summary: true,
  tone: true,
  lore: true,
  rules: true,
  globalNotes: true,
  locations: true,
}).extend({
  notes: z.array(WorldNoteCreateSchema),
});
export type WorldGenDraft = z.infer<typeof WorldGenDraftSchema>;

export const PurchaseSchema = z.object({
  shopItemId: z.string().min(1),
  quantity: z.number().int().positive().max(99).default(1),
  /** World whose per-world wallet + inventory the purchase belongs to. */
  worldId: z.string().min(1).nullable().default(null),
});
export type Purchase = z.input<typeof PurchaseSchema>;

export const UseItemSchema = z.object({
  inventoryItemId: z.string().min(1),
  /** Target character for gift/use effects. Null for self-use. */
  characterId: z.string().min(1).nullable().default(null),
  /** World whose per-world wallet + inventory the item belongs to. */
  worldId: z.string().min(1).nullable().default(null),
});
export type UseItem = z.input<typeof UseItemSchema>;

/** A relationship-stage milestone the player crossed (date or minigame). */
export const MilestoneSchema = z.object({
  /** Warmth-band key reached, e.g. "close". */
  band: z.string(),
  /** Human label, e.g. "close". */
  label: z.string(),
  /** Celebratory one-liner shown to the player. */
  line: z.string(),
});
export type Milestone = z.infer<typeof MilestoneSchema>;

// --- Wealth: property -------------------------------------------------------

/** Reusable world-reference block: lore handed to a generator as DATA only. */
const WorldRefSchema = z
  .object({
    name: z.string().max(120).default(''),
    summary: z.string().max(1_000).default(''),
    tone: z.string().max(400).default(''),
    lore: z.string().max(2_000).default(''),
    rules: z.string().max(2_000).default(''),
  })
  .default({});

export const PropertyCreateSchema = PropertySchema.omit({ id: true, createdAt: true, updatedAt: true });
export type PropertyCreate = z.input<typeof PropertyCreateSchema>;

export const PropertyUpdateSchema = PropertyCreateSchema.partial();
export type PropertyUpdate = z.input<typeof PropertyUpdateSchema>;

/** Input for the LLM property generator (creator tool). `world` is reference DATA. */
export const GeneratePropertiesInputSchema = z.object({
  count: z.number().int().min(1).max(PROPERTY_GEN.MAX_PROPERTIES).default(4),
  theme: z.string().max(400).default(''),
  categoryHint: PropertyCategorySchema.optional(),
  world: WorldRefSchema,
});
export type GeneratePropertiesInput = z.input<typeof GeneratePropertiesInputSchema>;
export type GeneratePropertiesParsed = z.output<typeof GeneratePropertiesInputSchema>;

/** Body for any single-property player action (buy / sell / lease / pay-rent / end-lease). */
export const PropertyActionSchema = z.object({
  worldId: z.string().min(1),
  propertyId: z.string().min(1),
});
export type PropertyAction = z.input<typeof PropertyActionSchema>;

/** A property as the player sees it: ownership, active lease, and affordability. */
export const PropertyViewSchema = z.object({
  property: PropertySchema,
  owned: z.boolean().default(false),
  /** The player's active lease on this property, if any. */
  lease: PropertyLeaseSchema.nullable().default(null),
  /** Can the player afford to BUY it right now (per-world wallet). */
  affordableBuy: z.boolean().default(true),
  /** Can the player afford the first rent payment to LEASE it. */
  affordableLease: z.boolean().default(true),
});
export type PropertyView = z.infer<typeof PropertyViewSchema>;

export const BuyPropertyResponseSchema = z.object({
  ownership: PropertyOwnershipSchema,
  money: z.number().int().nonnegative(),
});
export type BuyPropertyResponse = z.infer<typeof BuyPropertyResponseSchema>;

export const SellPropertyResponseSchema = z.object({
  money: z.number().int().nonnegative(),
  refund: z.number().int().nonnegative(),
});
export type SellPropertyResponse = z.infer<typeof SellPropertyResponseSchema>;

export const LeaseResponseSchema = z.object({
  lease: PropertyLeaseSchema,
  money: z.number().int().nonnegative(),
});
export type LeaseResponse = z.infer<typeof LeaseResponseSchema>;

/** Landlord notices (overdue / eviction) — the urgent "Property Management" thread. */
export const LandlordInboxSchema = z.object({
  notices: z.array(LandlordNoticeSchema).default([]),
  unread: z.number().int().nonnegative().default(0),
});
export type LandlordInbox = z.infer<typeof LandlordInboxSchema>;

// --- Wealth: stock market ----------------------------------------------------

export const CompanyCreateSchema = CompanySchema.omit({ id: true, createdAt: true, updatedAt: true });
export type CompanyCreate = z.input<typeof CompanyCreateSchema>;

export const CompanyUpdateSchema = CompanyCreateSchema.partial();
export type CompanyUpdate = z.input<typeof CompanyUpdateSchema>;

/** Input for the LLM company generator (creator tool). `world` is reference DATA. */
export const GenerateCompaniesInputSchema = z.object({
  count: z.number().int().min(1).max(STOCK_GEN.MAX_COMPANIES).default(4),
  theme: z.string().max(400).default(''),
  sectorHint: StockSectorSchema.optional(),
  world: WorldRefSchema,
});
export type GenerateCompaniesInput = z.input<typeof GenerateCompaniesInputSchema>;
export type GenerateCompaniesParsed = z.output<typeof GenerateCompaniesInputSchema>;

export const TradeStockSchema = z.object({
  worldId: z.string().min(1),
  companyId: z.string().min(1),
  shares: z.number().int().positive().max(1_000_000),
});
export type TradeStock = z.input<typeof TradeStockSchema>;

/** A company on the market board: current + prior price, the day's move, holdings. */
export const MarketCompanyViewSchema = z.object({
  company: CompanySchema,
  price: z.number().int().positive(),
  prevPrice: z.number().int().positive(),
  /** Fractional day-over-day move (e.g. -0.03). */
  pct: z.number(),
  shares: z.number().int().nonnegative().default(0),
  costBasis: z.number().int().nonnegative().default(0),
});
export type MarketCompanyView = z.infer<typeof MarketCompanyViewSchema>;

export const MarketViewSchema = z.object({
  companies: z.array(MarketCompanyViewSchema).default([]),
  news: z.array(MarketNewsSchema).default([]),
});
export type MarketView = z.infer<typeof MarketViewSchema>;

export const PortfolioPositionSchema = z.object({
  company: CompanySchema,
  shares: z.number().int().nonnegative(),
  price: z.number().int().positive(),
  value: z.number().int().nonnegative(),
  costBasis: z.number().int().nonnegative(),
  /** Unrealized profit/loss vs. cost basis (can be negative). */
  pnl: z.number().int(),
});
export type PortfolioPosition = z.infer<typeof PortfolioPositionSchema>;

export const PortfolioViewSchema = z.object({
  positions: z.array(PortfolioPositionSchema).default([]),
  /** Total mark-to-market value of all holdings. */
  value: z.number().int().nonnegative().default(0),
  cash: z.number().int().nonnegative().default(0),
});
export type PortfolioView = z.infer<typeof PortfolioViewSchema>;

export const TradeStockResponseSchema = z.object({
  holding: StockHoldingSchema.nullable(),
  money: z.number().int().nonnegative(),
  /** The per-share price the trade executed at. */
  price: z.number().int().positive(),
});
export type TradeStockResponse = z.infer<typeof TradeStockResponseSchema>;

// --- Wealth: net worth ------------------------------------------------------

/** The HUD net-worth readout — cash plus property equity plus stock value. */
export const WealthSummarySchema = z.object({
  cash: z.number().int().nonnegative(),
  property: z.number().int().nonnegative(),
  stocks: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type WealthSummary = z.infer<typeof WealthSummarySchema>;

// --- Gambling (the casino) --------------------------------------------------
//
// Inputs carry only the worldId + stake + game inputs. The server is the money
// authority and the RNG: it never trusts a client-reported outcome or payout.
// Interactive games (blackjack / video poker) return a VIEW that redacts hidden
// state (the dealer's hole card, the undrawn deck).

/** Player-facing wallet + limit readout, shared by /state and every play result. */
export const GamblingWalletSchema = z.object({
  /** Current per-world wallet balance. */
  money: z.number().int().nonnegative(),
  minBet: z.number().int().nonnegative(),
  maxBet: z.number().int().nonnegative(),
  dailyLimit: z.number().int().nonnegative(),
  wageredToday: z.number().int().nonnegative(),
  /** dailyLimit - wageredToday, floored at 0. */
  remainingToday: z.number().int().nonnegative(),
});
export type GamblingWallet = z.infer<typeof GamblingWalletSchema>;

/** A blackjack hand as the player may see it (dealer hole card hidden mid-hand). */
export const BlackjackViewSchema = z.object({
  roundId: z.string().min(1),
  bet: z.number().int().positive(),
  /** player = the player is acting; done = settled. */
  phase: z.enum(['player', 'done']),
  player: z.array(CardSchema),
  playerTotal: z.number().int(),
  playerSoft: z.boolean().default(false),
  /** While phase=player only the dealer up-card(s) are present; full hand on done. */
  dealer: z.array(CardSchema),
  /** null while the hole card is hidden; the dealer total once revealed. */
  dealerTotal: z.number().int().nullable().default(null),
  canHit: z.boolean().default(false),
  canStand: z.boolean().default(false),
  canDouble: z.boolean().default(false),
  /** Set when phase=done. */
  outcome: z.enum(['blackjack', 'win', 'push', 'lose']).nullable().default(null),
  payout: z.number().int().nonnegative().default(0),
  /** payout - bet (negative = net loss). */
  net: z.number().int().default(0),
});
export type BlackjackView = z.infer<typeof BlackjackViewSchema>;

/** A video-poker hand: 5 cards, the player's holds, and (once drawn) the result. */
export const VideoPokerViewSchema = z.object({
  roundId: z.string().min(1),
  bet: z.number().int().positive(),
  /** draw = pick holds & draw; done = settled. */
  phase: z.enum(['draw', 'done']),
  cards: z.array(CardSchema).length(5),
  held: z.array(z.boolean()).length(5).default([false, false, false, false, false]),
  rank: VideoPokerRankSchema.nullable().default(null),
  payout: z.number().int().nonnegative().default(0),
  net: z.number().int().default(0),
});
export type VideoPokerView = z.infer<typeof VideoPokerViewSchema>;

/** The casino lobby read state, incl. any active hand to resume after a refresh. */
export const GamblingStateViewSchema = z.object({
  wallet: GamblingWalletSchema,
  activeBlackjack: BlackjackViewSchema.nullable().default(null),
  activeVideoPoker: VideoPokerViewSchema.nullable().default(null),
});
export type GamblingStateView = z.infer<typeof GamblingStateViewSchema>;

// Slots -----------------------------------------------------------------------
export const SlotsBetSchema = z.object({
  worldId: z.string().min(1),
  bet: z.number().int().positive(),
});
export type SlotsBet = z.input<typeof SlotsBetSchema>;

export const SlotsResultSchema = z.object({
  stops: z.array(z.number().int().nonnegative()).length(3),
  reels: z.array(SlotSymbolSchema).length(3),
  multiplier: z.number().nonnegative(),
  line: z.string().nullable().default(null),
  bet: z.number().int().positive(),
  payout: z.number().int().nonnegative(),
  net: z.number().int(),
  wallet: GamblingWalletSchema,
});
export type SlotsResult = z.infer<typeof SlotsResultSchema>;

// Roulette --------------------------------------------------------------------
export const RouletteSpinSchema = z.object({
  worldId: z.string().min(1),
  /** One or more chip bets; total stake is capped by the per-bet limit. */
  bets: z.array(RouletteBetSchema).min(1).max(20),
});
export type RouletteSpin = z.input<typeof RouletteSpinSchema>;

export const RouletteResultSchema = z.object({
  number: z.number().int().min(0).max(36),
  color: z.enum(['red', 'black', 'green']),
  /** Per-bet outcomes, index-aligned with the submitted bets. */
  bets: z.array(z.object({ bet: RouletteBetSchema, won: z.boolean(), payout: z.number().int().nonnegative() })),
  totalStake: z.number().int().positive(),
  totalPayout: z.number().int().nonnegative(),
  net: z.number().int(),
  wallet: GamblingWalletSchema,
});
export type RouletteResult = z.infer<typeof RouletteResultSchema>;

// Blackjack -------------------------------------------------------------------
export const BlackjackStartSchema = z.object({
  worldId: z.string().min(1),
  bet: z.number().int().positive(),
});
export type BlackjackStart = z.input<typeof BlackjackStartSchema>;

export const BlackjackActionSchema = z.object({
  worldId: z.string().min(1),
  roundId: z.string().min(1),
  action: z.enum(['hit', 'stand', 'double']),
});
export type BlackjackAction = z.input<typeof BlackjackActionSchema>;

/** A blackjack view plus the refreshed wallet (returned by start + each action). */
export const BlackjackResponseSchema = z.object({
  view: BlackjackViewSchema,
  wallet: GamblingWalletSchema,
});
export type BlackjackResponse = z.infer<typeof BlackjackResponseSchema>;

// Video poker -----------------------------------------------------------------
export const VideoPokerStartSchema = z.object({
  worldId: z.string().min(1),
  bet: z.number().int().positive(),
});
export type VideoPokerStart = z.input<typeof VideoPokerStartSchema>;

export const VideoPokerDrawSchema = z.object({
  worldId: z.string().min(1),
  roundId: z.string().min(1),
  /** Which of the 5 cards to KEEP across the draw. */
  holds: z.array(z.boolean()).length(5),
});
export type VideoPokerDraw = z.input<typeof VideoPokerDrawSchema>;

export const VideoPokerResponseSchema = z.object({
  view: VideoPokerViewSchema,
  wallet: GamblingWalletSchema,
});
export type VideoPokerResponse = z.infer<typeof VideoPokerResponseSchema>;

// --- Minigames --------------------------------------------------------------

export const MinigameStartSchema = z.object({
  minigameId: MinigameIdSchema,
  characterId: z.string().min(1).nullable().default(null),
  worldId: z.string().min(1).nullable().default(null),
});
export type MinigameStart = z.input<typeof MinigameStartSchema>;

export const MinigameStartResponseSchema = z.object({
  runId: z.string().min(1),
  minigameId: MinigameIdSchema,
  config: z.unknown(), // narrowed via MinigameConfigSchema by minigameId on the client
});
export type MinigameStartResponse = z.infer<typeof MinigameStartResponseSchema>;

export const MinigameFinishSchema = z.object({
  runId: z.string().min(1),
  submission: MinigameSubmissionSchema,
});
export type MinigameFinish = z.infer<typeof MinigameFinishSchema>;

/** Persisted minigame result. */
export const MinigameResultSchema = z.object({
  id: z.string().min(1),
  minigameId: MinigameIdSchema,
  characterId: z.string().min(1).nullable(),
  /** World the play happened in (per-world highscores). Null for legacy/world-less plays. */
  worldId: z.string().min(1).nullable().default(null),
  score: z.number(),
  grade: GradeSchema,
  reward: MinigameRewardSchema,
  createdAt: z.number().int().nonnegative(),
});
export type MinigameResult = z.infer<typeof MinigameResultSchema>;

export const MinigameFinishResponseSchema = z.object({
  result: MinigameResultSchema,
  relationship: RelationshipSchema.nullable(),
  /** A deterministic in-character reaction to how the play went (null when solo). */
  reaction: MinigameReactionSchema.nullable().default(null),
  /** A relationship milestone this play tipped, if any — a great game night can matter. */
  milestone: MilestoneSchema.nullable().default(null),
  /** Best score ever for this (game, character|solo) before this play. */
  bestScore: z.number().int().nullable().default(null),
  /** Whether this play set a new personal best. */
  isNewBest: z.boolean().default(false),
  /** Whether this was the character's favorite kind of game. */
  playedFavorite: z.boolean().default(false),
});
export type MinigameFinishResponse = z.infer<typeof MinigameFinishResponseSchema>;

// --- Composite / read responses ---------------------------------------------

/** A session bundled with its messages — used by the chat screen. */
export const SessionWithMessagesSchema = z.object({
  session: ConversationSessionSchema,
  messages: z.array(MessageSchema),
});
export type SessionWithMessages = z.infer<typeof SessionWithMessagesSchema>;

/** Outcome of a jealousy check when ending a date with a monogamous character. */
export const JealousyOutcomeSchema = z.object({
  triggered: z.boolean(),
  otherCount: z.number().int().nonnegative(),
  message: z.string(),
});
export type JealousyOutcome = z.infer<typeof JealousyOutcomeSchema>;

/** A relationship breakup surfaced at the end of a date (the cold state is now set). */
export const BreakupOutcomeSchema = z.object({
  /** The committed status that just ended (e.g. "cohabiting"). */
  fromStatus: RelationshipStatusSchema,
  /** Player-facing one-liner for the end-of-date banner. */
  line: z.string(),
});
export type BreakupOutcome = z.infer<typeof BreakupOutcomeSchema>;

/** Result of ending + evaluating a session (structured eval may fail safely). */
export const EndSessionResponseSchema = z.object({
  session: ConversationSessionSchema,
  evaluated: z.boolean(),
  /** Present only when structured evaluation succeeded. */
  relationship: RelationshipSchema.nullable(),
  mood: z.string().nullable(),
  expression: z.string().nullable(),
  summaryLine: z.string().nullable(),
  memoriesWritten: z.number().int().nonnegative(),
  /** Set when evaluation failed (state was NOT mutated by the failed eval). */
  evalError: z.string().nullable(),
  /** Jealousy reaction from a monogamous character, if it fired. */
  jealousy: JealousyOutcomeSchema.nullable().default(null),
  /** A relationship milestone crossed during this date's evaluation, if any. */
  milestone: MilestoneSchema.nullable().default(null),
  /** Set when this date pushed a committed relationship into a breakup. */
  breakup: BreakupOutcomeSchema.nullable().default(null),
  /** True when this date left a committed relationship "on the rocks" (a warning). */
  onTheRocks: z.boolean().default(false),
  /** True when this date won a broken-up character back (reconciliation). */
  reconciled: z.boolean().default(false),
  /** The "happy ending" reached this date (committed peak) — a soft win, if any. */
  ending: CharacterEndingSchema.nullable().default(null),
});
export type EndSessionResponse = z.infer<typeof EndSessionResponseSchema>;

/** Result of a Define-the-Relationship attempt. */
export const DtrResponseSchema = z.object({
  decision: z.enum(['accept', 'deflect', 'backfire']),
  /** The status the player attempted to reach (the rung). */
  attempted: RelationshipStatusSchema,
  /** The status AFTER the attempt (advances only on accept). */
  status: RelationshipStatusSchema,
  /** The character's in-character spoken line. */
  line: z.string(),
  /** The character message appended to the conversation thread. */
  message: MessageSchema,
  relationship: RelationshipSchema,
  /** True when a backfire ended the date. */
  ended: z.boolean().default(false),
});
export type DtrResponse = z.infer<typeof DtrResponseSchema>;

/** Body for giving a held item to your date during a session. */
export const GiftOnDateSchema = z.object({
  inventoryItemId: z.string().min(1),
});
export type GiftOnDate = z.infer<typeof GiftOnDateSchema>;

/** Server-derived read of how a gift landed — drives the outcome styling. */
export const GiftSentimentSchema = z.enum(['positive', 'neutral', 'negative']);
export type GiftSentiment = z.infer<typeof GiftSentimentSchema>;

/** Result of giving a gift during a date. */
export const GiftReactionResponseSchema = z.object({
  /** The "🎁 You gave …" beat inserted into the transcript. */
  narratorMessage: MessageSchema,
  /** The character's spoken reaction line, appended to the thread. */
  message: MessageSchema,
  line: z.string(),
  /** Canonical expression (already coerced server-side). */
  expression: z.string(),
  sentiment: GiftSentimentSchema,
  /** The deltas actually applied (clamped + capped) — drives the bar animation. */
  deltas: RelationshipDeltaSchema,
  relationship: RelationshipSchema,
  item: ShopItemSchema,
  memoryWritten: z.boolean().default(false),
});
export type GiftReactionResponse = z.infer<typeof GiftReactionResponseSchema>;

/** Result of confirming a player-initiated breakup. */
export const PlayerBreakupResponseSchema = z.object({
  relationship: RelationshipSchema,
  /** The status that was ended (e.g. "cohabiting", or "none" if uncommitted). */
  fromStatus: RelationshipStatusSchema,
  ended: z.boolean(),
});
export type PlayerBreakupResponse = z.infer<typeof PlayerBreakupResponseSchema>;

/** One card in a character's "Moments" timeline (assembled from events/memories/chronicle). */
export const MomentSchema = z.object({
  id: z.string(),
  /** In-world day, when known. */
  day: z.number().int().nullable().default(null),
  kind: z.enum(['milestone', 'date', 'jealousy', 'walkout', 'status', 'memory']),
  title: z.string(),
  body: z.string().default(''),
  mood: z.string().nullable().default(null),
  importance: z.number().int().min(1).max(5).nullable().default(null),
  createdAt: z.number().int().nonnegative(),
});
export type Moment = z.infer<typeof MomentSchema>;

/** Full character bundle for the editor / chat. */
export const CharacterBundleSchema = z.object({
  character: CharacterSchema,
  relationship: RelationshipSchema,
  memories: z.array(CharacterMemorySchema),
});
export type CharacterBundle = z.infer<typeof CharacterBundleSchema>;

// --- World clock (time / stamina / day) -------------------------------------

export const NeglectedCharacterSchema = z.object({
  characterId: z.string(),
  name: z.string(),
  daysSinceSeen: z.number().int().nonnegative(),
});
export type NeglectedCharacter = z.infer<typeof NeglectedCharacterSchema>;

// What the NPC world did on a given day — surfaced in the end-of-day recap modal.
export const WorldSimBeatSchema = z.object({
  kind: z.enum(['met', 'worked', 'shared', 'linked']),
  summary: z.string(),
});
export type WorldSimBeat = z.infer<typeof WorldSimBeatSchema>;

export const WorldSimResultSchema = z.object({
  day: z.number().int().nonnegative(),
  beats: z.array(WorldSimBeatSchema).default([]),
  newLinks: z.array(z.object({ a: z.string(), b: z.string() })).default([]),
});
export type WorldSimResult = z.infer<typeof WorldSimResultSchema>;

export const SleepResponseSchema = z.object({
  state: WorldStateSchema,
  recap: DayRecapSchema.nullable(),
  /** Set when the structured recap failed (the day still advanced). */
  recapError: z.string().nullable(),
  decayed: z.array(NeglectedCharacterSchema).default([]),
  /** Morning-briefing context for the new day. */
  calendar: z.object({ dayOfWeek: z.string(), season: z.string(), isWeekend: z.boolean() }).nullable().default(null),
  weather: z.object({ label: z.string(), icon: z.string() }).nullable().default(null),
  holiday: z.object({ name: z.string(), blurb: z.string() }).nullable().default(null),
  /** What the NPC world did on the day that just ended — the "Around town" beats. */
  worldSim: WorldSimResultSchema.nullable().default(null),
  /** Passive money credited to this world's wallet for the new day. */
  income: z.number().default(0),
});
export type SleepResponse = z.infer<typeof SleepResponseSchema>;

// --- Calendar / almanac (the Phone "Calendar" app reads this) ---------------

/** A day's deterministic weather, resolved for display. */
export const DayWeatherViewSchema = z.object({
  kind: z.string(),
  label: z.string(),
  icon: z.string(),
});
export type DayWeatherView = z.infer<typeof DayWeatherViewSchema>;

/** One day in the almanac: its (recomputed) weather + its persisted record, if any.
 *  Day-of-week / season / holiday are derived client-side via `deriveCalendar(day)`. */
export const CalendarEntrySchema = z.object({
  day: z.number().int().positive(),
  weather: DayWeatherViewSchema,
  record: DayRecordSchema.nullable().default(null),
});
export type CalendarEntry = z.infer<typeof CalendarEntrySchema>;

export const WorldCalendarSchema = z.object({
  worldId: z.string(),
  /** The day currently in progress (its record, if any, is still provisional). */
  currentDay: z.number().int().positive(),
  /** Days 1 … end-of-current-season, oldest first. Future days carry weather but no record. */
  entries: z.array(CalendarEntrySchema).default([]),
});
export type WorldCalendar = z.infer<typeof WorldCalendarSchema>;

// --- Phone ------------------------------------------------------------------

export const SendTextSchema = z
  .object({
    // Text is optional WHEN a photo or gift is attached (either alone is valid).
    text: z.string().max(1000).default(''),
    /** An uploaded image asset to attach (player-sent photo). */
    imageAssetId: z.string().min(1).nullable().default(null),
    /** A held inventory item to send as a gift (triggers a gift reaction). */
    giftId: z.string().min(1).nullable().default(null),
  })
  .refine((d) => d.text.trim().length > 0 || d.imageAssetId || d.giftId, {
    message: 'Type a message, attach an image, or send a gift.',
    path: ['text'],
  });
export type SendText = z.infer<typeof SendTextSchema>;

/** One row in the Messages app thread list. */
export const PhoneThreadSummarySchema = z.object({
  characterId: z.string(),
  characterName: z.string(),
  portraitAssetId: z.string().nullable(),
  lastBody: z.string().nullable(),
  lastAt: z.number().nullable(),
  /** Whether the last delivered text was sent by the player — lets the inbox
   *  preview prefix "You:" so an outgoing-but-unanswered thread reads clearly. */
  lastFromPlayer: z.boolean().default(false),
  unread: z.number().int().nonnegative(),
  /** Current-day availability, so the inbox can flag a busy contact up front
   *  (without the player having to attempt a text to find out). */
  available: z.boolean().default(true),
  unavailableReason: z.string().nullable().default(null),
});
export type PhoneThreadSummary = z.infer<typeof PhoneThreadSummarySchema>;

export const PhoneInboxSchema = z.object({
  unreadTexts: z.number().int().nonnegative(),
  unreadEmails: z.number().int().nonnegative(),
  /** New NPC posts + comments on Faces since the player last opened it. */
  feedUnread: z.number().int().nonnegative().default(0),
  /** Unread urgent landlord notices (overdue rent / eviction). */
  landlordUnread: z.number().int().nonnegative().default(0),
});
export type PhoneInbox = z.infer<typeof PhoneInboxSchema>;

// --- Faces (social feed) ----------------------------------------------------

export const CreateFeedPostSchema = z.object({
  body: z.string().min(1).max(500),
  worldId: z.string().min(1),
});
export type CreateFeedPost = z.input<typeof CreateFeedPostSchema>;

export const FeedReactSchema = z.object({
  kind: ReactionKindSchema.default('like'),
});
export type FeedReact = z.input<typeof FeedReactSchema>;

export const FeedCommentInputSchema = z.object({
  body: z.string().min(1).max(400),
});
export type FeedCommentInput = z.input<typeof FeedCommentInputSchema>;

/** A reaction kind summarized for display: how many, and a few names. */
export const FeedReactionViewSchema = z.object({
  kind: ReactionKindSchema,
  count: z.number().int().nonnegative(),
  actorNames: z.array(z.string()).default([]),
});
export type FeedReactionView = z.infer<typeof FeedReactionViewSchema>;

export const FeedCommentViewSchema = z.object({
  id: z.string(),
  authorType: FeedAuthorTypeSchema,
  authorId: z.string(),
  authorName: z.string(),
  portraitAssetId: z.string().nullable().default(null),
  body: z.string(),
  tone: z.string().default(''),
  createdAt: z.number(),
});
export type FeedCommentView = z.infer<typeof FeedCommentViewSchema>;

/** A feed post with author display info + its reactions and comments, for the UI. */
export const FeedPostViewSchema = z.object({
  id: z.string(),
  authorType: FeedAuthorTypeSchema,
  authorId: z.string(),
  authorName: z.string(),
  portraitAssetId: z.string().nullable().default(null),
  body: z.string(),
  kind: FeedPostKindSchema,
  mood: z.string().default(''),
  dayNumber: z.number().nullable().default(null),
  createdAt: z.number(),
  reactions: z.array(FeedReactionViewSchema).default([]),
  /** The player's own reaction kind (for the toggle UI), or null. */
  playerReaction: ReactionKindSchema.nullable().default(null),
  comments: z.array(FeedCommentViewSchema).default([]),
});
export type FeedPostView = z.infer<typeof FeedPostViewSchema>;

export const FeedViewSchema = z.object({
  posts: z.array(FeedPostViewSchema).default([]),
});
export type FeedView = z.infer<typeof FeedViewSchema>;

/** Response after the player creates a post (post comes back with its fresh NPC comments/reactions). */
export const CreateFeedPostResponseSchema = z.object({
  post: FeedPostViewSchema,
});
export type CreateFeedPostResponse = z.infer<typeof CreateFeedPostResponseSchema>;

// --- Export / import --------------------------------------------------------

export const ExportBundleSchema = z.object({
  version: z.literal(1),
  exportedAt: z.number().int().nonnegative(),
  /** 'savegame' carries playthrough state; 'authoring' zeroes derived world-sim/
   *  canon data so re-seeding a shared world can't inherit a playthrough's facts. */
  kind: z.enum(['authoring', 'savegame']).default('savegame'),
  worlds: z.array(WorldSchema),
  worldNotes: z.array(WorldNoteSchema),
  characters: z.array(CharacterSchema),
  memories: z.array(CharacterMemorySchema),
  relationships: z.array(RelationshipSchema),
  conversationSessions: z.array(ConversationSessionSchema).default([]),
  messages: z.array(MessageSchema).default([]),
  players: z.array(PlayerProfileSchema),
  assets: z.array(AssetSchema),
  shopItems: z.array(ShopItemSchema),
  inventory: z.array(InventoryItemSchema),
  minigameResults: z.array(MinigameResultSchema).default([]),
  events: z.array(GameEventSchema).default([]),
  worldStates: z.array(WorldStateSchema).default([]),
  messageThreads: z.array(MessageThreadSchema).default([]),
  textMessages: z.array(TextMessageSchema).default([]),
  emails: z.array(EmailSchema).default([]),
  chronicles: z.array(CharacterChronicleSchema).default([]),
  endings: z.array(CharacterEndingSchema).default([]),
  dayRecords: z.array(DayRecordSchema).default([]),
  feedPosts: z.array(FeedPostSchema).default([]),
  feedComments: z.array(FeedCommentSchema).default([]),
  feedReactions: z.array(FeedReactionSchema).default([]),
  // Derived world-sim state — kept as DISTINCT arrays (never inside characters) so
  // it's clearly playthrough data and an 'authoring' export can drop it cleanly.
  npcEdges: z.array(NpcEdgeSchema).default([]),
  npcKnowledge: z.array(NpcKnowledgeSchema).default([]),
  canonFacts: z.array(CanonFactSchema).default([]),
  // Wealth: authored content (properties, companies) ships with 'authoring'; the
  // playthrough state (ownership, holdings, prices, news) is zeroed for that kind.
  properties: z.array(PropertySchema).default([]),
  propertyOwnership: z.array(PropertyOwnershipSchema).default([]),
  propertyLeases: z.array(PropertyLeaseSchema).default([]),
  landlordNotices: z.array(LandlordNoticeSchema).default([]),
  companies: z.array(CompanySchema).default([]),
  stockHoldings: z.array(StockHoldingSchema).default([]),
  stockPrices: z.array(StockPriceSchema).default([]),
  marketNews: z.array(MarketNewsSchema).default([]),
  // Gambling: pure playthrough state (settled-bet log + any active hand).
  gamblingRounds: z.array(GamblingRoundSchema).default([]),
});
export type ExportBundle = z.infer<typeof ExportBundleSchema>;

// --- Generic API error ------------------------------------------------------

export const ApiErrorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
