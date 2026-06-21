import { z } from 'zod';
import { WorldNoteScopeSchema } from './entities';
import { MAX_EVAL_DELTA, EMAILS_MAX_PER_DAY, MIN_CHARACTER_AGE, GUARDEDNESS_DEFAULT, WEALTH } from '../constants';
import { PhaseSchema } from '../time';
import { ItemCategorySchema, ItemRaritySchema } from './items';
import { RelationshipStatKeySchema, DatingStatKeySchema, DatingStatsSchema } from '../stats';
import { ExpressionSchema, DEFAULT_EXPRESSION, MemoryTagArraySchema } from '../vocab';
import { GenderSchema, SexualitySchema, RelationshipStyleSchema } from '../social';
import { PropertyCategorySchema, StockSectorSchema, RentCadenceSchema } from '../wealth';

/**
 * Structured-output schemas the LLM must satisfy. Every schema here is fed
 * through `callStructuredLlm` on the server: the model's JSON is parsed
 * strictly and validated against the matching Zod schema, with retry/repair
 * on failure. None of these results mutate game state until validation passes.
 */

const boundedDelta = z.number().int().min(-MAX_EVAL_DELTA).max(MAX_EVAL_DELTA);

/** Proposed relationship-stat changes. All keys optional; server clamps. */
export const RelationshipDeltaSchema = z
  .object({
    affection: boundedDelta.optional(),
    trust: boundedDelta.optional(),
    chemistry: boundedDelta.optional(),
    comfort: boundedDelta.optional(),
    respect: boundedDelta.optional(),
    curiosity: boundedDelta.optional(),
    tension: boundedDelta.optional(),
  })
  .default({});
export type RelationshipDelta = z.infer<typeof RelationshipDeltaSchema>;

export const MemoryCandidateSchema = z.object({
  text: z.string().min(1).max(600),
  importance: z.number().int().min(1).max(5),
  /** Canonical tags only — off-list values are dropped (never stored). */
  tags: MemoryTagArraySchema,
});
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

/**
 * Structured evaluator output produced at the end of a session. Drives
 * relationship deltas, mood/expression, and memory writes.
 */
export const SessionEvaluationSchema = z.object({
  mood: z.string().min(1).max(40),
  /** Canonical expression the UI maps to a portrait asset; off-list → neutral. */
  expression: ExpressionSchema.catch(DEFAULT_EXPRESSION),
  relationshipDeltas: RelationshipDeltaSchema,
  memoryCandidates: z.array(MemoryCandidateSchema).max(8).default([]),
  /** A short recap of what happened (a sentence or two), used as a session
   *  highlight. Kept in sync with ChronicleLine.line (entities.ts) and the slice
   *  in chronicle-service; the Calendar clamps it visually with a "show more". */
  summaryLine: z.string().min(1).max(600),
});
export type SessionEvaluation = z.infer<typeof SessionEvaluationSchema>;

/** Folded narrative of the player's history with a character (no stat fields). */
export const ChronicleSchema = z.object({
  chronicle: z.string().min(1).max(5000),
  highlights: z.array(z.string().min(1).max(160)).max(6).default([]),
});
export type Chronicle = z.infer<typeof ChronicleSchema>;

/** Mid-date decision: should the character end the date over the player's behavior? */
export const WalkoutReactionSchema = z.object({
  walkout: z.boolean(),
  reason: z.string().max(120).default(''),
  farewellLine: z.string().min(1).max(240),
  /** First-person memory the character will carry of what drove the walkout —
   *  written only when walkout=true (server falls back to `reason` if omitted). */
  memory: z.string().max(400).default(''),
  /** One-line recap of how the date ended, folded into the cross-date chronicle. */
  summaryLine: z.string().max(240).default(''),
});
export type WalkoutReaction = z.infer<typeof WalkoutReactionSchema>;

/**
 * Decision when the player tries to advance the relationship status (DTR ladder).
 * The model only chooses the reaction + writes the in-character line; the SERVER
 * owns every stat delta and the status flag. `backfire` is reserved for a
 * genuinely badly-timed ask (hurt, angry, far too soon).
 */
export const DtrReactionSchema = z.object({
  decision: z.enum(['accept', 'deflect', 'backfire']),
  line: z.string().min(1).max(400),
  reason: z.string().max(160).default(''),
});
export type DtrReaction = z.infer<typeof DtrReactionSchema>;

