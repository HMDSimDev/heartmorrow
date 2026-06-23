import { z } from 'zod';
import { GIFT_BASE_CHANCE, GIFT_MIN_WARMTH, GIFT_WARMTH_FULL } from './constants';
import { type RelationshipStatKey } from './stats';

/**
 * Social-dynamics primitives. The jealousy probability model and walkout tuning
 * land with Phase 3; for now this defines the character relationship-style flag
 * and the shared "internal flag key" predicate used to hide bookkeeping keys
 * (buffs, last-seen day, social state) from the relationship UI.
 */

export const RelationshipStyleSchema = z.enum(['monogamous', 'polyamorous']);
export type RelationshipStyle = z.infer<typeof RelationshipStyleSchema>;

export const RELATIONSHIP_STYLE_LABELS: Record<RelationshipStyle, string> = {
  monogamous: 'Monogamous',
  polyamorous: 'Polyamorous',
};

// --- NPC social graph (character → character links) -------------------------

/**
 * How one character relates to another in the world's social web. All but
 * `acquaintance` are AUTHORED; `acquaintance` is the read-time label for an edge
 * the world-sim minted (people who have simply crossed paths) — it carries low
 * weight so random encounters never drive drama like a hand-authored bond.
 */
export const CharacterLinkKindSchema = z.enum([
  'friend',
  'rival',
  'ex',
  'family',
  'partner',
  'crush',
  'roommate',
  'coworker',
  'classmate',
  'neighbor',
  'mentor',
  'acquaintance',
]);
export type CharacterLinkKind = z.infer<typeof CharacterLinkKindSchema>;

export const CHARACTER_LINK_LABELS: Record<CharacterLinkKind, string> = {
  friend: 'Friend',
  rival: 'Rival',
  ex: 'Ex',
  family: 'Family',
  partner: 'Partner',
  crush: 'Crush',
  roommate: 'Roommate',
  coworker: 'Coworker',
  classmate: 'Classmate',
  neighbor: 'Neighbor',
  mentor: 'Mentor',
  acquaintance: 'Acquaintance',
};

export const CHARACTER_LINK_ICONS: Record<CharacterLinkKind, string> = {
  friend: '🤝',
  rival: '😤',
  ex: '💔',
  family: '👪',
  partner: '💑',
  crush: '💘',
  roommate: '🛋️',
  coworker: '💼',
  classmate: '📚',
  neighbor: '🏡',
  mentor: '🧭',
  acquaintance: '👋',
};

/** A directed edge: this character considers `targetId` their `kind`. */
export const CharacterLinkSchema = z.object({
  targetId: z.string().min(1),
  kind: CharacterLinkKindSchema,
});
export type CharacterLink = z.infer<typeof CharacterLinkSchema>;

/** Find how a character (via its links) relates to a target, if at all. */
export function linkTo(links: readonly CharacterLink[], targetId: string): CharacterLink | undefined {
  return links.find((l) => l.targetId === targetId);
}

// --- NPC conversation topics (what two NPCs talk about when they meet) -------

/**
 * The FIXED taxonomy of things two NPCs might talk about when the world-sim has
 * them cross paths. Canonical (like {@link MEMORY_TAGS}) so the *selection* stays
 * deterministic and server-owned — the LLM is only handed the chosen topic's hint
 * and writes the prose, it never invents the subject. Keep this list small; each
 * topic must read naturally for ANY pair (coworkers, friends, exes, near-strangers).
 */
export const CONVERSATION_TOPICS = [
  'catching-up', // default: light small talk, how things have been
  'work', // jobs, the shift, a workplace happening
  'plans', // goals, dreams, what's next for them
  'the-past', // shared history (exes reminisce or bristle; family old times)
  'someone', // a mutual acquaintance they both know — neighborhood gossip
  'the-player', // one of them is seeing the player and it comes up
] as const;
export type ConversationTopic = (typeof CONVERSATION_TOPICS)[number];

/** A short steer handed to the scene LLM for each topic (DATA, not free rein). */
export const CONVERSATION_TOPIC_HINTS: Record<ConversationTopic, string> = {
  'catching-up': 'just caught up — how each other has been, light and ordinary',
  work: 'talked about work — their jobs, a shift, something at the workplace',
  plans: 'talked about what they each want next — a goal, a hope, a plan brewing',
  'the-past': 'touched on old times / shared history between them',
  someone: 'compared notes on someone they both know around the neighborhood',
  'the-player': 'one of them mentioned the person they have been seeing',
};

/** The signals the topic picker weighs — all derived deterministically server-side. */
export interface TopicSignals {
  /** Authored relation between the pair (ex/family color the past), if any. */
  relationKind?: CharacterLinkKind | null;
  /** Both have a job (work is plausible small talk). */
  bothEmployed: boolean;
  /** At least one has authored goals (plans/dreams are on the table). */
  eitherHasGoals: boolean;
  /** They share a mutual acquaintance worth gossiping about. */
  sharesMutual: boolean;
  /** One of them is involved with the player (the player can come up). */
  involvesPlayer: boolean;
}

/**
 * Deterministically choose what a meeting pair talked about, given a roll in
 * [0,1). Weights are data-driven so a meeting between exes leans toward 'the-past',
 * coworkers toward 'work', etc., while 'catching-up' is always a fallback. PURE —
 * same signals + same roll always yield the same topic (unit-testable, replayable).
 */
