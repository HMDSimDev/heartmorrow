import type { RelationshipStatKey } from './stats';

/**
 * Venue economics — what a date *costs* and how a character judges the spend.
 *
 * A venue's `priceTier` (0..3) is the single lever: it maps to a money cost (the
 * server charges the per-world wallet when a real date ends) AND to a small,
 * clamped relationship nudge filtered through the character's taste. Money buys
 * date quality, but reading the person — a splurge can charm a luxury-lover and
 * mildly put off a down-to-earth one — beats it. All of this is server-owned and
 * deterministic (no LLM): the same character + tier always reacts the same way.
 */

export interface VenueTier {
  /** 0 free · 1 modest · 2 nice · 3 lavish. */
  tier: number;
  label: string;
  /** Compact UI affordance ($/$$/$$$). */
  symbol: string;
  /** Money charged to take a date here. */
  cost: number;
}

export const VENUE_TIERS: readonly VenueTier[] = [
  { tier: 0, label: 'Free', symbol: '—', cost: 0 },
  { tier: 1, label: 'Modest', symbol: '$', cost: 40 },
  { tier: 2, label: 'Nice', symbol: '$$', cost: 100 },
  { tier: 3, label: 'Lavish', symbol: '$$$', cost: 200 },
] as const;

/** Clamp any number into a valid tier index (0..3). */
export function clampTier(tier: number | null | undefined): number {
  const t = Math.round(Number.isFinite(tier as number) ? (tier as number) : 0);
  return Math.max(0, Math.min(VENUE_TIERS.length - 1, t));
}

export function venueTierMeta(tier: number | null | undefined): VenueTier {
  return VENUE_TIERS[clampTier(tier)]!;
}

/** Money it costs to take a date to a venue of this tier. */
export function venueCost(tier: number | null | undefined): number {
  return venueTierMeta(tier).cost;
}

export const VENUE_TIER_LABELS = VENUE_TIERS.map((v) => v.label);

// --- Spend taste ------------------------------------------------------------

/** How a character feels about money spent on them. */
export type SpendTaste = 'lavish' | 'grounded' | 'neutral';

/** Minimal authored shape needed to judge spend taste. */
export interface SpendTasteSource {
  loveLanguage?: string;
  likes?: string[];
  dislikes?: string[];
}

// Tokens scanned (case-insensitive substring) in likes/dislikes. Kept short and
// high-signal so an offhand word doesn't flip a character's whole taste.
const LAVISH_TOKENS = [
  'luxury', 'luxurious', 'fancy', 'fine dining', 'expensive', 'designer', 'glamour',
  'glamorous', 'upscale', 'extravagant', 'opulent', 'high-end', 'champagne', 'splurge',
  'the finer things', 'being spoiled', 'nice things',
];
const GROUNDED_TOKENS = [
  'simple', 'simplicity', 'cozy', 'homemade', 'home-cooked', 'home cooked', 'frugal',
  'thrifty', 'low-key', 'lowkey', 'nature', 'the outdoors', 'hiking', 'camping', 'picnic',
  'picnics', 'down-to-earth', 'minimalist', 'budget', 'humble', 'quiet nights', 'staying in',
];

const hasToken = (arr: string[] | undefined, tokens: string[]): boolean =>
  (arr ?? []).some((s) => {
    const v = s.toLowerCase();
    return tokens.some((t) => v.includes(t));
  });

/**
 * Derive a character's spend taste from authored fields (love language + likes /
 * dislikes). Deterministic and side-effect free. Ambiguous characters are
 * 'neutral' — they appreciate a treat but never punish a thrifty date.
 */
export function spendTasteOf(c: SpendTasteSource): SpendTaste {
  const ll = (c.loveLanguage ?? '').toLowerCase();
  let score = 0; // positive → luxury-leaning, negative → grounded-leaning.

  if (ll.includes('gift')) score += 2;
  if (ll.includes('quality time') || ll.includes('acts of service') || ll.includes('service') || ll.includes('words')) {
    score -= 1;
  }

  if (hasToken(c.likes, LAVISH_TOKENS)) score += 2;
  if (hasToken(c.likes, GROUNDED_TOKENS)) score -= 2;
  if (hasToken(c.dislikes, LAVISH_TOKENS)) score -= 2; // dislikes flashiness → grounded
  if (hasToken(c.dislikes, GROUNDED_TOKENS)) score += 1; // dislikes "cheap/boring" → leans lavish

  if (score >= 2) return 'lavish';
  if (score <= -2) return 'grounded';
  return 'neutral';
}

// --- The judged date effect -------------------------------------------------

type Delta = Partial<Record<RelationshipStatKey, number>>;

// taste → effect per tier [free, modest, nice, lavish]. Small + clamped (the
// stat-service clamp is the final authority). Empty = no nudge.
const VENUE_EFFECT: Record<SpendTaste, readonly Delta[]> = {
  // A treat is nice; a cheap night is never punished.
  neutral: [{}, {}, { affection: 1, chemistry: 1 }, { affection: 2, chemistry: 2 }],
  // Loves being spoiled; underwhelmed by a stingy date.
  lavish: [
    { affection: -1, tension: 1 },
    {},
    { affection: 2, chemistry: 2 },
    { affection: 3, chemistry: 3, comfort: 1 },
  ],
  // Charmed by thoughtful simplicity; a flashy splurge feels like too much.
  grounded: [
    { comfort: 2, affection: 2 },
    { comfort: 1, affection: 1 },
    {},
    { comfort: -2, tension: 2 },
  ],
};

/**
 * How the venue's price tier colors a date, filtered through the character's
 * spend taste — a small, clamped relationship nudge the server applies (mirrors
 * `weatherDateEffect`). Returns a fresh object (never a shared reference).
 */
export function venueDateEffect(character: SpendTasteSource, tier: number | null | undefined): Delta {
  const t = clampTier(tier);
  const taste = spendTasteOf(character);
  return { ...VENUE_EFFECT[taste][t] };
}