/**
 * How a character reacts to receiving a GIFT (given on a date or sent by text).
 * The model voices ONE short spoken/texted line, picks an expression, proposes
 * modest relationship deltas, and optionally writes a keepsake memory. As with
 * every structured task, the SERVER clamps the deltas and owns the outcome — a
 * gift that hits a dislike or crosses a boundary should come back flat/negative.
 */
export const GiftReactionSchema = z.object({
  /** Canonical expression for the portrait; off-list → neutral. */
  expression: ExpressionSchema.catch(DEFAULT_EXPRESSION),
  /** The character's in-character reaction (one short line). */
  line: z.string().min(1).max(280),
  /** Proposed stat changes — server clamps + caps these to a gift-sized nudge. */
  relationshipDeltas: RelationshipDeltaSchema,
  /** A keepsake (or sting) the character carries from the gift, or null. */
  memory: MemoryCandidateSchema.nullable().default(null),
});
export type GiftReaction = z.infer<typeof GiftReactionSchema>;

/**
 * Decision when the PLAYER tries to break up with the character mid-date. The
 * model first judges whether the player GENUINELY means to end things (vs joking,
 * hypothetical, or saying the opposite), then picks the character's reaction +
 * writes their in-character line. The SERVER owns the actual breakup (and only
 * applies it once the player confirms).
 */
export const PlayerBreakupReactionSchema = z.object({
  /** Is the player genuinely ending the relationship right now? */
  genuine: z.boolean(),
  /** How the character takes it (only meaningful when genuine). */
  reaction: z.enum(['accept', 'hurt', 'plead']).default('hurt'),
  line: z.string().min(1).max(400),
});
export type PlayerBreakupReaction = z.infer<typeof PlayerBreakupReactionSchema>;

/** Compact rolling summary of a session, used to bound prompt growth. */
export const SessionSummarySchema = z.object({
  summary: z.string().min(1).max(1200),
  keyPoints: z.array(z.string().min(1).max(200)).max(8).default([]),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/** A single generated quiz question, including the correct answer (server-only). */
export const GeneratedQuizQuestionSchema = z.object({
  prompt: z.string().min(1).max(300),
  choices: z.array(z.string().min(1).max(160)).min(3).max(4),
  correctIndex: z.number().int().min(0),
  explanation: z.string().max(300).default(''),
});
export type GeneratedQuizQuestion = z.infer<typeof GeneratedQuizQuestionSchema>;

export const QuizGenerationSchema = z.object({
  questions: z.array(GeneratedQuizQuestionSchema).min(1).max(8),
});
export type QuizGeneration = z.infer<typeof QuizGenerationSchema>;

/** A freelance writing commission generated for The Copy Desk (Writer) job: a short
 *  in-world newspaper dispatch the player transcribes. Length is bounded so a typing
 *  shift stays brief and the LLM call stays cheap; the body is prose only (no stats). */
export const WriterCommissionGenSchema = z.object({
  headline: z.string().min(1).max(120),
  body: z.string().min(60).max(600),
});
export type WriterCommissionGen = z.infer<typeof WriterCommissionGenSchema>;

// --- Shop-item generation (creator tool: batch in-world items) --------------

/**
 * Tuning bounds for LLM-generated shop items. Shared by the generation schema,
 * the server-side clamp (`boundGeneratedItem`), and the prompt. Item effects are
 * capped TIGHTER than the hand-authored `ItemEffectSchema` so the model can't
 * mint a stat-maxing or money-printing item — the server clamp is the authority.
 */
export const ITEM_GEN = {
  MAX_ITEMS: 12,
  MIN_PRICE: 0,
  MAX_PRICE: 5_000,
  /** Stat-effect magnitude cap; mirrors MAX_EVAL_DELTA so items feel proportional to a session. */
  MAX_EFFECT_MAGNITUDE: MAX_EVAL_DELTA, // 15
  MAX_EFFECTS_PER_ITEM: 3,
  MAX_BUFF_DURATION: 10,
  /** Money-effect magnitude cap on a generated item (far below the schema's 10_000). */
  MAX_MONEY_EFFECT: 100,
} as const;

const genDelta = z.number().int().min(-ITEM_GEN.MAX_EFFECT_MAGNITUDE).max(ITEM_GEN.MAX_EFFECT_MAGNITUDE);

/**
 * Effect shapes the GENERATOR may emit — same kinds as ItemEffectSchema, but
 * with tighter deltas, and 'dating' is DELIBERATELY EXCLUDED: it permanently
 * mutates a shared character base stat for every player, so it is never
 * LLM-authored (temp_buff is the safe transient analog).
 */
export const GeneratedItemEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('relationship'), stat: RelationshipStatKeySchema, delta: genDelta }),
  z.object({
    kind: z.literal('temp_buff'),
    stat: DatingStatKeySchema,
    delta: genDelta,
    durationSessions: z.number().int().positive().max(ITEM_GEN.MAX_BUFF_DURATION),
  }),
  z.object({ kind: z.literal('flag'), flag: z.string().min(1).max(64), value: z.boolean() }),
  z.object({
    kind: z.literal('money'),
    delta: z.number().int().min(-ITEM_GEN.MAX_MONEY_EFFECT).max(ITEM_GEN.MAX_MONEY_EFFECT),
  }),
]);
export type GeneratedItemEffect = z.infer<typeof GeneratedItemEffectSchema>;