export function pickConversationTopic(signals: TopicSignals, roll: number): ConversationTopic {
  const weights: Array<{ topic: ConversationTopic; weight: number }> = [{ topic: 'catching-up', weight: 1 }];
  if (signals.involvesPlayer) weights.push({ topic: 'the-player', weight: 3 });
  if (
    signals.relationKind === 'ex' ||
    signals.relationKind === 'family' ||
    signals.relationKind === 'partner' ||
    signals.relationKind === 'roommate'
  ) {
    weights.push({ topic: 'the-past', weight: 2.5 });
  }
  if (signals.bothEmployed) weights.push({ topic: 'work', weight: 2 });
  // Coworkers reliably talk shop; mentors and classmates orbit goals and what's next.
  if (signals.relationKind === 'coworker') weights.push({ topic: 'work', weight: 2.5 });
  if (signals.relationKind === 'mentor' || signals.relationKind === 'classmate') {
    weights.push({ topic: 'plans', weight: 2 });
  }
  if (signals.eitherHasGoals) weights.push({ topic: 'plans', weight: 1.5 });
  if (signals.sharesMutual) weights.push({ topic: 'someone', weight: 1.5 });

  const total = weights.reduce((s, w) => s + w.weight, 0);
  let acc = Math.max(0, Math.min(1, roll)) * total;
  for (const w of weights) {
    acc -= w.weight;
    if (acc < 0) return w.topic;
  }
  return 'catching-up';
}

// --- NPC romance (emergent couples the world-sim forms) ---------------------

/**
 * The romance state of a world-sim NPC↔NPC edge — the love-side mirror of the
 * friendship ladder (acquaintance→friend): a budding `crush` that, sustained,
 * becomes a `together` couple. AUTHORED `partner` links live on the character, not
 * here; this is only for couples the world-sim grows during play. `none` = default.
 */
export const RomanceStateSchema = z.enum(['none', 'crush', 'together']);
export type RomanceState = z.infer<typeof RomanceStateSchema>;

/**
 * Server-owned tuning for emergent NPC romance. Deliberately conservative so the
 * town moves but stays comprehensible (at most one new spark per world-day). All
 * thresholds read against the derived edge `warmth` the world-sim already tracks.
 */
export const NPC_ROMANCE = {
  /** Edge warmth before a crush can spark. */
  crushWarmth: 20,
  /** Edge warmth before a sustained crush becomes a couple. */
  togetherWarmth: 40,
  /** Seeded-roll ceiling for a crush sparking, scaled by affinity (0..1). */
  crushBaseProb: 0.5,
  /** Max NEW crushes that may spark in one world-day (pacing guard). */
  maxNewPerDay: 1,
  /** A player love-interest must be neglected this many in-world days before an NPC
   *  can poach them — the "you snoozed, you lost" gate for contested singles. */
  poachNeglectDays: 7,
} as const;

/** The authored fields `npcAffinity` reads to gauge two people's suitability. */
export interface AffinityTraits {
  likes: readonly string[];
  dislikes: readonly string[];
  goals: readonly string[];
}

/**
 * A PURE 0..1 affinity between two people from authored overlap, so couples form on
 * suitability rather than a coin flip: shared likes and goals raise it, a like the
 * other can't stand lowers it. Symmetric and deterministic (same inputs → same score).
 */