/** One generated item draft (no id/timestamps/asset/stock — those are server-owned at save). */
export const GeneratedShopItemSchema = z.object({
  name: z.string().min(1).max(60),
  description: z.string().min(1).max(240),
  category: ItemCategorySchema,
  rarity: ItemRaritySchema,
  price: z.number().int().min(ITEM_GEN.MIN_PRICE).max(ITEM_GEN.MAX_PRICE),
  effects: z.array(GeneratedItemEffectSchema).max(ITEM_GEN.MAX_EFFECTS_PER_ITEM).default([]),
});
export type GeneratedShopItem = z.infer<typeof GeneratedShopItemSchema>;

export const ShopItemGenerationSchema = z.object({
  items: z.array(GeneratedShopItemSchema).min(1).max(ITEM_GEN.MAX_ITEMS),
});
export type ShopItemGeneration = z.infer<typeof ShopItemGenerationSchema>;

/**
 * Bounds for the LLM LOCATION generator (creator tool). These cap what the model
 * may emit; the server clamp (`boundGeneratedLocation`) is the authority and also
 * assigns the id, so generated drafts can never set a name/desc/tags out of range.
 */
export const LOCATION_GEN = {
  MAX_LOCATIONS: 8,
  MAX_NAME: 60,
  MAX_DESCRIPTION: 280,
  MAX_TAGS: 6,
  MAX_TAG_LEN: 24,
} as const;

/** One generated location draft (no id — the server assigns it at bound time). */
export const GeneratedLocationSchema = z.object({
  name: z.string().min(1).max(LOCATION_GEN.MAX_NAME),
  description: z.string().min(1).max(LOCATION_GEN.MAX_DESCRIPTION),
  tags: z.array(z.string().min(1).max(LOCATION_GEN.MAX_TAG_LEN)).max(LOCATION_GEN.MAX_TAGS).default([]),
  /** True if the venue is sheltered from the weather (mirrors Location.indoor). */
  indoor: z.boolean().default(false),
});
export type GeneratedLocation = z.infer<typeof GeneratedLocationSchema>;

export const LocationGenerationSchema = z.object({
  locations: z.array(GeneratedLocationSchema).min(1).max(LOCATION_GEN.MAX_LOCATIONS),
});
export type LocationGeneration = z.infer<typeof LocationGenerationSchema>;

// --- World generation (onboarding tool: a whole world from a few seeds) ------

/**
 * Bounds for the LLM WORLD generator. The server clamp (`boundGeneratedWorld`) is
 * the authority: it trims every text field to length and bounds the locations. The
 * generator intentionally does NOT produce characters — only the setting + venues.
 */
export const WORLD_GEN = {
  MAX_NAME: 80,
  MAX_SUMMARY: 280,
  MAX_TONE: 120,
  MAX_LORE: 2000,
  MAX_RULES: 1200,
  MAX_GLOBAL_NOTES: 1500,
  MIN_LOCATIONS: 3,
  MAX_LOCATIONS: 8,
  MIN_NOTES: 3,
  MAX_NOTES: 6,
  MAX_NOTE_TITLE: 70,
  MAX_NOTE_BODY: 600,
  MAX_NOTE_TAGS: 6,
} as const;

/** One generated structured world note (lore/faction/rule/place entry, no id). */
export const GeneratedWorldNoteSchema = z.object({
  title: z.string().min(1).max(WORLD_GEN.MAX_NOTE_TITLE),
  body: z.string().min(1).max(WORLD_GEN.MAX_NOTE_BODY),
  tags: z
    .array(z.string().min(1).max(LOCATION_GEN.MAX_TAG_LEN))
    .max(WORLD_GEN.MAX_NOTE_TAGS)
    .default([]),
  /** Mirrors WorldNoteScope. 'character' is disallowed — the generator makes no cast. */
  scope: WorldNoteScopeSchema.exclude(['character']).default('lore'),
  importance: z.number().int().min(1).max(5).default(3),
});
export type GeneratedWorldNote = z.infer<typeof GeneratedWorldNoteSchema>;

/**
 * A whole generated world DRAFT: the setting (summary/tone/lore/rules + always-on
 * global notes), a batch of locations, and a set of structured world notes — but NO
 * cast. The world is a fleshed-out stage; its people are created separately.
 */
export const WorldGenerationSchema = z.object({
  name: z.string().min(1).max(WORLD_GEN.MAX_NAME),
  summary: z.string().min(1).max(WORLD_GEN.MAX_SUMMARY),
  tone: z.string().min(1).max(WORLD_GEN.MAX_TONE),
  lore: z.string().max(WORLD_GEN.MAX_LORE).default(''),
  rules: z.string().max(WORLD_GEN.MAX_RULES).default(''),
  globalNotes: z.string().max(WORLD_GEN.MAX_GLOBAL_NOTES).default(''),
  locations: z.array(GeneratedLocationSchema).min(WORLD_GEN.MIN_LOCATIONS).max(WORLD_GEN.MAX_LOCATIONS),
  notes: z.array(GeneratedWorldNoteSchema).min(WORLD_GEN.MIN_NOTES).max(WORLD_GEN.MAX_NOTES),
});
export type WorldGeneration = z.infer<typeof WorldGenerationSchema>;

// --- Property generation (creator tool: batch in-world properties) ----------

/**
 * Bounds for the LLM PROPERTY generator. The server clamp (`boundGeneratedProperty`)
 * is the authority: it assigns the id/world, clamps every economic field, and
 * enforces the rent-payback floor (`MIN_PAYBACK_DAYS`) so a generated property can
 * never out-earn its purchase price faster than the configured floor.
 */
export const PROPERTY_GEN = {
  MAX_PROPERTIES: 8,
  MAX_NAME: 60,
  MAX_DESCRIPTION: 280,
  MIN_PRICE: 0,
  /** Ceiling on a property's purchase price. */
  MAX_PRICE: 100_000,
  /** Ceiling on the recurring lease rent (charged each cadence). */
  MAX_RENT_AMOUNT: 5_000,
  /** Ceiling on the date-buff magnitude (kept tiny — proportional to the small
   *  venue nudges in venues.ts). */
  MAX_BUFF: 5,
  MAX_TAGS: 6,
  MAX_TAG_LEN: 24,
  /** Anti-cheap-buy: owning must be worth at least this many days of rent (so buying
   *  is a real investment over leasing, never trivially cheaper). */
  MIN_PAYBACK_DAYS: 90,
} as const;

/** One generated property draft (no id/world/timestamps — server-owned at save). */
export const GeneratedPropertySchema = z.object({
  name: z.string().min(1).max(PROPERTY_GEN.MAX_NAME),
  description: z.string().min(1).max(PROPERTY_GEN.MAX_DESCRIPTION),
  category: PropertyCategorySchema,
  buyPrice: z.number().int().min(PROPERTY_GEN.MIN_PRICE).max(PROPERTY_GEN.MAX_PRICE),
  rentAmount: z.number().int().min(0).max(PROPERTY_GEN.MAX_RENT_AMOUNT).default(0),
  rentCadence: RentCadenceSchema.default('weekly'),
  indoor: z.boolean().default(true),
  tags: z.array(z.string().min(1).max(PROPERTY_GEN.MAX_TAG_LEN)).max(PROPERTY_GEN.MAX_TAGS).default([]),
  /** Relationship stat a date here nudges (owned = full, leased = half). Null = none. */
  buffStat: RelationshipStatKeySchema.nullable().default(null),
  buffAmount: z.number().int().min(0).max(PROPERTY_GEN.MAX_BUFF).default(0),
});
export type GeneratedProperty = z.infer<typeof GeneratedPropertySchema>;