export function npcAffinity(a: AffinityTraits, b: AffinityTraits): number {
  const norm = (xs: readonly string[]) => new Set(xs.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const aLikes = norm(a.likes);
  const bLikes = norm(b.likes);
  const aDis = norm(a.dislikes);
  const bDis = norm(b.dislikes);
  const aGoals = norm(a.goals);
  const bGoals = norm(b.goals);
  let score = 0.5;
  for (const l of aLikes) if (bLikes.has(l)) score += 0.12; // a shared passion
  for (const g of aGoals) if (bGoals.has(g)) score += 0.1; // a shared direction
  for (const l of aLikes) if (bDis.has(l)) score -= 0.15; // one loves what the other can't stand
  for (const l of bLikes) if (aDis.has(l)) score -= 0.15;
  return Math.max(0.1, Math.min(1, score));
}

// --- NPC friction (emergent fallings-out — the mirror of friend-promotion) --

/**
 * Server-owned tuning for emergent NPC fallings-out — the cooling mirror of
 * friend-promotion. A clashing, world-sim-formed pair can have a COLD meeting that
 * cools them, and once they've crossed paths enough while staying icy, fall out into
 * rivals. Conservative (at most one new fall-out per world-day). Applies ONLY to
 * derived (not hand-authored) relationships, so the world-sim never turns an authored
 * bond sour. Same authored-affinity signal that grows couples drives this.
 */
export const NPC_FRICTION = {
  /** Affinity at/above which a meeting basically never cools (compatible people warm up). */
  warmPivot: 0.45,
  /** Warmth a cold (frictional) meeting REMOVES instead of adding. */
  coolStep: 6,
  /** Meetings a pair must have crossed before a cold streak can turn them into rivals. */
  rivalMeetings: 4,
  /** At/below this edge warmth, a cold pair that's met enough becomes rivals (the fall-out). */
  rivalFloor: 8,
  /** Max new fallings-out (→ rival) per world-day. */
  maxSouringPerDay: 1,
} as const;

/**
 * PURE 0..1 chance a meeting brings FRICTION (cools the pair) rather than warmth, from
 * authored (in)compatibility: compatible people (affinity ≥ warmPivot) essentially never
 * clash, and the lower the affinity, the likelier a cold meeting. Same input → same chance.
 */
export function frictionChance(affinity: number): number {
  return Math.max(0, Math.min(0.85, (NPC_FRICTION.warmPivot - affinity) * 1.5));
}

// --- Social-web read model (the phone "Social" view) ------------------------

/**
 * One person's tie to another in the world's social web, as the UI reads it.
 * `derived: true` marks a tie the WORLD-SIM formed (a run-in acquaintance or a
 * friendship grown from repeated meetings) rather than a hand-authored link —
 * the authored character row is never mutated, so these are merged in at read
 * time from the derived `npc_edges`.
 */
export const SocialTieSchema = z.object({
  targetId: z.string().min(1),
  kind: CharacterLinkKindSchema,
  derived: z.boolean(),
  /**
   * True when THIS person never declared the tie — the target did, and we're
   * surfacing it on this card (almost always a one-sided rivalry). The owner's
   * own authored ties and world-sim-formed ties both outrank an incoming one,
   * so this only appears when no other relationship between the pair exists.
   */
  incoming: z.boolean().optional(),
});
export type SocialTie = z.infer<typeof SocialTieSchema>;

/** One character in the web, with all the ties they're part of. */
export const SocialWebNodeSchema = z.object({
  id: z.string().min(1),
  ties: z.array(SocialTieSchema),
});
export type SocialWebNode = z.infer<typeof SocialWebNodeSchema>;

/** The whole world's social web — only people who have at least one tie. */
export const SocialWebSchema = z.object({
  nodes: z.array(SocialWebNodeSchema),
});
export type SocialWeb = z.infer<typeof SocialWebSchema>;

/**
 * Meaningful bonds first, low-signal "crossed paths" last — the order the web
 * groups a person's ties in, and the order legend chips appear in.
 */
export const CHARACTER_LINK_ORDER: readonly CharacterLinkKind[] = [
  'partner',
  'crush',
  'ex',
  'family',
  'friend',
  'roommate',
  'mentor',
  'classmate',
  'coworker',
  'rival',
  'neighbor',
  'acquaintance',
];

// --- Employment (authored: what a character does for work) ------------------

/**
 * A character's job. AUTHORED content (set in the creator tool); `null` =
 * unemployed (the default). `workdays` are `deriveCalendar` dayIndex values
 * (0 = Monday … 6 = Sunday); the world-sim uses them (with `place`) to decide who
 * is at `place` on a given day. `place` is a free-text workplace KEY — characters
 * who share the same `place` string are coworkers (who tend to run into each
 * other). `shiftPhase` is authored flavor (the phase they typically work); it is
 * not yet read by availability or world-sim logic.
 */
export const EmploymentSchema = z.object({
  title: z.string().min(1).max(60),
  place: z.string().min(1).max(60),
  workdays: z.array(z.number().int().min(0).max(6)).max(7).default([0, 1, 2, 3, 4]),
  shiftPhase: z.enum(['morning', 'afternoon', 'evening']).default('morning'),
});
export type Employment = z.infer<typeof EmploymentSchema>;

/**
 * Jealousy weighting by link kind: a character cares far more about catching you
 * with their ex/rival/partner than with a stranger. Multiplies the per-candidate
 * pick weight in the jealousy roll.
 */
export const LINK_JEALOUSY_WEIGHT: Record<CharacterLinkKind, number> = {
  crush: 4,
  ex: 4,
  rival: 4,
  partner: 3,
  family: 2,
  friend: 2,
  roommate: 2,
  classmate: 1,
  coworker: 1,
  neighbor: 1,
  mentor: 1,
  acquaintance: 1,
};

/**
 * Per-link-kind daily chance that a character COMMENTS on ANOTHER character's
 * Faces post (the NPC↔NPC chatter that makes the feed feel alive). Partners,
 * friends, and family are chatty on each other's posts; exes and rivals chime in
 * rarely — and pointedly; mere world-sim acquaintances almost never do. The
 * server rolls this deterministically per (post, commenter) — see feed-service.
 */
export const FEED_NPC_COMMENT_CHANCE: Record<CharacterLinkKind, number> = {
  partner: 0.7,
  crush: 0.55,
  friend: 0.5,
  roommate: 0.5,
  family: 0.45,
  mentor: 0.4,
  classmate: 0.35,
  coworker: 0.3,
  neighbor: 0.2,
  ex: 0.18,
  rival: 0.15,
  acquaintance: 0.06,
};

/**
 * Per-link-kind chance a character REACTS (no LLM, just a reaction glyph) to
 * another character's Faces post. Slightly looser than commenting — a quiet
 * "like" is cheaper than a comment, so it happens a bit more often.
 */
export const FEED_NPC_REACT_CHANCE: Record<CharacterLinkKind, number> = {
  partner: 0.6,
  crush: 0.6,
  roommate: 0.5,
  friend: 0.5,
  family: 0.45,
  mentor: 0.42,
  classmate: 0.4,
  coworker: 0.38,
  neighbor: 0.28,
  ex: 0.2,
  rival: 0.18,
  acquaintance: 0.08,
};

/**
 * One-time "intro" warmth ripple applied to a character when the player reaches a
 * milestone/commitment with someone they're linked to: their friends/family/
 * partner warm up to you; their rivals/exes cool. Clamped + applied server-side.
 */
export const VOUCH_DELTAS: Record<CharacterLinkKind, Partial<Record<RelationshipStatKey, number>>> = {
  friend: { affection: 4, comfort: 3 },
  family: { affection: 3, trust: 3 },
  partner: { affection: 4, trust: 4 },
  roommate: { affection: 3, comfort: 3 },
  mentor: { affection: 2, trust: 3 },
  classmate: { affection: 2 },
  coworker: { affection: 2 },
  neighbor: { comfort: 1 },
  rival: { affection: -3, comfort: -2, tension: 2 },
  ex: { affection: -2, tension: 3 },
  // Someone carrying a torch for the person you just committed to takes it hard.
  crush: { affection: -3, tension: 3 },
  // A mere acquaintance doesn't vouch or sabotage — crossing paths isn't an endorsement.
  acquaintance: {},
};

// --- Texting stat effects (small, capped, can go negative) ------------------

/**
 * Per-tone relationship nudge from a character's text reply. The LLM only picks
 * the TONE; the server owns these fixed (small) deltas. Positive gains are capped
 * per in-world day (see TEXT_DAILY_GAIN_CAP) so you can't grind by spamming nice
 * texts; negative tones always apply (being rude always costs you).
 */
export const TEXT_TONE_DELTAS: Record<string, Partial<Record<RelationshipStatKey, number>>> = {
  warm: { affection: 1, comfort: 1 },
  playful: { comfort: 1, chemistry: 1 },
  flirty: { chemistry: 2, affection: 1 },
  neutral: {},
  distant: { affection: -1, comfort: -1 },
  annoyed: { comfort: -2, tension: 2 },
};

/** Max positive warmth a character can gain from texting in one in-world day. */
export const TEXT_DAILY_GAIN_CAP = 3;

const TEXT_WARMTH_KEYS: RelationshipStatKey[] = ['affection', 'trust', 'chemistry', 'comfort', 'respect'];

/** The fixed relationship delta for a reply tone (empty for unknown/neutral). */
export function textToneDelta(tone: string): Partial<Record<RelationshipStatKey, number>> {
  return TEXT_TONE_DELTAS[tone] ?? {};
}

/**
 * An IMPARTIAL judge's read of how the player's text landed (−3..+3) → a small
 * relationship nudge. This is the source of truth for texting stat changes: the
 * server owns the delta from an impartial read of the PLAYER's message, NOT from
 * the character's self-reported reply tone (a warm character replies warmly even
 * to an insult, which previously laundered hostility into a warmth gain). Positive
 * warmth is still capped per in-world day (see positiveWarmth/TEXT_DAILY_GAIN_CAP);
 * negative reads always apply — being rude over text costs you, just like a date.
 */
export function textEngagementDelta(engagement: number): Partial<Record<RelationshipStatKey, number>> {
  switch (Math.max(-3, Math.min(3, Math.round(engagement)))) {
    case 3:
      return { affection: 2, comfort: 1, chemistry: 1 };
    case 2:
      return { affection: 1, comfort: 1 };
    case 1:
      return { comfort: 1 };
    case -1:
      return { comfort: -1 };
    case -2:
      return { affection: -1, comfort: -1, tension: 2 };
    case -3:
      return { affection: -2, comfort: -2, tension: 4 };
    default:
      return {}; // 0 — neutral/forgettable
  }
}

/** Sum of positive warmth-stat points in a delta — what the daily cap limits. */
export function positiveWarmth(delta: Partial<Record<RelationshipStatKey, number>>): number {
  return TEXT_WARMTH_KEYS.reduce((sum, k) => sum + Math.max(0, delta[k] ?? 0), 0);
}

/**
 * Trim a text delta's POSITIVE warmth so it carries at most `cap` points (the
 * remaining daily headroom). Warmth keys are reduced in a fixed order; negative
 * components and tension are never touched (being rude always lands in full).
 * Returns the trimmed delta plus the positive warmth it actually carries, so the
 * caller can record exactly what was spent against the daily cap.
 */
export function capWarmthGain(
  delta: Partial<Record<RelationshipStatKey, number>>,
  cap: number,
): { delta: Partial<Record<RelationshipStatKey, number>>; applied: number } {
  const out: Partial<Record<RelationshipStatKey, number>> = { ...delta };
  let budget = Math.max(0, cap);
  for (const k of TEXT_WARMTH_KEYS) {
    const v = out[k] ?? 0;
    if (v <= 0) continue;
    const keep = Math.min(v, budget);
    budget -= keep;
    if (keep > 0) out[k] = keep;
    else delete out[k];
  }
  return { delta: out, applied: Math.max(0, cap) - budget };
}

/** Warmth-stat shape (subset of Relationship) used to describe a relationship stage. */
export type WarmthStats = {
  affection: number;
  trust: number;
  chemistry: number;
  comfort: number;
  respect: number;
  tension: number;
};

/**
 * "Warmth" — the mean of the five positive bonding stats (affection, trust,
 * chemistry, comfort, respect). Curiosity and tension are deliberately
 * EXCLUDED. This is the single source of truth for relationship closeness, used
 * by both `relationshipStage` and `intimacyAllowed` so they can never drift.
 */
export function warmthOf(rel: WarmthStats): number {
  return (rel.affection + rel.trust + rel.chemistry + rel.comfort + rel.respect) / 5;
}

/**
 * The ordered warmth bands — the SINGLE source of truth for relationship
 * closeness. `relationshipStage`, milestone detection, and the DTR ladder all
 * derive from this so labels and thresholds can never drift apart. Each band's
 * `min` is its inclusive lower warmth bound.
 */
export const WARMTH_BANDS = [
  {
    key: 'near-strangers',
    min: 0,
    label: 'near-strangers',
    guidance:
      "You barely know each other. Keep it brief, polite, and a little reserved — NO pet names, NO intimacy, NO assuming closeness. You might still be a bit guarded or formal.",
  },
  {
    key: 'acquaintances',
    min: 10,
    label: 'acquaintances',
    guidance: 'You are just getting to know each other. Friendly and light, curious but not yet affectionate.',
  },
  {
    key: 'warming-up',
    min: 25,
    label: 'warming up',
    guidance: 'A connection is budding. Warm and a little playful, still feeling things out — not yet a couple.',
  },
  {
    key: 'getting-close',
    min: 45,
    label: 'getting close',
    guidance: 'You are comfortable together now. Familiar and warm, can be lightly flirty.',
  },
  {
    key: 'close',
    min: 65,
    label: 'close',
    guidance: 'You are clearly close. Affectionate, familiar, openly fond of each other.',
  },
  {
    key: 'sweethearts',
    min: 82,
    label: 'sweethearts',
    guidance: 'You are sweethearts — openly affectionate and intimate (always tasteful).',
  },
] as const;

export type WarmthBandKey = (typeof WARMTH_BANDS)[number]['key'];

/** The warmth-band crossings that are worth celebrating as milestones. */
export const MILESTONE_BANDS: readonly WarmthBandKey[] = ['getting-close', 'close', 'sweethearts'];

/** The band a given relationship's warmth falls into. */
export function warmthBand(rel: WarmthStats): WarmthBandKey {
  const w = warmthOf(rel);
  let band: WarmthBandKey = WARMTH_BANDS[0].key;
  for (const b of WARMTH_BANDS) {
    if (w >= b.min) band = b.key;
  }
  return band;
}

/** Ordinal position of a band (higher = warmer). -1 if unknown. */
export function bandIndex(key: WarmthBandKey): number {
  return WARMTH_BANDS.findIndex((b) => b.key === key);
}

// --- Gender + sexuality (attraction compatibility) --------------------------

/** A character's / player's gender — separate from pronouns. */
export const GenderSchema = z.enum(['unspecified', 'male', 'female', 'nonbinary']);
export type Gender = z.infer<typeof GenderSchema>;

export const GENDER_LABELS: Record<Gender, string> = {
  unspecified: 'Prefer not to say',
  male: 'Male',
  female: 'Female',
  nonbinary: 'Non-binary',
};

/** Who someone is romantically/sexually oriented toward. */
export const SexualitySchema = z.enum(['unspecified', 'straight', 'gay', 'bisexual']);
export type Sexuality = z.infer<typeof SexualitySchema>;

export const SEXUALITY_LABELS: Record<Sexuality, string> = {
  unspecified: 'Unspecified / private',
  straight: 'Straight',
  gay: 'Gay / Lesbian',
  bisexual: 'Bisexual',
};

/** The gender + sexuality pair that decides who someone could be drawn to. */
export interface Orientation {
  gender: Gender;
  sexuality: Sexuality;
}

/**
 * A natural-language self-descriptor a character would use ("a lesbian", "gay",
 * "straight", "bisexual"), or '' when unspecified. Drives the orientation reveal.
 */
export function orientationLabel(gender: Gender, sexuality: Sexuality): string {
  if (sexuality === 'gay') return gender === 'female' ? 'a lesbian' : 'gay';
  if (sexuality === 'bisexual') return 'bisexual';
  if (sexuality === 'straight') return 'straight';
  return '';
}

/**
 * Is `viewer` plausibly attracted to someone of `targetGender`? Deliberately
 * PERMISSIVE whenever information is missing or inherently broad — the gate only
 * engages for a fully-specified, binary, straight/gay MISMATCH. So players who
 * never set an orientation (and bisexual / non-binary / unspecified people) are
 * never gated; the feature is strictly opt-in.
 */
export function attractedToGender(viewer: Orientation, targetGender: Gender): boolean {
  if (viewer.sexuality === 'unspecified' || viewer.sexuality === 'bisexual') return true;
  if (viewer.gender === 'unspecified' || viewer.gender === 'nonbinary') return true;
  if (targetGender === 'unspecified' || targetGender === 'nonbinary') return true;
  return viewer.sexuality === 'straight' ? targetGender !== viewer.gender : targetGender === viewer.gender;
}

export interface MutualAttraction {
  /** Both are plausibly attracted to each other (romance can progress). */
  mutual: boolean;
  /** Is `a` attracted to `b`'s gender? */
  aIntoB: boolean;
  /** Is `b` attracted to `a`'s gender? */
  bIntoA: boolean;
}

/** Two-sided attraction read between two people. */
export function mutualAttraction(a: Orientation, b: Orientation): MutualAttraction {
  const aIntoB = attractedToGender(a, b.gender);
  const bIntoA = attractedToGender(b, a.gender);
  return { mutual: aIntoB && bIntoA, aIntoB, bIntoA };
}

/**
 * The warmth band an orientation-INCOMPATIBLE pairing can never grow past. At
 * 'acquaintances' the relationship stays friendly-but-platonic: it never reaches
 * the romantic 'getting-close' band, where dating, milestones, jealousy, and
 * intimacy all begin. Raise this (e.g. to 'warming-up') to let incompatible pairs
 * become closer friends before the ceiling bites.
 */
export const INCOMPATIBLE_MAX_BAND: WarmthBandKey = 'acquaintances';

/** The numeric warmth ceiling derived from {@link INCOMPATIBLE_MAX_BAND} — just
 *  below the start of the next, warmer band. */
export function incompatibleWarmthCap(): number {
  const next = WARMTH_BANDS[bandIndex(INCOMPATIBLE_MAX_BAND) + 1];
  return next ? next.min - 1 : 100;
}

/**
 * Describe where a relationship stands, in words + a behavioral hint. Used to
 * keep the LLM's tone (texts, replies, dialogue) consistent with the ACTUAL
 * relationship — e.g. strangers shouldn't text like long-time sweethearts.
 */
export function relationshipStage(rel: WarmthStats): { label: string; guidance: string } {
  const band = WARMTH_BANDS.find((b) => b.key === warmthBand(rel)) ?? WARMTH_BANDS[0];
  let guidance = band.guidance;
  if (rel.tension >= 60) guidance += ' Right now there is real tension between you — be cooler, guarded, or short.';
  return { label: band.label, guidance };
}

// --- Intimacy gate (when explicit/intimate content is permissible) ----------

/**
 * The relationship must be at least this warm — and calmer than this tension —
 * before intimacy is permissible. `minWarmth: 65` is exactly the lower bound of
 * the `relationshipStage` "close" band (so "close" or "sweethearts" qualify, but
 * "getting close" and below do not). `maxTension: 40` keeps intimacy suppressed
 * after a fight even when warmth is high. This gate ONLY decides permissibility;
 * whether explicit content is actually generated additionally requires the
 * server-side `nsfwEnabled` toggle (and an uncensored model). Content always
 * stays within the character's stated boundaries.
 */
export const INTIMACY_THRESHOLD = { minWarmth: 65, maxTension: 40 } as const;

/** True when the bond is close enough — and calm enough — for intimacy. */
export function intimacyAllowed(rel: WarmthStats): boolean {
  return warmthOf(rel) >= INTIMACY_THRESHOLD.minWarmth && rel.tension <= INTIMACY_THRESHOLD.maxTension;
}

/**
 * Per-text chance a character attaches a gift, WEIGHTED by relationship warmth.
 * Zero below GIFT_MIN_WARMTH (you barely know each other → no gifts), scaling
 * linearly up to GIFT_BASE_CHANCE at GIFT_WARMTH_FULL (sweethearts). Gifts are
 * meant to be rare and feel earned. The server rolls this, not the LLM.
 */
export function giftChance(rel: Pick<WarmthStats, 'affection' | 'trust' | 'chemistry' | 'comfort' | 'respect'>): number {
  const w = warmthOf({ ...rel, tension: 0 });
  if (w < GIFT_MIN_WARMTH) return 0;
  const t = Math.min(1, (w - GIFT_MIN_WARMTH) / (GIFT_WARMTH_FULL - GIFT_MIN_WARMTH));
  return GIFT_BASE_CHANCE * t;
}

// --- Define-the-Relationship ladder (player-driven commitments) -------------

/** Minimal structural shape for reading relationship flags without importing the
 *  full Relationship type (which would create an import cycle with entities). */
type FlagBag = { flags: Record<string, boolean | number | string> };

/** The player-facing commitment status, stored in the `status` relationship flag. */
export const RelationshipStatusSchema = z.enum(['none', 'dating', 'exclusive', 'cohabiting']);
export type RelationshipStatus = z.infer<typeof RelationshipStatusSchema>;

/** Order of the commitment ladder; index drives "what's the next rung". */
export const STATUS_ORDER: readonly RelationshipStatus[] = ['none', 'dating', 'exclusive', 'cohabiting'];

export const RELATIONSHIP_STATUS_LABELS: Record<RelationshipStatus, string> = {
  none: 'Unattached',
  dating: 'Dating',
  exclusive: 'Exclusive',
  cohabiting: 'Living together',
};

/**
 * The rungs of the ladder. Each rung is unlocked once warmth reaches its
 * `requiresBand` milestone; `verb` is woven into the DTR prompt + the moment.
 */
export const DTR_RUNGS = [
  { status: 'dating', requiresBand: 'getting-close', label: 'Ask them out', verb: 'asked you to start dating' },
  { status: 'exclusive', requiresBand: 'close', label: 'Become exclusive', verb: 'asked to be exclusive' },
  { status: 'cohabiting', requiresBand: 'sweethearts', label: 'Move in together', verb: 'asked you to move in together' },
] as const satisfies ReadonlyArray<{ status: RelationshipStatus; requiresBand: WarmthBandKey; label: string; verb: string }>;
export type DtrRung = (typeof DTR_RUNGS)[number];

/** Days a character won't entertain another DTR attempt after one. */
export const DTR_COOLDOWN_DAYS = 3;

/** Read the current commitment status from relationship flags (default 'none'). */
export function currentStatus(rel: FlagBag): RelationshipStatus {
  const parsed = RelationshipStatusSchema.safeParse(rel.flags['status']);
  return parsed.success ? parsed.data : 'none';
}

/** True once the relationship is exclusive or cohabiting (drives committed jealousy). */
export function isCommitted(rel: FlagBag): boolean {
  const s = currentStatus(rel);
  return s === 'exclusive' || s === 'cohabiting';
}

/**
 * The next commitment rung the player could pursue, plus whether warmth has
 * unlocked it. Returns null once the top of the ladder is reached.
 */
export function nextDtrRung(rel: WarmthStats & FlagBag): { rung: DtrRung; warmthMet: boolean } | null {
  const idx = STATUS_ORDER.indexOf(currentStatus(rel));
  const rung = DTR_RUNGS[idx]; // none→dating, dating→exclusive, exclusive→cohabiting
  if (!rung) return null;
  const warmthMet = bandIndex(warmthBand(rel)) >= bandIndex(rung.requiresBand);
  return { rung, warmthMet };
}

// --- Endgame: strain, on-the-rocks & breakups -------------------------------

/**
 * Per-status neglect tuning. Commitment raises the stakes: you can't ignore a
 * live-in partner as long as a casual date, and when you do neglect them the
 * relationship drifts faster. `none` keeps the original 14-day, ×1 behavior so
 * uncommitted/never-defined relationships are unchanged.
 */
export const NEGLECT_BY_STATUS: Record<RelationshipStatus, { graceDays: number; decayMult: number }> = {
  none: { graceDays: 14, decayMult: 1 },
  dating: { graceDays: 10, decayMult: 1 },
  exclusive: { graceDays: 7, decayMult: 1.5 },
  cohabiting: { graceDays: 4, decayMult: 2 },
};

/** Neglect grace + decay multiplier for a status (falls back to `none`). */
export function neglectTuningFor(status: RelationshipStatus): { graceDays: number; decayMult: number } {
  return NEGLECT_BY_STATUS[status] ?? NEGLECT_BY_STATUS.none;
}

/**
 * The warmth a committed relationship must SUSTAIN (and the tension it must stay
 * under) to stay healthy. The more committed you are, the more it takes — a
 * cohabiting partner expects far more closeness than someone you've just started
 * dating. Fall below the floor (or above the ceiling) and the relationship goes
 * "on the rocks", then breaks up if it isn't repaired. Uncommitted ('none')
 * relationships never break up — they only cool off via neglect decay.
 */
export const BREAKUP_THRESHOLD: Record<Exclude<RelationshipStatus, 'none'>, { warmthFloor: number; tensionCeil: number }> = {
  dating: { warmthFloor: 22, tensionCeil: 72 },
  exclusive: { warmthFloor: 34, tensionCeil: 66 },
  cohabiting: { warmthFloor: 46, tensionCeil: 60 },
};

/** Days a relationship can sit "on the rocks" before it breaks up if not repaired. */
export const ROCKS_GRACE_DAYS = 3;
/** A catastrophic single date — warmth/tension this far past the line — breaks up immediately (no warning). */
export const BREAKUP_HARD_MARGIN = 12;
/** Days a broken-up character needs before they'll consider seeing you again. */
export const RECONCILE_COOLDOWN_DAYS = 3;
/** Warmth a broken-up relationship must climb back to (after the cooldown) to reconcile. */
export const RECONCILE_WARMTH = 50;
/** Each past breakup scars the bond: the thresholds stiffen by this much per breakup… */
export const BREAKUP_SCAR_STEP = 5;
/** …capped here, so winning someone back never becomes outright impossible. */
export const BREAKUP_SCAR_MAX = 15;

/**
 * The scar-adjusted warmth floor + tension ceiling for a committed status.
 * Returns null for 'none' (uncommitted relationships don't break up). Each prior
 * breakup raises the warmth floor and lowers the tension ceiling — a relationship
 * that has broken before is more fragile the next time around.
 */
export function breakupThresholdFor(
  status: RelationshipStatus,
  priorBreakups = 0,
): { warmthFloor: number; tensionCeil: number } | null {
  if (status === 'none') return null;
  const base = BREAKUP_THRESHOLD[status];
  const scar = Math.min(BREAKUP_SCAR_MAX, Math.max(0, priorBreakups) * BREAKUP_SCAR_STEP);
  return { warmthFloor: base.warmthFloor + scar, tensionCeil: Math.max(40, base.tensionCeil - scar) };
}

/** True once a character has broken up with the player (a cold/estranged state). */
export function isBrokenUp(rel: FlagBag): boolean {
  return rel.flags['state:brokenUp'] === true;
}

/** True while a committed relationship is "on the rocks" (a warning before a breakup). */
export function isOnTheRocks(rel: FlagBag): boolean {
  return rel.flags['state:onTheRocks'] === true;
}

/** Max tension at which a relationship still counts as calm/settled (shared with intimacy). */
export const ENDING_MAX_TENSION = 40;

/**
 * Whether the relationship has reached its committed peak — the "happy ending"
 * (a soft win): living together, deeply close (sweethearts), calm, and not
 * estranged. Reaching it never locks anything; you can keep playing.
 */
export function endingEligible(rel: WarmthStats & FlagBag): boolean {
  return (
    currentStatus(rel) === 'cohabiting' &&
    bandIndex(warmthBand(rel)) >= bandIndex('sweethearts') &&
    rel.tension <= ENDING_MAX_TENSION &&
    !isBrokenUp(rel) &&
    !isOnTheRocks(rel)
  );
}

// --- Walkout (character ends a date over egregious behavior) ----------------

/** Relationship penalty applied when a character walks out of a date. */
export const WALKOUT_PENALTY = { affection: -8, respect: -10, comfort: -6, tension: 15 } as const;
/** Min in-world days between walkouts for a character (avoids spam). */
export const WALKOUT_COOLDOWN_DAYS = 1;

// --- Jealousy (monogamous characters discovering you're seeing others) ------

/**
 * A character only feels jealous once there's a real bond to protect — seeing
 * other people can't sting someone who barely knows you. This is the lower
 * bound of the `getting-close` warmth band (where `dating` status also unlocks),
 * so near-strangers, acquaintances, and merely warming-up connections never roll
 * jealousy. Casual jealousy lives in the 45–65 range; committed jealousy above.
 */
export const JEALOUSY_MIN_WARMTH = 45;

export const JEALOUSY = {
  /** Window (in-world days) for counting "other people you've seen lately". */
  recencyDays: 7,
  /** Min days between jealousy rolls for a character. */
  cooldownDays: 3,
  base: 0.15,
  perOtherDate: 0.2,
  max: 0.7,
} as const;

/**
 * Once you are EXCLUSIVE/cohabiting, getting caught seeing others is near-certain
 * and stings far more — commitment raises the stakes. Pre-exclusive play keeps
 * the milder `JEALOUSY` model above unchanged.
 */
export const JEALOUSY_COMMITTED = {
  recencyDays: 7,
  cooldownDays: 3,
  base: 0.6,
  perOtherDate: 0.3,
  max: 0.95,
} as const;

/** Penalty applied when a monogamous (non-exclusive) character's jealousy triggers. */
export const JEALOUSY_PENALTY = { affection: -6, trust: -8, comfort: -5, tension: 10 } as const;

/** Harsher penalty when an EXCLUSIVE partner catches you — a real betrayal. */
export const JEALOUSY_PENALTY_COMMITTED = { affection: -12, trust: -15, comfort: -8, tension: 18 } as const;

/** Chance a monogamous character "finds out" given how many others you've seen lately. */
export function jealousyProbability(otherRecentDates: number, committed = false): number {
  if (otherRecentDates <= 0) return 0;
  const t = committed ? JEALOUSY_COMMITTED : JEALOUSY;
  return Math.min(t.max, t.base + t.perOtherDate * otherRecentDates);
}

/**
 * True for relationship-flag keys that are internal bookkeeping (not player-
 * facing story flags). Supersedes the old `isBuffFlagKey`.
 */
export function isInternalFlagKey(key: string): boolean {
  return (
    key.startsWith('buff:') ||
    key.startsWith('buffAmt:') ||
    key === 'lastSeenDay' ||
    key === 'status' ||
    key.startsWith('state:') ||
    key.startsWith('walkout:') ||
    key.startsWith('jealousy:') ||
    key.startsWith('together:') ||
    key.startsWith('milestone:') ||
    key.startsWith('dtr:') ||
    key.startsWith('vouch:') ||
    key.startsWith('text:') ||
    key.startsWith('rocks:') ||
    key.startsWith('breakup:') ||
    key.startsWith('beat:') ||
    key.startsWith('harm:')
  );
}

/** Friendly labels for well-known non-internal story flags. */
export const STORY_FLAG_LABELS: Record<string, string> = {
  metParents: 'Met their parents',
  metFriends: 'Met their friends',
  saidILoveYou: 'Said "I love you"',
  firstKiss: 'Shared a first kiss',
  sharedASecret: 'Shared a secret',
  movedIn: 'Moved in together',
  engaged: 'Got engaged',
};

/**
 * The canonical set of player-facing STORY FLAGS an item effect or the date
 * evaluator may set. Free-form flags are non-deterministic and unmappable, so
 * these are the only ones the LLM/items may use (the server drops the rest).
 */
export const STORY_FLAGS = [
  'metParents',
  'metFriends',
  'saidILoveYou',
  'firstKiss',
  'sharedASecret',
  'movedIn',
  'engaged',
] as const;
export type StoryFlag = (typeof STORY_FLAGS)[number];
export const StoryFlagSchema = z.enum(STORY_FLAGS);

export function isStoryFlag(value: unknown): value is StoryFlag {
  return typeof value === 'string' && (STORY_FLAGS as readonly string[]).includes(value);
}

/**
 * Turn a player-facing story flag into a human-readable phrase, or null if it
 * carries no meaning worth showing (so callers can hide it rather than dump a
 * raw `key:value`). Never shows internal bookkeeping (filter with
 * {@link isInternalFlagKey} first).
 */
export function humanizeStoryFlag(key: string, value: unknown): string | null {
  if (value === false || value === null || value === undefined || value === '') return null;
  const label =
    STORY_FLAG_LABELS[key] ??
    key
      .replace(/[:_]/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/^\w/, (c) => c.toUpperCase());
  // Boolean-true flags read as a standalone fact; valued flags append the value.
  if (value === true) return label;
  if (typeof value === 'number' || typeof value === 'string') return `${label}: ${value}`;
  return label;
}