export const PropertyGenerationSchema = z.object({
  properties: z.array(GeneratedPropertySchema).min(1).max(PROPERTY_GEN.MAX_PROPERTIES),
});
export type PropertyGeneration = z.infer<typeof PropertyGenerationSchema>;

// --- Company / stock generation (creator tool: batch fictional companies) ----

/**
 * Bounds for the LLM COMPANY generator. The server clamp (`boundGeneratedCompany`)
 * assigns id/world, normalizes the ticker (A–Z, 1–5 chars), and caps the dividend to
 * a small yield of the base price so a holding can never print money.
 */
export const STOCK_GEN = {
  MAX_COMPANIES: 8,
  MAX_NAME: 60,
  MAX_DESCRIPTION: 280,
  MAX_TICKER_LEN: 5,
  MIN_PRICE: 1,
  /** Ceiling on a company's base/anchor share price. */
  MAX_PRICE: 5_000,
  /** Ceiling on daily volatility (±swing fraction). */
  MAX_VOLATILITY: 0.15,
  /** Hard ceiling on dividend-per-share the GENERATOR may emit (server re-caps to a
   *  per-company yield via maxDividendForPrice). */
  MAX_DIVIDEND: Math.floor(5_000 * WEALTH.MAX_DIVIDEND_YIELD),
} as const;

/** One generated company draft (no id/world/timestamps/link — server-owned at save). */
export const GeneratedCompanySchema = z.object({
  name: z.string().min(1).max(STOCK_GEN.MAX_NAME),
  ticker: z.string().min(1).max(STOCK_GEN.MAX_TICKER_LEN),
  description: z.string().min(1).max(STOCK_GEN.MAX_DESCRIPTION),
  sector: StockSectorSchema,
  basePrice: z.number().int().min(STOCK_GEN.MIN_PRICE).max(STOCK_GEN.MAX_PRICE),
  volatility: z.number().min(0).max(STOCK_GEN.MAX_VOLATILITY),
  dividendPerShare: z.number().int().min(0).max(STOCK_GEN.MAX_DIVIDEND).default(0),
});
export type GeneratedCompany = z.infer<typeof GeneratedCompanySchema>;

export const CompanyGenerationSchema = z.object({
  companies: z.array(GeneratedCompanySchema).min(1).max(STOCK_GEN.MAX_COMPANIES),
});
export type CompanyGeneration = z.infer<typeof CompanyGenerationSchema>;

/**
 * ONE batched market-news "color" pass over the day's biggest movers (mirrors
 * WorldSimColor). The server sends each mover as a numbered `ref` (the ticker) plus
 * the neutral facts (% move, any catalyst), and the model returns a one-line
 * headline + blurb per ref. The server matches refs back and drops any it didn't
 * send — the model can never invent a company or a price, only narrate the move.
 */
export const MarketNewsLineSchema = z.object({
  ref: z.string().min(1).max(8),
  headline: z.string().min(1).max(120),
  body: z.string().min(1).max(280),
});
export const MarketNewsGenSchema = z.object({
  items: z.array(MarketNewsLineSchema).max(STOCK_GEN.MAX_COMPANIES).default([]),
});
export type MarketNewsGen = z.infer<typeof MarketNewsGenSchema>;

/** End-of-day recap, narrated from the day's actual events (no stat fields). */
export const DayRecapSchema = z.object({
  headline: z.string().min(1).max(120),
  narrative: z.string().min(1).max(1800),
  highlights: z.array(z.string().min(1).max(200)).max(8).default([]),
});
export type DayRecap = z.infer<typeof DayRecapSchema>;

/**
 * ONE batched "color" pass over the day's pre-decided world-sim happenings. The
 * server sends each happening as a numbered `ref` + a neutral fact; the model
 * returns a natural one-line rewrite per ref. The server matches refs back and
 * drops any it didn't send — so the model can NEVER invent people or events, only
 * reword what the deterministic sim already decided.
 */
export const WorldSimColorLineSchema = z.object({
  ref: z.string().min(1).max(40),
  summary: z.string().min(1).max(200),
  /** For meeting refs only: one short clause of what they actually talked about,
   *  grounded in the topic + personalities the server provided. Becomes both parties'
   *  memory of the encounter. Optional — a missing gist just leaves the templated memory. */
  gist: z.string().max(200).optional(),
});
export const WorldSimColorSchema = z.object({
  lines: z.array(WorldSimColorLineSchema).max(16).default([]),
});
export type WorldSimColor = z.infer<typeof WorldSimColorSchema>;

/**
 * Ex-canonization extraction: facts a character STATED about their ex on a date.
 * Categories are RESTRICTED to the lowest-corruption surfaces (no belief /
 * personality / history). `sourceQuote` is REQUIRED and the server verifies it is
 * a verbatim substring of an actual character-spoken line before anything is
 * written — the model can never canonize something it can't quote.
 */
export const ExFactSchema = z.object({
  category: z.enum(['habit', 'hobby', 'job', 'appearance']),
  value: z.string().min(1).max(80),
  sensitivity: z.enum(['neutral', 'touchy']).default('neutral'),
  sourceQuote: z.string().min(1).max(160),
});
export const ExFactExtractionSchema = z.object({
  /** The name the character used for their ex, if any (server resolves it; null = unnamed). */
  exName: z.string().max(60).nullable().default(null),
  facts: z.array(ExFactSchema).max(4).default([]),
});
export type ExFactExtraction = z.infer<typeof ExFactExtractionSchema>;

/**
 * Player-fact extraction: concrete things the PLAYER said about THEMSELVES on a
 * date, captured as the date partner's first-hand knowledge of the player (so it
 * can later travel the gossip graph — "Mara's seeing someone, a chef apparently").
 * Unlike ex-facts the source is the PLAYER's own lines (you describing yourself is
 * not an injection risk); `sourceQuote` is still verified verbatim. Categories are
 * a fixed, low-sensitivity taxonomy.
 */
export const PlayerFactSchema = z.object({
  category: z.enum(['job', 'hobby', 'interest', 'background', 'plan']),
  /** A SHORT, neutral noun/verb phrase about the player (e.g. "is a chef", "runs
   *  marathons", "grew up by the coast", "wants to open a bookshop"). No sentences. */
  value: z.string().min(1).max(80),
  sourceQuote: z.string().min(1).max(160),
});
export const PlayerFactExtractionSchema = z.object({
  facts: z.array(PlayerFactSchema).max(4).default([]),
});
export type PlayerFactExtraction = z.infer<typeof PlayerFactExtractionSchema>;

// --- Phone: text + email generation (text-only; no stat fields) -------------

/**
 * A character's ONE casual text for the day. The server decides whether a text
 * is sent at all (a daily probability roll) and which phase it lands in — the
 * model only writes the single body and may SUGGEST a gift (server gates it).
 */
export const DailyTextPlanSchema = z.object({
  texts: z
    .array(
      z.object({
        body: z.string().min(1).max(280),
        // Required by the schema but server-owned: generateDailyTextsForDay always
        // overwrites it with a server-chosen phase, so default it (the model needn't
        // emit it, and a stray value can't fail the parse). The prompt notes it's ignored.
        phase: PhaseSchema.default('morning'),
        /** Optional gift to attach; validated + rolled server-side against a whitelist. */
        attachShopItemId: z.string().nullable().default(null),
      }),
    )
    .length(1),
});
export type DailyTextPlan = z.infer<typeof DailyTextPlanSchema>;

/** A character's short reply to the player's text. */
export const TextReplySchema = z.object({
  body: z.string().min(1).max(280),
  tone: z.enum(['warm', 'playful', 'flirty', 'neutral', 'distant', 'annoyed']).default('neutral'),
});
export type TextReply = z.infer<typeof TextReplySchema>;

/** A batch of in-world emails (from companies/strangers, never characters). */
export const EmailBatchSchema = z.object({
  emails: z
    .array(
      z.object({
        senderName: z.string().min(1).max(80),
        senderHandle: z.string().min(1).max(120),
        subject: z.string().min(1).max(140),
        body: z.string().min(1).max(1200),
      }),
    )
    .max(EMAILS_MAX_PER_DAY)
    .default([]),
});
export type EmailBatch = z.infer<typeof EmailBatchSchema>;

/** One piece of gossip a character texts the player about someone in their social web. */
export const GossipTextSchema = z.object({
  body: z.string().min(1).max(280),
});
export type GossipText = z.infer<typeof GossipTextSchema>;

/**
 * A character's text for a relationship turning point — a "we need to talk"
 * warning, a breakup, or a reconciliation reach-out. The SERVER decides which
 * beat fires (and all stat consequences); the model only writes the body.
 */
export const RelationshipBeatTextSchema = z.object({
  body: z.string().min(1).max(600),
});
export type RelationshipBeatText = z.infer<typeof RelationshipBeatTextSchema>;

/**
 * A single SMS body for the (opt-in) tragic-outcome spiral — either the
 * struggling character's withdrawn/distress text or a worried friend's check-in.
 * The act itself is NEVER described (see the crisis guardrails); the terminal
 * NOTICE is never LLM-authored — only these earlier, off-ramp messages are.
 */
export const CrisisTextSchema = z.object({
  body: z.string().min(1).max(360),
});
export type CrisisText = z.infer<typeof CrisisTextSchema>;

/** LLM-authored description of a character's private room (their personal date venue). */
export const RoomDescriptionSchema = z.object({
  description: z.string().min(1).max(900),
});
export type RoomDescription = z.infer<typeof RoomDescriptionSchema>;

/**
 * LLM-authored "happy ending" epilogue, synthesized from the chronicle when a
 * relationship reaches its committed peak. Forward-looking (life goes on) — a
 * soft win, never a game-over.
 */
export const EpilogueSchema = z.object({
  title: z.string().min(1).max(80),
  epilogue: z.string().min(1).max(2000),
});
export type Epilogue = z.infer<typeof EpilogueSchema>;

/**
 * Per-turn read of how the player's LAST message landed for this character on
 * this date. The model only judges + picks an expression; the SERVER owns the
 * running rapport value and all consequences. `engagement` is how well it landed
 * (−3 = it bombed, +3 = it really connected).
 */
export const TurnReactionSchema = z.object({
  engagement: z.number().int().min(-3).max(3),
  /** Canonical expression the UI maps to a portrait; off-list → neutral. */
  expression: ExpressionSchema.catch(DEFAULT_EXPRESSION),
  /** Brief internal reason (not shown to the player). */
  note: z.string().max(120).default(''),
});
export type TurnReaction = z.infer<typeof TurnReactionSchema>;

/**
 * Impartial read of how the PLAYER's latest TEXT landed for this character — the
 * texting analog of TurnReaction. The model judges ONLY the player's message
 * (never the character's reply), so a warm character replying nicely to an insult
 * can't launder it into a relationship gain. The SERVER owns the resulting delta
 * (see `textEngagementDelta`). `engagement` runs −3 (hostile/hurtful) .. +3
 * (genuinely warm and connecting).
 */
export const TextJudgeSchema = z.object({
  engagement: z.number().int().min(-3).max(3),
  /** True when the player's text was hostile, insulting, demeaning, or cruel. */
  hostile: z.boolean().default(false),
  /** Brief internal reason (not shown to the player). */
  note: z.string().max(120).default(''),
});
export type TextJudge = z.infer<typeof TextJudgeSchema>;

// --- Faces: social-feed generation (text only; server owns who/when/idempotency) ---

/** An NPC's social-feed post. The model writes only the text + a mood word. */
export const NpcFeedPostSchema = z.object({
  body: z.string().min(1).max(300),
  /** One-word mood/tone label (e.g. "wistful", "giddy", "wry"). */
  mood: z.string().max(40).default(''),
});
export type NpcFeedPost = z.infer<typeof NpcFeedPostSchema>;

/** An NPC's comment on a feed post. Text + a short tone label. */
export const FeedCommentDraftSchema = z.object({
  body: z.string().min(1).max(200),
  tone: z.string().max(40).default(''),
});
export type FeedCommentDraft = z.infer<typeof FeedCommentDraftSchema>;

/**
 * LLM-authored narrative profile fields (creator tool). Mirrors the new authored
 * Character fields; the server clamps lengths/counts and the editor lets the
 * creator review/edit before saving. No stat fields — purely descriptive.
 */
export const ProfileGenerationSchema = z.object({
  appearance: z.string().max(600).default(''),
  textingStyle: z.string().max(240).default(''),
  onlinePersona: z.string().max(240).default(''),
  loveLanguage: z.string().max(120).default(''),
  physicalNeeds: z.array(z.string().min(1).max(80)).max(8).default([]),
  physicalDesires: z.array(z.string().min(1).max(80)).max(8).default([]),
  physicalDislikes: z.array(z.string().min(1).max(80)).max(8).default([]),
  insecurities: z.array(z.string().min(1).max(80)).max(8).default([]),
  quirks: z.array(z.string().min(1).max(80)).max(8).default([]),
});
export type ProfileGeneration = z.infer<typeof ProfileGenerationSchema>;

// --- Character template generation (creator tool: build a whole draft from an image) ---

/**
 * A loose stat value: keep whatever number the model emits (the server clamps it
 * to 0-100 via `clampStat`), falling back to a neutral 50 only when it isn't a
 * number at all. We avoid hard validation here so one odd stat can never fail the
 * whole generation — the returned draft is always usable and creator-reviewed.
 */
const LooseStatSchema = z.number().catch(50);
const LooseDatingStatsSchema = z
  .object({
    charm: LooseStatSchema,
    empathy: LooseStatSchema,
    humor: LooseStatSchema,
    confidence: LooseStatSchema,
    intellect: LooseStatSchema,
    style: LooseStatSchema,
  })
  .catch({ charm: 50, empathy: 50, humor: 50, confidence: 50, intellect: 50, style: 50 });

/**
 * A FULL character draft generated from a reference portrait (+ world context).
 * Deliberately PERMISSIVE: enums fall back to a safe default, age below the floor
 * is lifted to the minimum, strings/arrays accept anything, and the SERVER owns
 * all bounding (`boundGeneratedTemplate`: clamp age >= 18, clamp stats, trim
 * lengths/counts). It returns a usable draft the creator reviews and edits before
 * saving — no character is created here. Mirrors the location/profile/shop drafts.
 */
export const CharacterTemplateGenerationSchema = z.object({
  name: z.string().catch(''),
  // Below-18 (or non-int) lifts to the minimum adult age; the server re-clamps too.
  age: z.number().int().min(MIN_CHARACTER_AGE).catch(MIN_CHARACTER_AGE),
  pronouns: z.string().catch('they/them'),
  gender: GenderSchema.catch('unspecified'),
  sexuality: SexualitySchema.catch('unspecified'),
  shortDescription: z.string().catch(''),
  personality: z.string().catch(''),
  speechStyle: z.string().catch(''),
  relationshipPreferences: z.string().catch(''),
  relationshipStyle: RelationshipStyleSchema.catch('monogamous'),
  likes: z.array(z.string()).catch([]),
  dislikes: z.array(z.string()).catch([]),
  goals: z.array(z.string()).catch([]),
  boundaries: z.array(z.string()).catch([]),
  appearance: z.string().catch(''),
  textingStyle: z.string().catch(''),
  onlinePersona: z.string().catch(''),
  loveLanguage: z.string().catch(''),
  physicalNeeds: z.array(z.string()).catch([]),
  physicalDesires: z.array(z.string()).catch([]),
  physicalDislikes: z.array(z.string()).catch([]),
  insecurities: z.array(z.string()).catch([]),
  quirks: z.array(z.string()).catch([]),
  datingStats: LooseDatingStatsSchema,
  /** How guarded/slow-to-warm they are (0..100); server clamps. Off-value → default. */
  guardedness: z.number().catch(GUARDEDNESS_DEFAULT),
});
export type CharacterTemplateGeneration = z.infer<typeof CharacterTemplateGenerationSchema>;

/** Server-bounded character draft returned to the editor (after clamping). Same
 *  field set as the generation, with stats guaranteed valid (0-100 ints). */
export type CharacterTemplateDraft = Omit<CharacterTemplateGeneration, 'datingStats'> & {
  datingStats: z.infer<typeof DatingStatsSchema>;
};

/** Discriminated result type returned by the structured LLM caller. */
export type StructuredResult<T> =
  | { ok: true; data: T; attempts: number }
  | { ok: false; error: string; attempts: number; lastRaw?: string };
