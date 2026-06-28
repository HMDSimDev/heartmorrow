import { z } from 'zod';
import { QUEST } from './constants';
import { DATING_STAT_KEYS } from './stats';
import {
  DifficultyBandSchema,
  EffectOpSchema,
  GoalKindSchema,
  GoalOutcomeSchema,
  QuestFactionSchema,
  QuestStatusSchema,
  QuestVerbSchema,
  QUEST_VERBS,
  type DifficultyBand,
  type OutcomeGrade,
  type QuestFaction,
  type QuestStatus,
  type QuestVerb,
} from './vocab';

/**
 * Wayfarer quest mode — the PURE, seeded referee.
 *
 * Mirrors `gambling.ts`/`wealth.ts`: no persistence, no clock, no LLM, and NO
 * internal randomness — every check takes its seeded `roll` as a parameter. The
 * server hashes a stable seed and feeds the roll; tests feed a stubbed one. The
 * referee is the ONLY thing that mutates quest state, and it is fully
 * deterministic given `(state, graph, action, roll)`.
 *
 * The LLM lives at the EDGES (interpret freeform text → a logged `QuestAction`;
 * narrate the already-decided `QuestOutcome` → prose). It never decides the grade
 * (the roll does), never mints an effect the node's affordance menu + caps didn't
 * authorise, and never decides when a quest ends (a deterministic post-step does).
 * See `docs/quest-mode-plan.md` for the full spec.
 */

// --- Effects: the closed consequence grammar over the state vector ----------

/**
 * A single typed mutation. Stored permissively (op + the union of all operands)
 * so an authored composition, a logged LLM proposal, and a persisted transcript
 * all share one shape; the referee reads only the fields its `op` cares about.
 */
export const EffectSchema = z.object({
  op: EffectOpSchema,
  /** setFlag / clearFlag */
  flag: z.string().optional(),
  /** moveEntityToFaction / adjustStat(entity) */
  entityId: z.string().optional(),
  /** moveEntityToFaction */
  faction: QuestFactionSchema.optional(),
  /** adjustWarmth — the dated character this routes warmth to (NOT a scene entity). */
  characterId: z.string().optional(),
  /** adjustStat — which stat ('hp' / 'disposition' on an entity, else a player stat). */
  key: z.string().optional(),
  /** adjustStat / adjustWarmth — signed magnitude. */
  delta: z.number().optional(),
  /** grantItem / removeItem */
  itemId: z.string().optional(),
  qty: z.number().optional(),
  /** addMoney */
  amount: z.number().optional(),
  /** moveToNode */
  nodeId: z.string().optional(),
  /** endScene */
  status: QuestStatusSchema.optional(),
});
export type Effect = z.infer<typeof EffectSchema>;

// --- State predicates (compile authored goals / edges over QuestState) ------

export const PredicateKindSchema = z.enum([
  'flag',
  'entityFaction',
  'entityHp',
  'entityDisposition',
  'hasItem',
  'atNode',
  'turnGte',
  'always',
  // --- compound (one level over leaf clauses) ---
  'all', // every clause is true (AND)
  'any', // some clause is true (OR)
]);
export type PredicateKind = z.infer<typeof PredicateKindSchema>;

/** The fields of a single (non-compound) condition. */
const leafPredicateShape = {
  kind: PredicateKindSchema,
  flag: z.string().optional(),
  entityId: z.string().optional(),
  faction: QuestFactionSchema.optional(),
  itemId: z.string().optional(),
  nodeId: z.string().optional(),
  /** Comparison direction for the numeric kinds. */
  op: z.enum(['lte', 'gte']).optional(),
  value: z.number().optional(),
  /** Invert the result (so `flag` can express "flag is NOT set"). */
  negate: z.boolean().optional(),
} as const;

/** A LEAF condition — no nested `clauses`. Compound predicates hold only leaves, so the
 *  predicate tree is at most ONE level deep: enough for "X AND Y" / "X OR (NOT Y)", and
 *  deliberately NON-recursive so `z.infer` works and the generation JSON-schema stays
 *  expressible (a recursive z.lazy schema collapses under zod-to-json-schema). */
export const LeafPredicateSchema = z.object(leafPredicateShape);
export type LeafPredicate = z.infer<typeof LeafPredicateSchema>;

/** A state predicate: a leaf condition, OR a compound (`kind:'all'|'any'`) whose `clauses`
 *  are leaves. `negate` inverts either. Compiles authored goals / edges / affordance
 *  preconditions over QuestState. */
export const StatePredicateSchema = z.object({
  ...leafPredicateShape,
  /** For kind 'all' (AND) / 'any' (OR): the sub-conditions (each a LEAF). Ignored otherwise. */
  clauses: z.array(LeafPredicateSchema).optional(),
});
export type StatePredicate = z.infer<typeof StatePredicateSchema>;

// --- The runtime state vector (this is the ENTIRE state space) --------------

export const QuestEntityStateSchema = z.object({
  id: z.string().min(1),
  /** Display name (denormalised from the authored def for narration/UI). */
  name: z.string().default(''),
  /** Short description for the narrator — a character's persona or an object's nature
   *  (denormalised from the def). */
  description: z.string().default(''),
  faction: QuestFactionSchema.default('neutral'),
  disposition: z.number().int().min(-100).max(100).default(0),
  hp: z.number().int().min(0).max(QUEST.MAX_HP).optional(),
  flags: z.array(z.string()).default([]),
});
export type QuestEntityState = z.infer<typeof QuestEntityStateSchema>;

export const QuestStateSchema = z.object({
  nodeId: z.string().min(1),
  entities: z.array(QuestEntityStateSchema).default([]),
  /** Scene/world-soft flags, quest-namespaced (never the global romance ladder). */
  flags: z.array(z.string()).default([]),
  inventory: z
    .array(z.object({ itemId: z.string().min(1), qty: z.number().int().min(0).default(1) }))
    .default([]),
  /** Player quest stats (charm/grit/wits…), 0..100, clamped. Internal `_` keys
   *  hold bookkeeping (accrued money, stall counter) so the vector stays flat. */
  stats: z.record(z.string(), z.number()).default({}),
  turn: z.number().int().min(0).default(0),
});
export type QuestState = z.infer<typeof QuestStateSchema>;

// --- Authored content (inside a quest's graph_json) -------------------------

export const QuestEntityDefSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  /** A short description handed to the narrator — a person's persona ("young barista,
   *  neurotic and high-strung") or an object's nature ("a battered strongbox, rusted
   *  shut") — so it can portray the entity beyond its name. */
  description: z.string().default(''),
  faction: QuestFactionSchema.default('neutral'),
  disposition: z.number().int().min(-100).max(100).default(0),
  hp: z.number().int().min(0).max(QUEST.MAX_HP).optional(),
});
export type QuestEntityDef = z.infer<typeof QuestEntityDefSchema>;

/** The per-grade menu of effect compositions an affordance authorises. */
export const AffordanceEffectsSchema = z.object({
  success: z.array(EffectSchema).default([]),
  partial: z.array(EffectSchema).default([]),
  fail: z.array(EffectSchema).default([]),
  complication: z.array(EffectSchema).default([]),
});
export type AffordanceEffects = z.infer<typeof AffordanceEffectsSchema>;

/**
 * What is POSSIBLE at a node: a verb, the player stat it tests, the default
 * difficulty band, a display hint, and — the contract — the bounded effect
 * compositions each outcome grade may draw from. Authoring an OPEN scene = a
 * generous affordance menu, not a scripted line.
 */
export const NodeAffordanceSchema = z.object({
  verb: QuestVerbSchema,
  stat: z.string().default('grit'),
  difficulty: DifficultyBandSchema,
  hint: z.string().default(''),
  effects: AffordanceEffectsSchema.default({}),
  /** OPTIONAL precondition: this approach is offered only when the predicate holds in the
   *  current state (a gate / unlock; absent = always available). A one-shot "tried once,
   *  then gone" approach = `{kind:'flag', flag:'x_tried', negate:true}` here + the approach's
   *  own effects set `x_tried`. A player-CHOSEN conditional move = a gated `move` approach
   *  whose success carries `moveToNode` (distinct from an auto-firing edge). */
  when: StatePredicateSchema.optional(),
});
export type NodeAffordance = z.infer<typeof NodeAffordanceSchema>;

export const QuestNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.string().default('scene'),
  /** Display-only scene text (untrusted authored data, never a prompt instruction). */
  setup: z.string().default(''),
  entities: z.array(QuestEntityDefSchema).default([]),
  affordances: z.array(NodeAffordanceSchema).default([]),
  /** Authored routing, read by PREDICATE (soft-layer emergence in Phase 1). */
  edges: z.array(z.object({ when: StatePredicateSchema, to: z.string().min(1) })).default([]),
  isTerminal: z.boolean().default(false),
});
export type QuestNode = z.infer<typeof QuestNodeSchema>;

export const QuestGoalSchema = z.object({
  id: z.string().min(1),
  kind: GoalKindSchema,
  outcome: GoalOutcomeSchema,
  predicate: StatePredicateSchema,
  label: z.string().default(''),
});
export type QuestGoal = z.infer<typeof QuestGoalSchema>;

export const QuestGraphSchema = z.object({
  entryNodeId: z.string().min(1),
  nodes: z.array(QuestNodeSchema).min(1),
  goals: z.array(QuestGoalSchema).default([]),
  maxTurns: z.number().int().min(1).max(QUEST.MAX_TURNS_CEILING).default(QUEST.DEFAULT_MAX_TURNS),
  /** What hitting `maxTurns` with no goal fired resolves to (usually a soft fail). */
  timeoutOutcome: QuestStatusSchema.default('resolved'),
});
export type QuestGraph = z.infer<typeof QuestGraphSchema>;

// --- The Interpreter's (logged) proposal ------------------------------------

export const QuestActionSchema = z.object({
  verb: QuestVerbSchema,
  stat: z.string().default('grit'),
  difficulty: DifficultyBandSchema,
  /** Optional scene entity the action targets. */
  targetEntityId: z.string().optional(),
  /** The composition the Interpreter PROPOSES — validated/clamped, never trusted. */
  proposedEffects: z.array(EffectSchema).default([]),
  /** The LLM's short internal note (not load-bearing; aids narration). */
  rationale: z.string().default(''),
});
export type QuestAction = z.infer<typeof QuestActionSchema>;

// --- The referee's result ---------------------------------------------------

export interface QuestOutcome {
  grade: OutcomeGrade;
  /** Effects actually applied after validation + proportionality + caps. */
  appliedEffects: Effect[];
  /** Proposed-but-dropped (off-menu / over-tier / over-cap) — for telemetry. */
  rejected: Effect[];
  /** Canonical expression for the narrator/portrait. */
  expression: string;
  /** True once the referee ended the scene (goal fired / turn cap / stall). */
  ended: boolean;
  /** A do-nothing beat (off-menu / non-diegetic input): no roll, no effects, no
   *  turn consumed. The client hides the grade chip. */
  neutral?: boolean;
  /** A neutral beat the NARRATOR still voices in-fiction (a `talk` reply, or a
   *  description of an off-menu attempt coming to nothing) — rendered like a normal
   *  beat, not muted. Only an inert `noop` (false) uses the fixed safe line. */
  voiced?: boolean;
  /** A neutral beat where the verb matched an approach that exists but is GATED (its `when`
   *  precondition isn't met yet) — so the narrator voices "the way isn't open yet" rather
   *  than the generic off-menu line. */
  gated?: boolean;
  endStatus?: QuestStatus;
  /** Which authored goal fired (if any), for the resolution screen. */
  endGoal?: { outcome: 'win' | 'lose'; label: string };
}

// ============================================================================
// Proportionality — the single most important balance dial (plan §5.3).
// ============================================================================

export type EffectTier = 'cosmetic' | 'material' | 'heavy' | 'spine';

/** Which effect tiers a difficulty band may unlock. Trivial framings cannot mint
 *  big outcomes; big outcomes REQUIRE (and thereby cost) a hard/desperate check. */
const TIERS_BY_BAND: Record<DifficultyBand, ReadonlySet<EffectTier>> = {
  trivial: new Set<EffectTier>(['cosmetic']),
  normal: new Set<EffectTier>(['cosmetic', 'material']),
  hard: new Set<EffectTier>(['cosmetic', 'material', 'heavy']),
  desperate: new Set<EffectTier>(['cosmetic', 'material', 'heavy', 'spine']),
};

/** Which effect tiers a difficulty band unlocks (authoring/UI helper — same table the
 *  referee clamps against, so the editor can warn when an effect won't fire). */
export function tierUnlockedBy(band: DifficultyBand): ReadonlySet<EffectTier> {
  return TIERS_BY_BAND[band];
}

/** Classify an effect into its proportionality tier by op + magnitude. */
export function effectTier(e: Effect): EffectTier {
  switch (e.op) {
    case 'setFlag':
    case 'clearFlag':
      return 'cosmetic';
    case 'adjustStat': {
      const mag = Math.abs(e.delta ?? 0);
      return mag <= 5 ? 'cosmetic' : mag <= 12 ? 'material' : 'heavy';
    }
    case 'adjustWarmth': {
      const mag = Math.abs(e.delta ?? 0);
      return mag <= 2 ? 'material' : 'heavy';
    }
    case 'addMoney': {
      const amt = Math.abs(e.amount ?? 0);
      return amt <= Math.floor(QUEST.MONEY_CAP_PER_QUEST / 2) ? 'material' : 'heavy';
    }
    case 'grantItem':
    case 'removeItem':
      return 'material';
    case 'moveEntityToFaction':
      return 'heavy';
    case 'moveToNode':
    case 'endScene':
      return 'spine';
    default:
      return 'cosmetic';
  }
}

// ============================================================================
// The seeded check.
// ============================================================================

/** A player stat level, defaulting to mid (50) and clamped 0..100. */
export function statLevel(state: QuestState, key: string): number {
  return clampInt(state.stats[key] ?? 50, 0, 100);
}

/** Base success chance for a band, lifted/lowered by the tested stat (±0.25). */
export function successChance(band: DifficultyBand, level: number): number {
  const base = band === 'trivial' ? 0.9 : band === 'normal' ? 0.65 : band === 'hard' ? 0.4 : 0.2;
  const mod = (clampInt(level, 0, 100) - 50) / 200; // ±0.25
  return clamp(base + mod, 0.05, 0.97);
}

/**
 * Map a seeded roll [0,1) to a grade. roll < chance → success; the failure region
 * is split (just-missed → partial, mid → fail, far → complication). Pure + pinned.
 */
export function gradeFromRoll(roll: number, chance: number): OutcomeGrade {
  const r = clamp(roll, 0, 0.9999999);
  if (r < chance) return 'success';
  const over = chance >= 1 ? 1 : (r - chance) / (1 - chance); // 0..1 within failure
  if (over < 0.4) return 'partial';
  if (over < 0.8) return 'fail';
  return 'complication';
}

const GRADE_EXPRESSION: Record<OutcomeGrade, string> = {
  success: 'happy',
  partial: 'thoughtful',
  fail: 'annoyed',
  complication: 'worried',
};

// ============================================================================
// resolveQuestAction — validate → check → select → clamp → apply → terminate.
// ============================================================================

export function resolveQuestAction(
  state: QuestState,
  graph: QuestGraph,
  action: QuestAction,
  roll: number,
): { newState: QuestState; outcome: QuestOutcome } {
  const node = graph.nodes.find((n) => n.id === state.nodeId) ?? graph.nodes[0]!;
  const next = cloneState(state);

  // 1. VALIDATE — find the first AVAILABLE affordance for the proposed verb (its optional
  // `when` precondition holds in the CURRENT state — the same snapshot the interpreter/
  // sceneView saw). Matching the first AVAILABLE one (not merely the first by verb) keeps the
  // referee in lockstep with `availableAffordances`/the interpreter, so a leading GATED
  // duplicate can't shadow an available same-verb approach. If a same-verb approach exists but
  // none is available, it's treated as off-menu (matched=null) and tagged "not yet".
  const verbMatches = node.affordances.filter((a) => a.verb === action.verb);
  const matched = verbMatches.find((a) => !a.when || evalPredicate(a.when, state)) ?? null;

  // 1a. NEUTRAL DEGRADE (the plan's "fiction valve") — ANY verb the scene offers no
  // AVAILABLE affordance for resolves to a do-nothing beat: no roll, no effects, no turn
  // consumed, no stall. This stops an OFF-MENU verb from being reskinned as the node's FIRST
  // affordance and accidentally winning, and stops a GATED approach from firing before its
  // precondition is met. A `noop` is INERT; a gated approach is VOICED as "not yet"; every
  // other unmatched verb is VOICED — the narrator describes the reply (`talk`) or the miss.
  if (action.verb === 'noop' || !matched) {
    const gated = verbMatches.length > 0 && action.verb !== 'noop'; // the verb exists here but isn't available yet
    const outcome: QuestOutcome = { grade: 'fail', appliedEffects: [], rejected: [], expression: 'thoughtful', ended: false, neutral: true, voiced: action.verb !== 'noop', gated };
    // TERMINATION SAFETY: a neutral beat consumes no turn and changes no state, so if the
    // scene is DEADLOCKED (a non-terminal node where no affordance is currently available),
    // the maxTurns/stall backstops can never trip — the run would hang. End it as a loss.
    if (sceneDeadlocked(graph, state)) {
      finish(outcome, graph.timeoutOutcome, { outcome: 'lose', label: 'The way is shut.' });
    }
    return { newState: next, outcome };
  }

  const affordance = matched; // a real, offered approach — resolve the check below

  // 2. CHECK — the seeded roll decides the grade. The LLM never touches this.
  const stat = affordance?.stat ?? action.stat;
  const band = affordance ? maxBand(affordance.difficulty, action.difficulty) : action.difficulty;
  const grade = gradeFromRoll(roll, successChance(band, statLevel(state, stat)));

  // 3. SELECT — the authored menu for this grade, narrowed by the LLM's proposal.
  const menu = affordance ? (affordance.effects[grade] ?? []) : [];
  const proposed = action.proposedEffects ?? [];
  const narrowed =
    proposed.length > 0 ? menu.filter((m) => proposed.some((p) => sameEffect(p, m))) : menu;
  const chosen = narrowed.length > 0 ? narrowed : menu;

  // 4. CLAMP — proportionality tier (band) → MAX_EFFECTS → per-effect magnitude.
  const allowedTiers = TIERS_BY_BAND[band];
  const rejected: Effect[] = [];
  const applied: Effect[] = [];
  // Track money accrued WITHIN this outcome too: `_moneyAccrued` is only bumped in the
  // apply step (below), so without this a second addMoney in the same composition would
  // see the same headroom and the per-quest cap could be overshot in one turn.
  let accrued = next.stats['_moneyAccrued'] ?? 0;
  for (const raw of chosen) {
    if (applied.length >= QUEST.MAX_EFFECTS_PER_OUTCOME) {
      rejected.push(raw);
      continue;
    }
    if (!allowedTiers.has(effectTier(raw))) {
      rejected.push(raw);
      continue;
    }
    const moneyRoom = Math.max(0, QUEST.MONEY_CAP_PER_QUEST - accrued);
    const clamped = clampEffect(raw, moneyRoom);
    if (clamped) {
      applied.push(clamped);
      if (clamped.op === 'addMoney') accrued += clamped.amount ?? 0;
    } else {
      rejected.push(raw);
    }
  }

  // 5. APPLY — mutate the cloned state through the closed grammar.
  let goalRelevant = false;
  for (const e of applied) {
    if (applyEffect(next, e)) goalRelevant = true;
  }

  // The turn is consumed regardless of grade.
  next.turn = state.turn + 1;

  // 5b. Authored routing (soft-layer): the FIRST satisfied edge moves the scene.
  for (const edge of node.edges) {
    if (graph.nodes.some((n) => n.id === edge.to) && evalPredicate(edge.when, next)) {
      if (next.nodeId !== edge.to) goalRelevant = true;
      next.nodeId = edge.to;
      break;
    }
  }

  // 5c. PER-SCENE ENTITY LOADING — after BOTH routing paths (a moveToNode effect in step 5
  // and a satisfied edge above have already set next.nodeId), merge the (now-current) node's
  // entity defs into the roster: add-if-absent, so a newly-entered room's NPCs come into being
  // AND any entity already present keeps its mutated state across a revisit. Runs before step 6
  // so a goal/edge predicate referencing the entered room's entity evaluates against it.
  mergeNodeEntities(next, graph);

  const outcome: QuestOutcome = {
    grade,
    appliedEffects: applied,
    rejected,
    expression: GRADE_EXPRESSION[grade],
    ended: false,
  };

  // 6. TERMINATION (plan §5.4) — code-owned, checked every turn, in order.
  // Already ended by an endScene effect?
  const endedByEffect = applied.find((e) => e.op === 'endScene');
  if (endedByEffect) {
    finish(outcome, endedByEffect.status ?? 'resolved');
    return { newState: next, outcome };
  }
  // A reached terminal node ends the scene.
  if (node.id !== next.nodeId && graph.nodes.find((n) => n.id === next.nodeId)?.isTerminal) {
    finish(outcome, 'resolved');
    return { newState: next, outcome };
  }
  // 6a. Goals — lose checked before win (fail-priority); first satisfied wins the race.
  const fired =
    graph.goals.find((g) => g.outcome === 'lose' && evalPredicate(g.predicate, next)) ??
    graph.goals.find((g) => g.outcome === 'win' && evalPredicate(g.predicate, next));
  if (fired) {
    finish(outcome, 'resolved', { outcome: fired.outcome, label: fired.label });
    return { newState: next, outcome };
  }
  // 6b. The turn budget — the GUARANTEED ending (hard backstop).
  if (next.turn >= graph.maxTurns) {
    finish(outcome, graph.timeoutOutcome, { outcome: 'lose', label: 'The moment passes.' });
    return { newState: next, outcome };
  }
  // 6c. Stall detection — only REPEATED no-progress attempts of the SAME committal verb
  // count (the spec's "count only repeated no-progress verbs", §5.4.4 / §R-bounding #3),
  // so legitimately gathering info or trying VARIED approaches never trips an early loss.
  // Exploration verbs (inspect/wait) never count; the neutral beat returned earlier. The
  // maxTurns backstop (6b) still guarantees termination regardless.
  const exploratory = action.verb === 'inspect' || action.verb === 'wait';
  if (goalRelevant || exploratory) {
    next.stats['_stall'] = 0;
  } else {
    const verbIdx = QUEST_VERBS.indexOf(action.verb);
    const sameAsLast = (next.stats['_stallVerb'] ?? -1) === verbIdx;
    next.stats['_stall'] = sameAsLast ? (next.stats['_stall'] ?? 0) + 1 : 1;
    next.stats['_stallVerb'] = verbIdx;
  }
  if ((next.stats['_stall'] ?? 0) >= QUEST.STALL_LIMIT) {
    finish(outcome, graph.timeoutOutcome, { outcome: 'lose', label: 'The trail goes cold.' });
    return { newState: next, outcome };
  }

  return { newState: next, outcome };
}

function finish(outcome: QuestOutcome, status: QuestStatus, goal?: { outcome: 'win' | 'lose'; label: string }): void {
  outcome.ended = true;
  outcome.endStatus = status;
  if (goal) {
    outcome.endGoal = goal;
    outcome.expression = goal.outcome === 'win' ? 'happy' : 'sad';
  }
}

// ============================================================================
// Effect clamping + application (the only place state changes magnitude).
// ============================================================================

/** Clamp a proposed effect's magnitudes to the per-effect caps. `moneyRoom` is the
 *  remaining headroom under the per-quest money cap (pass `MONEY_DELTA_MAX` when
 *  there's no running total, e.g. authoring). Returns null if the effect is
 *  malformed (missing required operand) and should be dropped. */
function clampEffect(e: Effect, moneyRoom: number): Effect | null {
  switch (e.op) {
    case 'setFlag':
    case 'clearFlag':
      return e.flag ? { op: e.op, flag: e.flag } : null;
    case 'moveEntityToFaction':
      return e.entityId && e.faction
        ? { op: e.op, entityId: e.entityId, faction: e.faction }
        : null;
    case 'adjustWarmth': {
      if (!e.characterId || !Number.isFinite(e.delta)) return null;
      const delta = clampInt(e.delta ?? 0, -QUEST.WARMTH_DELTA_MAX, QUEST.WARMTH_DELTA_MAX);
      return delta === 0 ? null : { op: e.op, characterId: e.characterId, delta };
    }
    case 'adjustStat': {
      if (!e.key || !Number.isFinite(e.delta)) return null;
      const delta = clampInt(e.delta ?? 0, -QUEST.STAT_DELTA_MAX, QUEST.STAT_DELTA_MAX);
      return delta === 0 ? null : { op: e.op, key: e.key, delta, entityId: e.entityId };
    }
    case 'grantItem':
    case 'removeItem':
      return e.itemId
        ? { op: e.op, itemId: e.itemId, qty: clampInt(e.qty ?? 1, 1, 5) }
        : null;
    case 'addMoney': {
      const amount = Math.min(clampInt(e.amount ?? 0, 0, QUEST.MONEY_DELTA_MAX), Math.max(0, moneyRoom));
      return amount > 0 ? { op: e.op, amount } : null;
    }
    case 'moveToNode':
      return e.nodeId ? { op: e.op, nodeId: e.nodeId } : null;
    case 'endScene':
      return { op: e.op, status: e.status ?? 'resolved' };
    default:
      return null;
  }
}

/** Apply a (clamped) effect to state. Returns true if it produced a goal-relevant
 *  delta (used for stall detection). */
function applyEffect(state: QuestState, e: Effect): boolean {
  switch (e.op) {
    case 'setFlag':
      if (e.flag && !state.flags.includes(e.flag)) {
        state.flags.push(e.flag);
        return true;
      }
      return false;
    case 'clearFlag': {
      const i = e.flag ? state.flags.indexOf(e.flag) : -1;
      if (i >= 0) {
        state.flags.splice(i, 1);
        return true;
      }
      return false;
    }
    case 'moveEntityToFaction': {
      const ent = state.entities.find((x) => x.id === e.entityId);
      if (ent && e.faction && ent.faction !== e.faction) {
        ent.faction = e.faction;
        return true;
      }
      return false;
    }
    case 'adjustWarmth':
      // Routed to the real (capped) stat-service by the SERVICE; here we only log it.
      return false;
    case 'adjustStat': {
      const delta = e.delta ?? 0;
      if (e.entityId) {
        const ent = state.entities.find((x) => x.id === e.entityId);
        if (!ent) return false;
        if (e.key === 'hp') {
          const cur = ent.hp ?? QUEST.MAX_HP;
          ent.hp = clampInt(cur + delta, 0, QUEST.MAX_HP);
        } else {
          ent.disposition = clampInt(ent.disposition + delta, -100, 100);
        }
        return true;
      }
      const cur = state.stats[e.key ?? 'grit'] ?? 50;
      state.stats[e.key ?? 'grit'] = clampInt(cur + delta, 0, 100);
      return true;
    }
    case 'grantItem': {
      const slot = state.inventory.find((x) => x.itemId === e.itemId);
      if (slot) slot.qty += e.qty ?? 1;
      else if (e.itemId) state.inventory.push({ itemId: e.itemId, qty: e.qty ?? 1 });
      return true;
    }
    case 'removeItem': {
      const slot = state.inventory.find((x) => x.itemId === e.itemId);
      if (slot) {
        slot.qty = Math.max(0, slot.qty - (e.qty ?? 1));
        state.inventory = state.inventory.filter((x) => x.qty > 0);
        return true;
      }
      return false;
    }
    case 'addMoney':
      state.stats['_moneyAccrued'] = (state.stats['_moneyAccrued'] ?? 0) + (e.amount ?? 0);
      return false;
    case 'moveToNode':
      if (e.nodeId && state.nodeId !== e.nodeId) {
        state.nodeId = e.nodeId;
        return true;
      }
      return false;
    case 'endScene':
      return false;
    default:
      return false;
  }
}

// ============================================================================
// Predicate evaluation (goals + edges).
// ============================================================================

export function evalPredicate(p: StatePredicate, state: QuestState): boolean {
  // Compound (one level over leaf clauses), then apply `negate` once. Empty all = true
  // (vacuous AND), empty any = false (vacuous OR) — the referee math stays pure; the lint
  // flags an empty compound. predicateCore never sees 'all'/'any'.
  let result: boolean;
  if (p.kind === 'all') result = (p.clauses ?? []).every((c) => evalPredicate(c, state));
  else if (p.kind === 'any') result = (p.clauses ?? []).some((c) => evalPredicate(c, state));
  else result = predicateCore(p, state);
  return p.negate ? !result : result;
}

function predicateCore(p: StatePredicate, state: QuestState): boolean {
  switch (p.kind) {
    case 'always':
      return true;
    case 'flag':
      return !!p.flag && state.flags.includes(p.flag);
    case 'atNode':
      return state.nodeId === p.nodeId;
    case 'turnGte':
      return state.turn >= (p.value ?? 0);
    case 'hasItem': {
      const slot = state.inventory.find((x) => x.itemId === p.itemId);
      return !!slot && slot.qty >= (p.value ?? 1);
    }
    case 'entityFaction': {
      const ent = state.entities.find((x) => x.id === p.entityId);
      return !!ent && ent.faction === p.faction;
    }
    case 'entityHp': {
      const ent = state.entities.find((x) => x.id === p.entityId);
      if (!ent || ent.hp == null) return false;
      return cmp(ent.hp, p.op ?? 'lte', p.value ?? 0);
    }
    case 'entityDisposition': {
      const ent = state.entities.find((x) => x.id === p.entityId);
      return !!ent && cmp(ent.disposition, p.op ?? 'gte', p.value ?? 0);
    }
    default:
      return false;
  }
}

// ============================================================================
// Construction helpers (used by the service to spin up a run).
// ============================================================================

/** A fresh runtime entity from its authored def (denormalised; starts with no flags). */
function defToEntityState(d: QuestEntityDef): QuestEntityState {
  return { id: d.id, name: d.name, description: d.description, faction: d.faction, disposition: d.disposition, hp: d.hp, flags: [] };
}

/** Load the CURRENT node's entity defs into the roster, ADD-IF-ABSENT: a newly-entered
 *  room's NPCs/objects come into being, while any entity already present keeps its mutated
 *  state (so leaving and returning to a room doesn't reset it). The runtime roster therefore
 *  accumulates across visited rooms — the fix for the "an NPC defined in room B never exists"
 *  frozen-roster bug. Pure; mutates the passed (cloned) state. */
function mergeNodeEntities(state: QuestState, graph: QuestGraph): void {
  const node = graph.nodes.find((n) => n.id === state.nodeId);
  if (!node) return;
  for (const d of node.entities) if (!state.entities.some((e) => e.id === d.id)) state.entities.push(defToEntityState(d));
}

/** The approaches OFFERED at a node right now: those with no `when`, or whose `when`
 *  precondition holds in `state`. The single source of truth for availability, shared by the
 *  referee (match step) and the service (interpreter menu / scene hints). */
export function availableAffordances(node: QuestNode, state: QuestState): NodeAffordance[] {
  return node.affordances.filter((a) => !a.when || evalPredicate(a.when, state));
}

/** Is the scene DEADLOCKED — a node where no approach is currently available (all gated off,
 *  or none authored) and the scene can't otherwise end? Then every attempt neutral-degrades
 *  forever (a neutral beat consumes no turn), so maxTurns/stall can't end it: the referee must
 *  force a loss. Edges can't rescue it (they only run after a matched affordance resolves). A
 *  non-entry terminal node is exempt — it resolves on ARRIVAL (the step-6 terminal check) — but
 *  a TERMINAL ENTRY node never "arrives" (you start there), so it must be caught here too. */
function sceneDeadlocked(graph: QuestGraph, state: QuestState): boolean {
  const node = currentNode(graph, state);
  if (node.isTerminal && node.id !== graph.entryNodeId) return false; // ends on arrival anyway
  return availableAffordances(node, state).length === 0;
}

/** Build the initial runtime state for a quest from its authored entry node. */
export function initialQuestState(graph: QuestGraph, playerStats: Record<string, number> = {}): QuestState {
  const node = graph.nodes.find((n) => n.id === graph.entryNodeId) ?? graph.nodes[0]!;
  return QuestStateSchema.parse({
    nodeId: node.id,
    entities: node.entities.map(defToEntityState),
    flags: [],
    inventory: [],
    stats: playerStats,
    turn: 0,
  });
}

/** The node the runtime state currently sits at (falls back to the entry node). */
export function currentNode(graph: QuestGraph, state: QuestState): QuestNode {
  return graph.nodes.find((n) => n.id === state.nodeId) ?? graph.nodes[0]!;
}

/** Whether any authored win-goal is still reachable in principle (soft authoring
 *  check — a quest should never be able to permanently strand its designed end). */
export function hasWinGoal(graph: QuestGraph): boolean {
  return graph.goals.some((g) => g.outcome === 'win');
}

const ALL_GRADES = ['success', 'partial', 'fail', 'complication'] as const;

/**
 * Whether at least one WIN goal can plausibly be SATISFIED by something in the
 * graph — a flag a success/partial sets, a faction an effect grants, a disposition/
 * hp an effect can push, an item granted, or a node the player can reach. A
 * heuristic, deliberately PERMISSIVE (when unsure it says reachable): it exists to
 * catch a win goal the model wired to nothing — the "you can never actually win
 * this" mistake — not to prove solvability. Distinct from {@link hasWinGoal}, which
 * only checks a win goal EXISTS.
 */
export function isWinReachable(graph: QuestGraph): boolean {
  const wins = graph.goals.filter((g) => g.outcome === 'win');
  return wins.length > 0 && wins.some((g) => predicateReachable(g.predicate, graph));
}

function predicateReachable(p: StatePredicate, graph: QuestGraph): boolean {
  const someEffect = (test: (e: Effect) => boolean): boolean =>
    graph.nodes.some((n) => n.affordances.some((a) => ALL_GRADES.some((grade) => a.effects[grade].some(test))));
  const entity = (id?: string) => graph.nodes.flatMap((n) => n.entities).find((e) => e.id === id);
  switch (p.kind) {
    case 'all':
      return (p.clauses ?? []).every((c) => predicateReachable(c, graph));
    case 'any':
      return (p.clauses ?? []).some((c) => predicateReachable(c, graph));
    case 'always':
    case 'turnGte':
      return true;
    case 'flag':
      return !!p.flag && someEffect((e) => e.op === 'setFlag' && e.flag === p.flag);
    case 'entityFaction': {
      const ent = entity(p.entityId);
      return (!!ent && ent.faction === p.faction) || someEffect((e) => e.op === 'moveEntityToFaction' && e.entityId === p.entityId && e.faction === p.faction);
    }
    case 'entityDisposition': {
      const ent = entity(p.entityId);
      const op = p.op ?? 'gte';
      if (ent && (op === 'gte' ? ent.disposition >= (p.value ?? 0) : ent.disposition <= (p.value ?? 0))) return true;
      return someEffect((e) => e.op === 'adjustStat' && e.entityId === p.entityId && e.key === 'disposition' && (op === 'gte' ? (e.delta ?? 0) > 0 : (e.delta ?? 0) < 0));
    }
    case 'entityHp': {
      const ent = entity(p.entityId);
      const op = p.op ?? 'lte';
      if (ent && ent.hp != null && (op === 'lte' ? ent.hp <= (p.value ?? 0) : ent.hp >= (p.value ?? 0))) return true;
      return someEffect((e) => e.op === 'adjustStat' && e.entityId === p.entityId && e.key === 'hp' && (op === 'lte' ? (e.delta ?? 0) < 0 : (e.delta ?? 0) > 0));
    }
    case 'hasItem':
      return someEffect((e) => e.op === 'grantItem' && e.itemId === p.itemId);
    case 'atNode':
      return graph.entryNodeId === p.nodeId || graph.nodes.some((n) => n.edges.some((edge) => edge.to === p.nodeId)) || someEffect((e) => e.op === 'moveToNode' && e.nodeId === p.nodeId);
    default:
      return true;
  }
}

/**
 * Sanitise an authored (or generated, or imported) quest graph into a safe, valid
 * one the referee can run (plan §9). Schema-parse (coerce enums, apply defaults,
 * range-check), then structurally repair: point `entryNodeId` at a real node,
 * cap entities/effects to their ceilings, drop malformed effects + clamp their
 * magnitudes, and prune edges that point at nodes that don't exist. Pure +
 * idempotent: re-bounding a bounded graph is a no-op. Throws (via the schema) on
 * a structurally impossible graph (e.g. zero nodes) so callers can 400.
 */
export function boundQuestGraph(input: unknown): QuestGraph {
  // Pre-clamp the few numbers the strict schema would otherwise REJECT (so a
  // generated / hand-fat-fingered value is clamped, not an error), then parse.
  const g = QuestGraphSchema.parse(preClampGraph(input));
  const nodeIds = new Set(g.nodes.map((n) => n.id));
  return {
    entryNodeId: nodeIds.has(g.entryNodeId) ? g.entryNodeId : g.nodes[0]!.id,
    maxTurns: clampInt(g.maxTurns, 1, QUEST.MAX_TURNS_CEILING),
    timeoutOutcome: g.timeoutOutcome,
    nodes: g.nodes.map((n) => ({
      ...n,
      entities: n.entities.slice(0, QUEST.MAX_ENTITIES_PER_SCENE),
      affordances: n.affordances.map((a) => ({
        ...a,
        effects: {
          success: boundEffects(a.effects.success),
          partial: boundEffects(a.effects.partial),
          fail: boundEffects(a.effects.fail),
          complication: boundEffects(a.effects.complication),
        },
      })),
      edges: n.edges.filter((e) => nodeIds.has(e.to)),
    })),
    goals: g.goals,
  };
}

/** Clamp + drop-malformed a list of authored effects, capped to MAX_EFFECTS. */
function boundEffects(list: Effect[]): Effect[] {
  const out: Effect[] = [];
  for (const e of list) {
    if (out.length >= QUEST.MAX_EFFECTS_PER_OUTCOME) break;
    const clamped = clampEffect(e, QUEST.MONEY_DELTA_MAX);
    if (clamped) out.push(clamped);
  }
  return out;
}

/** Strip a stray nested `clauses` so a compound's clause stays a LEAF (predicates are one
 *  level deep). The strict schema also strips it, but bounding it here keeps untrusted input
 *  small before the parse. */
function stripClauses(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const { clauses: _drop, ...rest } = raw as Record<string, unknown>;
  void _drop;
  return rest;
}

/** Repair an untrusted predicate before the strict parse: a compound (all/any) keeps at most
 *  MAX_PREDICATE_CLAUSES leaf clauses; a leaf carrying a stray `clauses` has it removed. */
function clampPredicate(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const p = raw as Record<string, unknown>;
  const kind = typeof p.kind === 'string' ? p.kind : '';
  if (kind === 'all' || kind === 'any') {
    return { ...p, clauses: Array.isArray(p.clauses) ? p.clauses.slice(0, QUEST.MAX_PREDICATE_CLAUSES).map(stripClauses) : [] };
  }
  if ('clauses' in p) {
    const out = { ...p };
    delete out.clauses;
    return out;
  }
  return p;
}

/** Defensive repair of an UNTRUSTED graph object so `QuestGraphSchema.parse` can't
 *  throw on the things the strict schema rejects: empty/duplicate ids (nodes,
 *  entities, goals) get unique fallbacks, and out-of-range numbers (maxTurns, entity
 *  disposition/hp) are clamped. A mediocre LLM that omits ids or over-ranges a number
 *  is REPAIRED here rather than rejected — everything else the schema coerces. Predicate
 *  preconditions / goals / routes are clamped to a bounded one-level shape. */
function preClampGraph(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const g = input as Record<string, unknown>;
  const out: Record<string, unknown> = { ...g };
  if ('maxTurns' in g) out.maxTurns = numOr(g.maxTurns, 1, QUEST.MAX_TURNS_CEILING, QUEST.DEFAULT_MAX_TURNS);
  if (Array.isArray(g.nodes)) {
    const usedNodes = new Set<string>();
    const mintedNodeIds: string[] = [];
    out.nodes = g.nodes.map((n, i) => {
      if (!n || typeof n !== 'object') return n;
      const node = n as Record<string, unknown>;
      const usedEnts = new Set<string>();
      const entities = Array.isArray(node.entities)
        ? node.entities.map((e, j) => {
            if (!e || typeof e !== 'object') return e;
            const ent = e as Record<string, unknown>;
            const eo: Record<string, unknown> = { ...ent, id: pickId(ent.id, `e${j + 1}`, usedEnts) };
            if ('disposition' in ent) eo.disposition = numOr(ent.disposition, -100, 100, 0);
            if ('hp' in ent && ent.hp != null) eo.hp = numOr(ent.hp, 0, QUEST.MAX_HP, QUEST.MAX_HP);
            if (typeof ent.description === 'string') eo.description = ent.description.slice(0, 500); // keep the prompt bounded
            return eo;
          })
        : node.entities;
      const id = pickId(node.id, `scene${i + 1}`, usedNodes);
      mintedNodeIds.push(id);
      // Drop edges with an empty/missing `to` (the strict schema's `to: z.string().min(1)`
      // would THROW on `""`), and clamp each route's `when` predicate.
      const edges = Array.isArray(node.edges)
        ? node.edges
            .filter((e) => e != null && typeof e === 'object' && typeof (e as Record<string, unknown>).to === 'string' && ((e as Record<string, unknown>).to as string).length > 0)
            .map((e) => ({ ...(e as Record<string, unknown>), when: clampPredicate((e as Record<string, unknown>).when) }))
        : node.edges;
      // Clamp each affordance's optional `when` precondition. A null/undefined `when` (a model
      // emitting "when":null, or an imported graph) is STRIPPED — the strict schema's
      // `.optional()` rejects null, and "no precondition" is the intended meaning anyway.
      const affordances = Array.isArray(node.affordances)
        ? node.affordances.map((a) => {
            if (!a || typeof a !== 'object') return a;
            const aff = a as Record<string, unknown>;
            if (aff.when == null) {
              if ('when' in aff) {
                const { when: _drop, ...rest } = aff;
                void _drop;
                return rest;
              }
              return aff;
            }
            return { ...aff, when: clampPredicate(aff.when) };
          })
        : node.affordances;
      return {
        ...node,
        id,
        entities,
        ...(Array.isArray(node.affordances) ? { affordances } : {}),
        ...(Array.isArray(node.edges) ? { edges } : {}),
      };
    });
    // entryNodeId is `z.string().min(1)` in the strict schema; a model that OMITS it leaves
    // the lenient default "" which throws here — and boundQuestGraph's post-parse entry repair
    // never runs because the parse already failed. Repoint it to a real node BEFORE the parse.
    // (This is exactly the "missing entryNodeId → unusable graph" generation failure.)
    if (mintedNodeIds.length > 0) {
      const entry = typeof g.entryNodeId === 'string' ? g.entryNodeId.trim() : '';
      out.entryNodeId = entry && mintedNodeIds.includes(entry) ? entry : mintedNodeIds[0];
    }
  }
  if (Array.isArray(g.goals)) {
    const usedGoals = new Set<string>();
    out.goals = g.goals.map((go, i) => {
      if (!go || typeof go !== 'object') return go;
      const goal = go as Record<string, unknown>;
      return {
        ...goal,
        id: pickId(goal.id, `goal${i + 1}`, usedGoals),
        ...('predicate' in goal ? { predicate: clampPredicate(goal.predicate) } : {}),
      };
    });
  }
  return out;
}

/** A non-empty, unique id: keep a clean original, else mint `fallback` (deduped). */
function pickId(raw: unknown, fallback: string, used: Set<string>): string {
  let id = typeof raw === 'string' ? raw.trim() : '';
  if (!id || used.has(id)) id = fallback;
  let n = 2;
  while (used.has(id)) id = `${fallback}_${n++}`;
  used.add(id);
  return id;
}

function numOr(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clampInt(v, lo, hi) : fallback;
}

// ============================================================================
// LLM quest generation (the ✨ "generate a quest" seam). A LENIENT mirror of the
// graph the model fills, so its output validates even when imperfect; the result
// is finalised through `boundQuestGraph` before it is ever played or saved.
// ============================================================================

/** Leaf predicate for generation — coerces an off-list kind / malformed element to a
 *  harmless leaf so a weak model can never throw the parse. */
const GenLeafPredicateSchema = z
  .object({
    kind: PredicateKindSchema.catch('always'),
    flag: z.string().optional(),
    entityId: z.string().optional(),
    faction: QuestFactionSchema.optional(),
    itemId: z.string().optional(),
    nodeId: z.string().optional(),
    op: z.enum(['lte', 'gte']).catch('gte').optional(),
    value: z.number().optional(),
    negate: z.boolean().optional(),
  })
  .catch({ kind: 'always' });

/** Predicate schema for generation — leaf fields + an optional one-level `clauses` (each a
 *  leaf) for compound `all`/`any`. A malformed NESTED clause degrades to a safe leaf (via
 *  GenLeafPredicateSchema's `.catch`); the top-level predicate is NOT `.catch`-coerced (an
 *  off-shape goal predicate must surface as a validation retry, never silently become a
 *  win-on-turn-1 `always`). Use {@link GenWhenSchema} for an affordance `when` (drops `null`). */
const GenPredicateSchema = z.object({
  kind: PredicateKindSchema.catch('always'),
  flag: z.string().optional(),
  entityId: z.string().optional(),
  faction: QuestFactionSchema.optional(),
  itemId: z.string().optional(),
  nodeId: z.string().optional(),
  op: z.enum(['lte', 'gte']).catch('gte').optional(),
  value: z.number().optional(),
  negate: z.boolean().optional(),
  clauses: z.array(GenLeafPredicateSchema).catch([]).optional(),
});

/** An affordance `when` for generation: a predicate, or a `null`/garbage value coerced to
 *  "no precondition" (undefined) — a weak model emitting `"when":null` shouldn't fail the
 *  whole draft. (Safe to coerce here, unlike a goal predicate, since a missing precondition
 *  just means "always available".) */
const GenWhenSchema = GenPredicateSchema.nullish().catch(undefined).transform((p) => p ?? undefined);

export const QuestGenSchema = z.object({
  name: z.string().default('Untitled Quest'),
  blurb: z.string().default(''),
  graph: z.object({
    entryNodeId: z.string().default(''),
    maxTurns: z.number().default(QUEST.DEFAULT_MAX_TURNS),
    timeoutOutcome: QuestStatusSchema.default('resolved'),
    nodes: z
      .array(
        z.object({
          id: z.string().default(''),
          kind: z.string().default('scene'),
          setup: z.string().default(''),
          entities: z
            .array(
              z.object({
                id: z.string().default(''),
                name: z.string().default(''),
                description: z.string().default(''),
                faction: QuestFactionSchema.default('neutral'),
                disposition: z.number().default(0),
                hp: z.number().optional(),
              }),
            )
            .default([]),
          affordances: z
            .array(
              z.object({
                verb: QuestVerbSchema,
                stat: z.string().default('grit'),
                difficulty: DifficultyBandSchema,
                hint: z.string().default(''),
                effects: AffordanceEffectsSchema.default({}),
                when: GenWhenSchema,
              }),
            )
            .default([]),
          edges: z.array(z.object({ when: GenPredicateSchema, to: z.string().default('') })).default([]),
          isTerminal: z.boolean().default(false),
        }),
      )
      .min(1),
    goals: z
      .array(
        z.object({
          id: z.string().default(''),
          kind: GoalKindSchema,
          outcome: GoalOutcomeSchema,
          predicate: GenPredicateSchema,
          label: z.string().default(''),
        }),
      )
      .default([]),
  }),
});
export type QuestGenDraft = z.infer<typeof QuestGenSchema>;

// ============================================================================
// Coherence linting + deterministic auto-repair (the generation-hardening pass).
//
// The lenient QuestGenSchema + boundQuestGraph guarantee a generated graph PARSES
// and RUNS, but NOT that it is WINNABLE or COHERENT. A weak model routinely ships a
// graph whose win can never fire (the deciding effect sits ABOVE its approach's
// difficulty band, so the referee silently drops it — see TIERS_BY_BAND), whose lose
// goal is already true at turn 0, or whose effects/goals point at entities the runtime
// never loads (the roster is frozen to the ENTRY scene). None of this trips the schema,
// and the PERMISSIVE {@link isWinReachable} misses all of it (it is tier-, magnitude-,
// and connectivity-blind, scans every node for entities though only the entry node's
// load, and ignores lose goals), so the {@link isWinReachable}-gated ensureWinGoal net
// never even fires.
//
// Everything here is PURE + deterministic + schema-free (no Zod shape changes):
//   - isWinReachableTiered — isWinReachable, but a win effect only counts if it can
//     actually FIRE: its tier ≤ its affordance's band, in a REACHABLE node, against an
//     ENTRY-scene entity. This is what gates the ensureWinGoal safety net.
//   - lintQuestGraph        — pinpointed, id-templated problems (blocking | warning),
//     reused by the server pipeline (drives the model repair loop) AND the editor.
//   - autoFixQuestGraph     — the SAFE repairs no model is needed for (raise a band so a
//     win can fire, drop an auto-lose goal, retarget/strip warmth, remap an unambiguous
//     dangling id, copy a fail-only win into success, …). Idempotent.
// See `docs/quest-mode-plan.md`.
// ============================================================================

/** Context the linter/auto-fixer needs that isn't in the graph itself. */
export interface QuestLintContext {
  /** The dated character this quest is anchored to (the ONLY valid `adjustWarmth`
   *  target), or null for a non-romance quest. */
  partnerId: string | null;
}

/** A single coherence problem. `code` is stable (machine key); `message` is short
 *  human text (the editor is English chrome, so it renders as-is); `repairInstruction`
 *  is the terse, id-pinpointed line fed to the model in the repair loop. */
export interface QuestProblem {
  severity: 'blocking' | 'warning';
  code: string;
  message: string;
  repairInstruction: string;
  targets?: {
    nodeId?: string;
    goalId?: string;
    verb?: string;
    entityId?: string;
    itemId?: string;
    flag?: string;
    effectOp?: string;
    requiredBand?: DifficultyBand;
  };
}

/** A note describing one deterministic repair that {@link autoFixQuestGraph} applied. */
export interface AutoFixNote {
  code: string;
  detail: string;
}

const BAND_ORDER: readonly DifficultyBand[] = ['trivial', 'normal', 'hard', 'desperate'];
function bandRank(b: DifficultyBand): number {
  const i = BAND_ORDER.indexOf(b);
  return i < 0 ? 1 : i;
}

/** The easiest difficulty band whose tier set unlocks `tier` (so an effect of that
 *  tier will actually fire). The inverse of {@link TIERS_BY_BAND}. */
export function minBandForTier(tier: EffectTier): DifficultyBand {
  switch (tier) {
    case 'cosmetic':
      return 'trivial';
    case 'material':
      return 'normal';
    case 'heavy':
      return 'hard';
    case 'spine':
      return 'desperate';
    default:
      return 'normal';
  }
}

/** The stats a quest check may test (mirrors the editor's STAT_OPTIONS). */
const KNOWN_QUEST_STATS = new Set<string>([...DATING_STAT_KEYS, 'grit', 'wits']);

/** A sensible stat for each verb, used to repair an off-list / mismatched stat. */
const VERB_DEFAULT_STAT: Record<string, string> = {
  inspect: 'intellect',
  move: 'grit',
  use_item: 'intellect',
  talk: 'charm',
  persuade: 'charm',
  intimidate: 'confidence',
  deceive: 'intellect',
  charm: 'charm',
  sneak: 'grit',
  force: 'grit',
  aid: 'empathy',
  attack: 'grit',
  wait: 'intellect',
};

function entryNode(graph: QuestGraph): QuestNode {
  return graph.nodes.find((n) => n.id === graph.entryNodeId) ?? graph.nodes[0]!;
}

/** The ids of the entities the RUNTIME actually has. `initialQuestState` seeds the
 *  roster from the ENTRY node alone, and routing (`moveToNode`/edges) never repopulates
 *  it — so an entity defined only in a later node never exists at play time, and any
 *  effect/goal that targets it silently no-ops. Every entity-reference check scopes to
 *  this set, not "any node's entities" (which is the bug in {@link isWinReachable}). */
export function entryEntityIds(graph: QuestGraph): Set<string> {
  return new Set(entryNode(graph).entities.map((e) => e.id));
}


/** An entity def by id, searched across ALL nodes (the runtime loads each scene's entities
 *  as it's entered, so an entity is "real" if it's defined in any node). */
function graphEntityDef(graph: QuestGraph, id: string | undefined): QuestEntityDef | undefined {
  if (!id) return undefined;
  for (const n of graph.nodes) {
    const e = n.entities.find((x) => x.id === id);
    if (e) return e;
  }
  return undefined;
}

/** All entity ids defined anywhere in the graph (every entity that can ever exist at runtime). */
function allEntityIds(graph: QuestGraph): Set<string> {
  const out = new Set<string>();
  for (const n of graph.nodes) for (const e of n.entities) out.add(e.id);
  return out;
}

/** The entity ids that can exist at runtime on a REACHABLE path — the union of every
 *  reachable node's roster (per-scene entities load as the player enters each room). This
 *  replaces the old entry-only `entryEntityIds` for "does this entity exist during play"
 *  checks, so a room-B NPC is no longer falsely flagged as nonexistent. */
export function reachableEntityIds(graph: QuestGraph): Set<string> {
  const reach = reachableNodeIds(graph);
  const out = new Set<string>();
  for (const n of graph.nodes) if (reach.has(n.id)) for (const e of n.entities) out.add(e.id);
  return out;
}

/** Does an entity's authored DEF already satisfy a leaf entity-predicate at load time? */
function entityDefSatisfies(p: StatePredicate, def: QuestEntityDef | undefined): boolean {
  if (!def) return false;
  switch (p.kind) {
    case 'entityFaction':
      return def.faction === p.faction;
    case 'entityDisposition': {
      const op = p.op ?? 'gte';
      return op === 'gte' ? def.disposition >= (p.value ?? 0) : def.disposition <= (p.value ?? 0);
    }
    case 'entityHp': {
      if (def.hp == null) return false;
      const op = p.op ?? 'lte';
      return op === 'lte' ? def.hp <= (p.value ?? 0) : def.hp >= (p.value ?? 0);
    }
    default:
      return false;
  }
}

/** Could a predicate EVER hold during play — a STATIC, permissive over-approximation used to
 *  gate route / affordance-precondition reachability (distinct from the referee's concrete
 *  evalPredicate). Permissive about WHERE a producing effect lives (never over-prunes a legit
 *  route) and about negation. Handles one-level compound (all/any). `roster` = the entity ids
 *  considered to exist (caller passes all-entity ids for route gating, reachable-roster for
 *  the lint). Catches "a gate keyed on a flag nothing produces". */
function predSatisfiable(p: StatePredicate | undefined, graph: QuestGraph, roster: Set<string>, sites: EffectSite[]): boolean {
  if (!p) return true;
  if (p.negate) return true; // permissive on negation
  if (p.kind === 'all') return (p.clauses ?? []).every((c) => predSatisfiable(c, graph, roster, sites));
  if (p.kind === 'any') return (p.clauses ?? []).some((c) => predSatisfiable(c, graph, roster, sites));
  switch (p.kind) {
    case 'always':
    case 'turnGte':
    case 'atNode':
      return true;
    case 'flag':
      return sites.some((s) => s.effect.op === 'setFlag' && s.effect.flag === p.flag && tierUnlockedBy(s.band).has(effectTier(s.effect)));
    case 'hasItem':
      return sites.some((s) => s.effect.op === 'grantItem' && s.effect.itemId === p.itemId && tierUnlockedBy(s.band).has(effectTier(s.effect)));
    case 'entityFaction':
    case 'entityDisposition':
    case 'entityHp':
      if (!p.entityId || !roster.has(p.entityId)) return false;
      if (entityDefSatisfies(p, graphEntityDef(graph, p.entityId))) return true;
      return sites.some((s) => effectAdvances(p, s.effect) && tierUnlockedBy(s.band).has(effectTier(s.effect)));
    default:
      return true;
  }
}

/** Nodes reachable from the entry node, CONSERVATIVELY: along authored edges whose `when`
 *  is statically satisfiable, and via a `moveToNode` effect that can actually fire — a
 *  `desperate` affordance (moveToNode is spine) whose own `when` precondition is satisfiable
 *  (this is the player-CHOSEN conditional move). */
export function reachableNodeIds(graph: QuestGraph): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const allEnts = allEntityIds(graph);
  const sites = effectSites(graph);
  const startId = byId.has(graph.entryNodeId) ? graph.entryNodeId : graph.nodes[0]?.id;
  const seen = new Set<string>();
  const stack: string[] = startId ? [startId] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    for (const e of node.edges) if (byId.has(e.to) && predSatisfiable(e.when, graph, allEnts, sites)) stack.push(e.to);
    for (const a of node.affordances) {
      if (a.difficulty !== 'desperate') continue; // moveToNode (spine) only fires on a desperate approach
      if (!predSatisfiable(a.when, graph, allEnts, sites)) continue; // a gated move follows only when its precondition is reachable
      for (const grade of ALL_GRADES)
        for (const eff of a.effects[grade])
          if (eff.op === 'moveToNode' && eff.nodeId && byId.has(eff.nodeId)) stack.push(eff.nodeId);
    }
  }
  return seen;
}

/** Reachable nodes where the player can actually take a TURN. A non-entry node marked
 *  `isTerminal` ends the scene the INSTANT it's routed into (resolveQuestAction resolves on
 *  arrival, before any affordance there can run), so its effects never fire. The entry node
 *  is always actable — you start there, and the terminal-on-arrival check only triggers on a
 *  routed change of node. Effect reachability (siteCanFire) must use THIS, not reachableNodeIds:
 *  a win flag that only lives in a terminal node can never be set. */
export function actableNodeIds(graph: QuestGraph): Set<string> {
  const reachable = reachableNodeIds(graph);
  const entryId = entryNode(graph).id;
  const out = new Set<string>();
  for (const n of graph.nodes) if (reachable.has(n.id) && (n.id === entryId || !n.isTerminal)) out.add(n.id);
  return out;
}

interface EffectSite {
  nodeId: string;
  verb: QuestVerb;
  band: DifficultyBand;
  grade: OutcomeGrade;
  effect: Effect;
  /** The host affordance's precondition (so reachability requires it be satisfiable). */
  when?: StatePredicate;
}

function effectSites(graph: QuestGraph): EffectSite[] {
  const out: EffectSite[] = [];
  for (const n of graph.nodes)
    for (const a of n.affordances)
      for (const grade of ALL_GRADES)
        for (const effect of a.effects[grade])
          out.push({ nodeId: n.id, verb: a.verb, band: a.difficulty, grade, effect, when: a.when });
  return out;
}

/** Does this effect push state TOWARD satisfying `p`? (mirrors predicateReachable's
 *  op+operand match logic, plus the disposition/hp sign.) */
function effectAdvances(p: StatePredicate, e: Effect): boolean {
  switch (p.kind) {
    case 'flag':
      return e.op === 'setFlag' && !!e.flag && e.flag === p.flag;
    case 'entityFaction':
      return e.op === 'moveEntityToFaction' && e.entityId === p.entityId && e.faction === p.faction;
    case 'entityDisposition': {
      const op = p.op ?? 'gte';
      return e.op === 'adjustStat' && e.entityId === p.entityId && e.key === 'disposition' && (op === 'gte' ? (e.delta ?? 0) > 0 : (e.delta ?? 0) < 0);
    }
    case 'entityHp': {
      const op = p.op ?? 'lte';
      return e.op === 'adjustStat' && e.entityId === p.entityId && e.key === 'hp' && (op === 'lte' ? (e.delta ?? 0) < 0 : (e.delta ?? 0) > 0);
    }
    case 'hasItem':
      return e.op === 'grantItem' && !!e.itemId && e.itemId === p.itemId;
    default:
      return false;
  }
}

/** Can the effect at this site actually FIRE: its node is ACTABLE (reachable + playable —
 *  not a non-entry terminal node), its affordance's `when` precondition is satisfiable, the
 *  effect's tier is unlocked by the band, and (for an entity-targeting effect) the entity is
 *  in the reachable roster (defined in some reachable scene — per-scene entities load on entry). */
function siteCanFire(site: EffectSite, actable: Set<string>, roster: Set<string>, graph: QuestGraph, sites: EffectSite[]): boolean {
  if (!actable.has(site.nodeId)) return false;
  if (site.when && !predSatisfiable(site.when, graph, roster, sites)) return false;
  if (!tierUnlockedBy(site.band).has(effectTier(site.effect))) return false;
  const e = site.effect;
  if (e.op === 'moveEntityToFaction' && (!e.entityId || !roster.has(e.entityId))) return false;
  if (e.op === 'adjustStat' && e.entityId && !roster.has(e.entityId)) return false;
  return true;
}


/** For a numeric-threshold win (entityDisposition/entityHp) on an entry entity: the
 *  optimistic best case — starting value, the largest fireable success/partial step
 *  toward the threshold, and whether the threshold is reachable within maxTurns. Returns
 *  null for non-threshold predicates. Shared by {@link isWinReachableTiered} and the lint
 *  so the magnitude math can't drift between them. */
function thresholdReach(
  p: StatePredicate,
  graph: QuestGraph,
  actable: Set<string>,
  roster: Set<string>,
  sites: EffectSite[],
): { start: number; bestStep: number; ok: boolean } | null {
  if (p.kind !== 'entityDisposition' && p.kind !== 'entityHp') return null;
  const ent = graphEntityDef(graph, p.entityId); // the entity's start value comes from its own scene's def
  if (!ent) return null;
  const start = p.kind === 'entityHp' ? ent.hp ?? QUEST.MAX_HP : ent.disposition;
  const steps = sites.filter((s) => (s.grade === 'success' || s.grade === 'partial') && effectAdvances(p, s.effect) && siteCanFire(s, actable, roster, graph, sites));
  const bestStep = Math.max(0, ...steps.map((s) => Math.abs(clampInt(s.effect.delta ?? 0, -QUEST.STAT_DELTA_MAX, QUEST.STAT_DELTA_MAX))));
  const target = p.value ?? 0;
  const op = p.op ?? (p.kind === 'entityHp' ? 'lte' : 'gte');
  const ok = op === 'gte' ? start + bestStep * graph.maxTurns >= target : start - bestStep * graph.maxTurns <= target;
  return { start, bestStep, ok };
}

/** Can a single LEAF win-predicate actually be produced at runtime (tier + reachable+actable
 *  node + satisfiable precondition + reachable-roster entity + enough threshold magnitude +
 *  a survive-turn within the budget)? */
/** Is the entity defined in at least one ACTABLE node (so a predicate already-true on its
 *  authored def is actually observable during play — not stranded in a terminal room that
 *  resolves on arrival before any goal check)? */
function entityInActableNode(graph: QuestGraph, id: string | undefined, actable: Set<string>): boolean {
  return !!id && graph.nodes.some((n) => actable.has(n.id) && n.entities.some((e) => e.id === id));
}

/** Can a single LEAF predicate be produced at runtime? `allowFailGrade` is set for a CLAUSE of
 *  a compound — there, a flag set only on a FAIL grade is a legitimate contributor (you can
 *  fail one approach and succeed another so both flags end set); for a TOP-LEVEL leaf win it
 *  stays false, so a win achievable only by failing is left for the WIN_ONLY_ON_FAILURE lint. */
function leafTierReachable(
  p: StatePredicate,
  graph: QuestGraph,
  reachable: Set<string>,
  actable: Set<string>,
  roster: Set<string>,
  sites: EffectSite[],
  allowFailGrade = false,
): boolean {
  if (p.negate) return true; // negated: permissive (never over-block)
  const producible = (s: EffectSite) => (allowFailGrade || s.grade === 'success' || s.grade === 'partial');
  switch (p.kind) {
    case 'always':
      return true;
    case 'turnGte':
      return (p.value ?? 0) <= graph.maxTurns; // a survive win must fit the turn budget
    case 'atNode':
      return !!p.nodeId && reachable.has(p.nodeId); // ARRIVING (even at a terminal node) satisfies atNode
    case 'flag':
    case 'hasItem':
      // A standalone win must be achievable by SUCCEEDING (success/partial), not only by
      // failing — else it's a WIN_ONLY_ON_FAILURE defect the lint should surface.
      return sites.some((s) => producible(s) && effectAdvances(p, s.effect) && siteCanFire(s, actable, roster, graph, sites));
    case 'entityFaction':
    case 'entityDisposition':
    case 'entityHp': {
      if (!p.entityId || !roster.has(p.entityId)) return false;
      // Already true on the entity's def — but only counts if the entity exists in an ACTABLE
      // node (a def-satisfied win confined to a terminal room never fires: the scene resolves
      // on arrival before the goal check).
      if (entityInActableNode(graph, p.entityId, actable) && entityDefSatisfies(p, graphEntityDef(graph, p.entityId))) return true;
      if (!sites.some((s) => producible(s) && effectAdvances(p, s.effect) && siteCanFire(s, actable, roster, graph, sites))) return false;
      const t = thresholdReach(p, graph, actable, roster, sites);
      return t && t.bestStep > 0 ? t.ok : true;
    }
    default:
      return true;
  }
}

/** Is a win predicate (leaf OR one-level compound) actually achievable at runtime? A compound's
 *  clauses allow a fail-grade producer (you can fail one and succeed another). */
function predicateTierReachable(
  p: StatePredicate,
  graph: QuestGraph,
  reachable: Set<string>,
  actable: Set<string>,
  roster: Set<string>,
  sites: EffectSite[],
): boolean {
  if (p.negate) return true;
  if (p.kind === 'all') return (p.clauses ?? []).length > 0 && (p.clauses ?? []).every((c) => leafTierReachable(c, graph, reachable, actable, roster, sites, true));
  if (p.kind === 'any') return (p.clauses ?? []).some((c) => leafTierReachable(c, graph, reachable, actable, roster, sites, true));
  return leafTierReachable(p, graph, reachable, actable, roster, sites);
}

/**
 * Like {@link isWinReachable}, but a win goal only counts as reachable if SOMETHING can
 * actually produce its state at runtime: a tier-unlocked effect, in a reachable+actable node,
 * behind a satisfiable precondition, against an entity that exists on a reachable path, with
 * enough magnitude for a threshold and a survive-turn within the budget — recursing AND/OR
 * compound goals. This decides whether the ensureWinGoal backup net needs to fire.
 */
export function isWinReachableTiered(graph: QuestGraph): boolean {
  const wins = graph.goals.filter((g) => g.outcome === 'win');
  if (wins.length === 0) return false;
  const reachable = reachableNodeIds(graph);
  const actable = actableNodeIds(graph);
  const roster = reachableEntityIds(graph);
  const sites = effectSites(graph);
  return wins.some((g) => predicateTierReachable(g.predicate, graph, reachable, actable, roster, sites));
}

/** A short human/LLM-readable rendering of a predicate (compound-aware). */
export function describePredicate(p: StatePredicate): string {
  const body = (() => {
    switch (p.kind) {
      case 'flag':
        return `flag "${p.flag ?? ''}" ${p.negate ? 'NOT set' : 'set'}`;
      case 'entityFaction':
        return `entity "${p.entityId ?? ''}" on side "${p.faction ?? ''}"`;
      case 'entityDisposition':
        return `entity "${p.entityId ?? ''}" feeling ${p.op ?? 'gte'} ${p.value ?? 0}`;
      case 'entityHp':
        return `entity "${p.entityId ?? ''}" hp ${p.op ?? 'lte'} ${p.value ?? 0}`;
      case 'hasItem':
        return `item "${p.itemId ?? ''}"`;
      case 'atNode':
        return `player at scene "${p.nodeId ?? ''}"`;
      case 'turnGte':
        return `turn >= ${p.value ?? 0}`;
      case 'always':
        return 'always';
      case 'all':
        return `(${(p.clauses ?? []).map(describePredicate).join(' AND ') || 'nothing'})`;
      case 'any':
        return `(${(p.clauses ?? []).map(describePredicate).join(' OR ') || 'nothing'})`;
      default:
        return p.kind;
    }
  })();
  // flag already renders its own negate; for everything else, a leading NOT.
  return p.negate && p.kind !== 'flag' ? `NOT ${body}` : body;
}

function samePredicate(a: StatePredicate, b: StatePredicate): boolean {
  if (a.kind === 'all' || a.kind === 'any' || b.kind === 'all' || b.kind === 'any') {
    const ac = a.clauses ?? [];
    const bc = b.clauses ?? [];
    return a.kind === b.kind && !!a.negate === !!b.negate && ac.length === bc.length && ac.every((c, i) => samePredicate(c, bc[i]!));
  }
  return (
    a.kind === b.kind &&
    a.flag === b.flag &&
    a.entityId === b.entityId &&
    a.faction === b.faction &&
    a.itemId === b.itemId &&
    a.nodeId === b.nodeId &&
    (a.op ?? null) === (b.op ?? null) &&
    (a.value ?? null) === (b.value ?? null) &&
    !!a.negate === !!b.negate
  );
}

/** Mirror of clampEffect's null-cases: is this effect missing a required operand (so the
 *  referee silently drops it)? */
function effectComplete(e: Effect): boolean {
  switch (e.op) {
    case 'setFlag':
    case 'clearFlag':
      return !!e.flag;
    case 'moveEntityToFaction':
      return !!e.entityId && !!e.faction;
    case 'adjustWarmth':
      return !!e.characterId && !!e.delta;
    case 'adjustStat':
      return !!e.key && !!e.delta;
    case 'grantItem':
    case 'removeItem':
      return !!e.itemId;
    case 'addMoney':
      return !!e.amount;
    case 'moveToNode':
      return !!e.nodeId;
    case 'endScene':
      return true;
    default:
      return false;
  }
}

/** The leaf conditions of a predicate (the clauses of a compound, else the predicate itself).
 *  Predicates are one level deep, so this fully flattens. */
function predLeaves(p: StatePredicate): StatePredicate[] {
  return p.kind === 'all' || p.kind === 'any' ? p.clauses ?? [] : [p];
}

function dedupeProblems(list: QuestProblem[]): QuestProblem[] {
  const seen = new Set<string>();
  const out: QuestProblem[] = [];
  for (const p of list) {
    const key = `${p.code}|${JSON.stringify(p.targets ?? {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Deterministically audit a (bounded) quest graph for the coherence defects a weak model
 * produces that the schema + boundQuestGraph let through. BLOCKING problems make the quest
 * unwinnable / auto-losing (they drive the model repair loop); WARNING problems play badly
 * but are survivable (surfaced to the human author). Pure + side-effect-free; safe to call
 * from the server pipeline AND the editor. Run it on the POST-boundQuestGraph graph.
 */
export function lintQuestGraph(graph: QuestGraph, ctx: QuestLintContext): QuestProblem[] {
  const problems: QuestProblem[] = [];
  const push = (p: QuestProblem) => problems.push(p);
  const reachable = reachableNodeIds(graph);
  const actable = actableNodeIds(graph);
  // Entities that can exist on a reachable path (per-scene rosters load as rooms are entered)
  // — the scope for "does this entity exist at play time" checks (NOT entry-only anymore).
  const roster = reachableEntityIds(graph);
  const rosterList = [...roster].join(', ') || '(none)';
  const nodeIds = graph.nodes.map((n) => n.id);
  const entryId = entryNode(graph).id;
  const sites = effectSites(graph);
  const grantedItems = new Set(
    sites.filter((s) => s.effect.op === 'grantItem' && s.effect.itemId).map((s) => s.effect.itemId!),
  );
  const entry = entryNode(graph);
  const wins = graph.goals.filter((g) => g.outcome === 'win');
  const s0 = initialQuestState(graph); // the entry state — for available-affordance + auto-lose checks

  // --- Entry playability: the player must be able to DO something that progresses. ---
  if (entry.affordances.length === 0) {
    push({
      severity: 'blocking',
      code: 'ENTRY_NO_AFFORDANCE',
      message: `The opening scene "${entry.id}" has no approaches, so the player can never act.`,
      repairInstruction: `The entry scene "${entry.id}" has zero affordances. Add 2-3 affordances (different verbs) grounded in its setup, each with a one-line hint and at least one real effect in its "success" array.`,
      targets: { nodeId: entry.id },
    });
  } else if (availableAffordances(entry, s0).length === 0) {
    push({
      severity: 'blocking',
      code: 'ENTRY_NO_AVAILABLE_AFFORDANCE',
      message: `Every approach in the opening scene "${entry.id}" is gated off at the start, so the player can never act.`,
      repairInstruction: `In entry scene "${entry.id}", at least one approach must have NO "when" precondition (or one true at the start) so the player can begin. Ungate one.`,
      targets: { nodeId: entry.id },
    });
  } else if (!availableAffordances(entry, s0).some((a) => a.effects.success.some((e) => effectComplete(e) && tierUnlockedBy(a.difficulty).has(effectTier(e))))) {
    push({
      severity: 'blocking',
      code: 'ENTRY_NO_FIREABLE_SUCCESS',
      message: `No available approach in the opening scene "${entry.id}" does anything on success, so the player can't make progress.`,
      repairInstruction: `In entry scene "${entry.id}", at least one AVAILABLE affordance must have a complete effect in its "success" array whose size fits its difficulty (a setFlag fits any difficulty). Add one that advances a win goal.`,
      targets: { nodeId: entry.id },
    });
  }

  // --- Win goals: existence + actual reachability. ---
  if (!hasWinGoal(graph)) {
    push({
      severity: 'blocking',
      code: 'NO_WIN_GOAL',
      message: 'The quest has no "win" goal, so it can never be completed.',
      repairInstruction: 'Add at least one goal with outcome "win" whose predicate is produced by a success effect (e.g. a flag a success sets).',
    });
  }
  for (const g of wins) {
    const p = g.predicate;
    const label = g.label || g.id;
    // The single source of truth: if the whole predicate (leaf OR compound) is genuinely
    // achievable, the goal is fine — skip ALL leaf diagnostics (this is what prevents a
    // reachable AND goal like all[X,Y] being mis-flagged by the leaf cascade).
    if (predicateTierReachable(p, graph, reachable, actable, roster, sites)) continue;
    if (p.negate) continue; // permissive on a negated win
    // An unreachable COMPOUND goal: a generic, actionable blocker (the leaf cascade is for leaves).
    if (p.kind === 'all' || p.kind === 'any') {
      push({
        severity: 'blocking',
        code: 'WIN_DECOUPLED',
        message: `Win "${label}" (${describePredicate(p)}) can't be fully achieved as wired.`,
        repairInstruction: `Win goal "${label}" requires ${describePredicate(p)}, but at least one part can't be produced. Make every required condition the result of a reachable success effect (matching flag/entityId/itemId), on an approach whose difficulty unlocks it.`,
        targets: { goalId: g.id },
      });
      continue;
    }
    if (p.kind === 'turnGte' && (p.value ?? 0) > graph.maxTurns) {
      push({
        severity: 'blocking',
        code: 'WIN_TURN_GTE_OVER_MAXTURNS',
        message: `Win "${label}" needs to reach turn ${p.value}, but the quest ends at ${graph.maxTurns} turns (a loss).`,
        repairInstruction: `Win goal "${label}" requires turnGte ${p.value} but maxTurns is ${graph.maxTurns}. Raise maxTurns to at least ${p.value} (cap ${QUEST.MAX_TURNS_CEILING}) or lower the goal value to <= ${graph.maxTurns}.`,
        targets: { goalId: g.id },
      });
      continue;
    }
    if ((p.kind === 'entityFaction' || p.kind === 'entityDisposition' || p.kind === 'entityHp') && (!p.entityId || !roster.has(p.entityId))) {
      push({
        severity: 'blocking',
        code: 'WIN_ENTITY_NOT_IN_ENTRY',
        message: `Win "${label}" targets "${p.entityId ?? '(none)'}", which exists in no reachable scene, so it can never be true.`,
        repairInstruction: `Win goal "${label}" targets entity "${p.entityId ?? ''}", which is not defined in any reachable scene (reachable entities: ${rosterList}). Define it in a scene the player reaches, or retarget the goal AND its effect to one of: ${rosterList}.`,
        targets: { goalId: g.id, entityId: p.entityId },
      });
      continue;
    }
    const advancing = sites.filter((s) => effectAdvances(p, s.effect));
    if (advancing.length === 0) {
      if (p.kind === 'atNode') {
        if (!p.nodeId || !reachable.has(p.nodeId))
          push({
            severity: 'blocking',
            code: 'WIN_NODE_UNREACHABLE',
            message: `Win "${label}" needs the player at scene "${p.nodeId ?? '(none)'}", but nothing routes there.`,
            repairInstruction: `Win goal "${label}" checks atNode "${p.nodeId ?? ''}". Add an edge into it from a reachable scene, or a 'desperate' moveToNode to it, or mark the intended scene isTerminal and route there.`,
            targets: { goalId: g.id, nodeId: p.nodeId },
          });
        continue;
      }
      push({
        severity: 'blocking',
        code: 'WIN_DECOUPLED',
        message: `Nothing in the quest produces the state Win "${label}" checks, so it can never be met.`,
        repairInstruction: `Win goal "${label}" checks ${describePredicate(p)} but no success effect produces it. Add a success effect that produces EXACTLY that (matching flag/entityId/itemId character-for-character), or change the goal to match an existing success effect.`,
        targets: { goalId: g.id, flag: p.flag, itemId: p.itemId, entityId: p.entityId },
      });
      continue;
    }
    const fireable = advancing.filter((s) => siteCanFire(s, actable, roster, graph, sites));
    if (fireable.length === 0) {
      const tierGated = advancing.find((s) => actable.has(s.nodeId) && !tierUnlockedBy(s.band).has(effectTier(s.effect)));
      // Reachable but NOT actable = a node the player arrives at but can't take a turn in,
      // i.e. a non-entry terminal node (reaching it ends the scene before any approach runs).
      const inDeadTerminal = advancing.find((s) => reachable.has(s.nodeId) && !actable.has(s.nodeId));
      if (tierGated) {
        const req = minBandForTier(effectTier(tierGated.effect));
        push({
          severity: 'blocking',
          code: 'WIN_EFFECT_OVER_BAND',
          message: `Win "${label}" relies on "${tierGated.effect.op}" on the "${tierGated.verb}" approach, too powerful to fire on a "${tierGated.band}" attempt — the engine drops it.`,
          repairInstruction: `The win effect "${tierGated.effect.op}" on the "${tierGated.verb}" approach in scene "${tierGated.nodeId}" needs difficulty "${req}" to fire (it is "${tierGated.band}" now). Raise that approach to "${req}", or move the effect onto a "${req}"-or-harder approach. Change nothing else.`,
          targets: { goalId: g.id, nodeId: tierGated.nodeId, verb: tierGated.verb, effectOp: tierGated.effect.op, requiredBand: req },
        });
      } else if (inDeadTerminal) {
        push({
          severity: 'blocking',
          code: 'WIN_IN_TERMINAL_NODE',
          message: `Win "${label}" is only produced in scene "${inDeadTerminal.nodeId}", which is marked as an ending — the player can never act there, so it never fires.`,
          repairInstruction: `Scene "${inDeadTerminal.nodeId}" is marked isTerminal:true but holds the only approach that wins "${label}". Reaching a terminal scene ends the quest before its approaches can run. Set "${inDeadTerminal.nodeId}".isTerminal to false (an endScene effect still ends it), or move the winning approach to a non-ending scene.`,
          targets: { goalId: g.id, nodeId: inDeadTerminal.nodeId },
        });
      } else {
        push({
          severity: 'blocking',
          code: 'WIN_NODE_UNREACHABLE',
          message: `Win "${label}" can only be produced in a scene nothing routes to (or against an entity the entry scene lacks).`,
          repairInstruction: `The only effect that wins "${label}" sits in an unreachable scene or targets an entity in no reachable scene. Add a route to that scene, move the effect into a reachable scene, or retarget it to a reachable-scene entity (${rosterList}).`,
          targets: { goalId: g.id },
        });
      }
      continue;
    }
    if (!fireable.some((s) => s.grade === 'success' || s.grade === 'partial')) {
      const s = fireable[0]!;
      push({
        severity: 'blocking',
        code: 'WIN_ONLY_ON_FAILURE',
        message: `Win "${label}" can only be reached by FAILING the "${s.verb}" check (its win effect is on a "${s.grade}" outcome).`,
        repairInstruction: `The effect that wins "${label}" is only in the "${s.grade}" outcome of the "${s.verb}" approach in scene "${s.nodeId}". Copy it into that approach's "success" (and ideally "partial") array so nailing the roll wins.`,
        targets: { goalId: g.id, nodeId: s.nodeId, verb: s.verb },
      });
      continue;
    }
    const t = thresholdReach(p, graph, actable, roster, sites);
    if (t && t.bestStep > 0 && !t.ok) {
      push({
        severity: 'blocking',
        code: 'WIN_THRESHOLD_UNREACHABLE',
        message: `Win "${label}" can't reach ${describePredicate(p)} from ${t.start} in ${graph.maxTurns} turns (best step ${t.bestStep}).`,
        repairInstruction: `Win goal "${label}" needs ${describePredicate(p)} but from ${t.start} the best per-success change (${t.bestStep}) can't get there in ${graph.maxTurns} turns. Increase the deciding adjustStat delta (<= ${QUEST.STAT_DELTA_MAX}), raise maxTurns (cap ${QUEST.MAX_TURNS_CEILING}), or lower the goal value.`,
        targets: { goalId: g.id, entityId: p.entityId },
      });
      continue;
    }
  }
  // Catch-all: if no win is tier-reachable yet nothing above fired, emit one blocker.
  if (wins.length > 0 && !isWinReachableTiered(graph) && !problems.some((p) => p.severity === 'blocking' && p.code.startsWith('WIN'))) {
    push({
      severity: 'blocking',
      code: 'WIN_DECOUPLED',
      message: 'No win goal can actually be achieved as wired.',
      repairInstruction: 'No win goal is reachable. Ensure a success effect produces exactly what a win goal checks, on an approach whose difficulty unlocks that effect, in a reachable scene, against an entry-scene entity.',
    });
  }

  // --- Lose goals: auto-lose / win conflict. (s0 computed above.) ---
  for (const g of graph.goals.filter((x) => x.outcome === 'lose')) {
    const p = g.predicate;
    const label = g.label || g.id;
    const trivialTurn = p.kind === 'turnGte' && !p.negate && (p.value ?? 0) <= 1;
    if ((p.kind === 'always' && !p.negate) || trivialTurn || evalPredicate(p, s0)) {
      push({
        severity: 'blocking',
        code: 'AUTO_LOSE_AT_START',
        message: `Lose goal "${label}" is already true at the start, so the quest is lost on turn 1.`,
        repairInstruction: `Lose goal "${label}" (${describePredicate(p)}) is satisfiable at the start. Tie it to a flag ONLY a fail/complication sets during play, or remove it. A lose goal must never be true at the start.`,
        targets: { goalId: g.id },
      });
      continue;
    }
    const conflict = wins.some((w) => samePredicate(w.predicate, p) || (p.kind === 'flag' && !p.negate && w.predicate.kind === 'flag' && !w.predicate.negate && w.predicate.flag === p.flag));
    if (conflict)
      push({
        severity: 'blocking',
        code: 'WIN_LOSE_CONFLICT',
        message: `Lose goal "${label}" fires on the same condition as a win goal; losing is checked first, so winning is impossible.`,
        repairInstruction: `Lose goal "${label}" shares its condition with a win goal (${describePredicate(p)}). Losing is checked before winning — give the lose goal a distinct condition (a flag only a FAIL sets) or remove it.`,
        targets: { goalId: g.id },
      });
  }

  // --- Warmth (partner anchor) integrity. ---
  const warmthSites = sites.filter((s) => s.effect.op === 'adjustWarmth');
  if (ctx.partnerId) {
    for (const s of warmthSites)
      if (s.effect.characterId !== ctx.partnerId)
        push({
          severity: 'warning',
          code: 'WARMTH_TARGET',
          message: `An adjustWarmth on "${s.verb}" points at the wrong character, so it won't deepen the date.`,
          repairInstruction: `Every adjustWarmth.characterId must be exactly "${ctx.partnerId}" (the dated partner), not a scene-entity id. Fix the "${s.verb}" approach in scene "${s.nodeId}".`,
          targets: { nodeId: s.nodeId, verb: s.verb },
        });
    if (!warmthSites.some((s) => s.effect.characterId === ctx.partnerId))
      push({
        severity: 'warning',
        code: 'PARTNER_NOT_DEEPENED',
        message: 'This is a romance quest but nothing deepens the bond with the partner.',
        repairInstruction: `Add {"op":"adjustWarmth","characterId":"${ctx.partnerId}","delta":2} to a meaningful SUCCESS on a normal-or-harder approach.`,
      });
  } else {
    for (const s of warmthSites)
      push({
        severity: 'warning',
        code: 'WARMTH_ON_NONROMANCE',
        message: `An adjustWarmth on "${s.verb}" has no effect — this quest isn't anchored to a date.`,
        repairInstruction: `Remove every adjustWarmth effect (this quest has no romance anchor), e.g. on the "${s.verb}" approach in scene "${s.nodeId}".`,
        targets: { nodeId: s.nodeId, verb: s.verb },
      });
  }

  // --- Reference integrity (effects): dangling entity / node / item refs. ---
  for (const s of sites) {
    const e = s.effect;
    if ((e.op === 'moveEntityToFaction' || (e.op === 'adjustStat' && e.entityId)) && e.entityId && !roster.has(e.entityId))
      push({
        severity: 'warning',
        code: 'EFFECT_ENTITY_REF',
        message: `Effect "${e.op}" on "${s.verb}" targets "${e.entityId}", which exists in no reachable scene — it does nothing.`,
        repairInstruction: `Effect "${e.op}" on "${s.verb}" in "${s.nodeId}" targets entity "${e.entityId}", not defined in any reachable scene (reachable entities: ${rosterList}). Retarget to one of ${rosterList}, or define it in this scene.`,
        targets: { nodeId: s.nodeId, verb: s.verb, entityId: e.entityId },
      });
    if (e.op === 'moveToNode' && e.nodeId && !nodeIds.includes(e.nodeId))
      push({
        severity: 'warning',
        code: 'MOVETONODE_DANGLING',
        message: `"${s.verb}" moves to scene "${e.nodeId}", which doesn't exist.`,
        repairInstruction: `moveToNode on "${s.verb}" targets missing scene "${e.nodeId}" (scenes: ${nodeIds.join(', ')}). Point it at a real scene or replace it with {"op":"endScene","status":"resolved"}.`,
        targets: { nodeId: s.nodeId, verb: s.verb },
      });
    if (e.op === 'removeItem' && e.itemId && !grantedItems.has(e.itemId))
      push({
        severity: 'warning',
        code: 'ITEM_REF_MISMATCH',
        message: `"${s.verb}" removes item "${e.itemId}", which is never granted.`,
        repairInstruction: `removeItem "${e.itemId}" on "${s.verb}" is never granted (granted: ${[...grantedItems].join(', ') || 'none'}). Grant it first on a success, or fix the id.`,
        targets: { nodeId: s.nodeId, verb: s.verb, itemId: e.itemId },
      });
    if (e.op === 'adjustStat' && e.entityId && e.key && e.key !== 'hp' && e.key !== 'disposition')
      push({
        severity: 'warning',
        code: 'ENTITY_STAT_BAD_KEY',
        message: `adjustStat on entity "${e.entityId}" uses key "${e.key}"; an entity stat must be hp or disposition.`,
        repairInstruction: `adjustStat on entity "${e.entityId}" (on "${s.verb}") uses key "${e.key}" — set it to "hp" or "disposition" (whichever this approach changes).`,
        targets: { nodeId: s.nodeId, verb: s.verb, entityId: e.entityId },
      });
  }

  // --- Reference integrity (predicates on lose goals + routes + affordance preconditions). ---
  const predSites: { p: StatePredicate; where: string; goalId?: string; isWin: boolean }[] = [];
  for (const g of graph.goals) predSites.push({ p: g.predicate, where: g.outcome === 'lose' ? 'lose goal' : 'win goal', goalId: g.id, isWin: g.outcome === 'win' });
  for (const n of graph.nodes) {
    for (const edge of n.edges) predSites.push({ p: edge.when, where: `route ${n.id}->${edge.to}`, isWin: false });
    for (const a of n.affordances) if (a.when) predSites.push({ p: a.when, where: `the "${a.verb}" precondition in "${n.id}"`, isWin: false });
  }
  for (const { p: pred, where, goalId, isWin } of predSites) {
    if (isWin) continue; // win-goal predicates are diagnosed (with richer messages) in the win loop above
    for (const p of predLeaves(pred)) {
      if (p.negate) continue; // a "NOT" over a missing entity/flag is satisfiable, not a bug
      if ((p.kind === 'entityFaction' || p.kind === 'entityDisposition' || p.kind === 'entityHp') && (!p.entityId || !roster.has(p.entityId)))
        push({
          severity: 'warning',
          code: 'PRED_ENTITY_REF',
          message: `A ${where} references entity "${p.entityId ?? '(none)'}", which exists in no reachable scene.`,
          repairInstruction: `The ${where} references entity "${p.entityId ?? ''}", not defined in any reachable scene (reachable entities: ${rosterList}). Point it at one of ${rosterList}.`,
          targets: { goalId, entityId: p.entityId },
        });
      if (p.kind === 'atNode' && (!p.nodeId || !nodeIds.includes(p.nodeId)))
        push({
          severity: 'warning',
          code: 'ATNODE_DANGLING',
          message: `A ${where} checks scene "${p.nodeId ?? '(none)'}", which doesn't exist.`,
          repairInstruction: `The ${where} checks atNode "${p.nodeId ?? ''}" (scenes: ${nodeIds.join(', ')}). Point it at a real scene.`,
          targets: { goalId },
        });
      if (p.kind === 'hasItem' && (!p.itemId || !grantedItems.has(p.itemId)))
        push({
          severity: 'warning',
          code: 'ITEM_REF_MISMATCH',
          message: `A ${where} checks item "${p.itemId ?? '(none)'}", which is never granted.`,
          repairInstruction: `The ${where} checks item "${p.itemId ?? ''}" (granted: ${[...grantedItems].join(', ') || 'none'}). Grant it on a success or fix the id.`,
          targets: { goalId, itemId: p.itemId },
        });
      if (p.kind === 'flag' && p.flag && !sites.some((s) => s.effect.op === 'setFlag' && s.effect.flag === p.flag))
        push({
          severity: 'warning',
          code: 'PRED_FLAG_NEVER_SET',
          message: `A ${where} checks flag "${p.flag}", which no approach ever sets.`,
          repairInstruction: `The ${where} checks flag "${p.flag}" but no success effect sets it — so it (a gate/route) can never open. Set "${p.flag}" on a reachable approach's success, or fix the flag name.`,
          targets: { goalId, flag: p.flag },
        });
    }
  }

  // --- Tier-dropped FLAVOR effects (not win-advancing, not warmth) — the editor's "won't fire". ---
  const winAdvancing = new Set(wins.flatMap((g) => sites.filter((s) => effectAdvances(g.predicate, s.effect)).map((s) => s.effect)));
  for (const s of sites) {
    const e = s.effect;
    if (e.op === 'adjustWarmth' || winAdvancing.has(e)) continue;
    if (!tierUnlockedBy(s.band).has(effectTier(e))) {
      const req = minBandForTier(effectTier(e));
      push({
        severity: 'warning',
        code: 'TIER_DROPPED_FLAVOR',
        message: `"${e.op}" on "${s.verb}" (${s.grade}) is too big for a "${s.band}" approach and is silently dropped.`,
        repairInstruction: `"${e.op}" on "${s.verb}" (${s.grade}) needs difficulty "${req}". Raise the approach to "${req}", shrink the effect (a stat change of 5 or less fires anywhere), or remove it.`,
        targets: { nodeId: s.nodeId, verb: s.verb, effectOp: e.op, requiredBand: req },
      });
    }
  }

  // --- An unusable "noop" affordance (an invalid verb was .catch()-coerced). ---
  for (const n of graph.nodes)
    for (const a of n.affordances)
      if (a.verb === 'noop')
        push({
          severity: 'warning',
          code: 'NOOP_AFFORDANCE',
          message: `Scene "${n.id}" has an unusable "noop" approach (an invalid verb was discarded).`,
          repairInstruction: `Replace the "noop" verb in scene "${n.id}" with a real action verb that matches its hint and effects.`,
          targets: { nodeId: n.id },
        });

  // --- Playability quality. ---
  if (!entry.setup.trim())
    push({
      severity: 'warning',
      code: 'EMPTY_SETUP',
      message: `The opening scene "${entry.id}" has no setup text for the player.`,
      repairInstruction: `Add a vivid one-to-two sentence setup to entry scene "${entry.id}".`,
      targets: { nodeId: entry.id },
    });
  if (entry.affordances.length > 0 && entry.affordances.every((a) => !a.hint.trim()))
    push({
      severity: 'warning',
      code: 'NO_HINTS',
      message: `The opening scene "${entry.id}" gives the player no hints about what to try.`,
      repairInstruction: `Add a one-line "hint" to each approach in entry scene "${entry.id}".`,
      targets: { nodeId: entry.id },
    });
  // Within a single scene that HAS a SOLE-winning approach, any OTHER success-bearing approach
  // that does nothing toward a win is a dead-end choice. "Sole-win" flags = a top-level flag
  // goal, or a flag clause of an `any` (OR) goal — NOT a clause of an `all` (AND) goal (those
  // are necessary-not-sufficient, so an approach setting one is a real progress step, not a
  // dead end). Approaches that UNLOCK something (set a flag a precondition/edge consumes) or
  // MOVE the scene are exempt. Scoped per-scene; one note per (scene, approach).
  const winFlags = new Set<string>();
  for (const g of wins) {
    const p = g.predicate;
    if (p.kind === 'flag' && !p.negate && p.flag) winFlags.add(p.flag);
    else if (p.kind === 'any') for (const c of p.clauses ?? []) if (c.kind === 'flag' && !c.negate && c.flag) winFlags.add(c.flag);
  }
  if (winFlags.size > 0) {
    // Flags that gate any affordance or route — setting one is a meaningful unlock, not a dead end.
    const gateFlags = new Set<string>();
    for (const n of graph.nodes) {
      for (const a of n.affordances) for (const lp of predLeaves(a.when ?? { kind: 'always' })) if (lp.kind === 'flag' && lp.flag) gateFlags.add(lp.flag);
      for (const edge of n.edges) for (const lp of predLeaves(edge.when)) if (lp.kind === 'flag' && lp.flag) gateFlags.add(lp.flag);
    }
    const setsAnyWinFlag = (a: NodeAffordance) => a.effects.success.some((e) => e.op === 'setFlag' && e.flag && winFlags.has(e.flag));
    const isProgress = (a: NodeAffordance) =>
      a.effects.success.some((e) => (e.op === 'setFlag' && e.flag && gateFlags.has(e.flag)) || e.op === 'moveToNode');
    for (const n of graph.nodes) {
      if (!actable.has(n.id) || !n.affordances.some(setsAnyWinFlag)) continue; // only scenes where a win is actually decided
      for (const a of n.affordances)
        if (a.effects.success.length > 0 && !setsAnyWinFlag(a) && !isProgress(a))
          push({
            severity: 'warning',
            code: 'WIN_SINGLE_PATH_DEAD_ENDS',
            message: `The "${a.verb}" approach in "${n.id}" succeeds but can't win, while another approach in the same scene can.`,
            repairInstruction: `Give the "${a.verb}" approach in "${n.id}" a winning success too (set one of the win flags), or accept it as a non-winning choice — so the scene's options don't read as a trap.`,
            targets: { nodeId: n.id, verb: a.verb },
          });
    }
  }

  // --- Empty compound (all/any with no clauses) anywhere: an empty AND is vacuously true (a
  // win fires turn 1 / a lose auto-fires), an empty OR is never true (an unwinnable goal). ---
  const allPredicates: StatePredicate[] = [
    ...graph.goals.map((g) => g.predicate),
    ...graph.nodes.flatMap((n) => [...n.edges.map((e) => e.when), ...n.affordances.map((a) => a.when).filter((w): w is StatePredicate => !!w)]),
  ];
  for (const p of allPredicates)
    if ((p.kind === 'all' || p.kind === 'any') && (p.clauses ?? []).length === 0)
      push({
        severity: 'warning',
        code: 'COMPOUND_EMPTY',
        message: `An "${p.kind}" (${p.kind === 'all' ? 'AND' : 'OR'}) condition has no sub-conditions, so it ${p.kind === 'all' ? 'is always true' : 'is never true'}.`,
        repairInstruction: `Give the "${p.kind}" condition at least one sub-condition, or replace it with a single leaf condition.`,
      });

  // --- A reachable, non-terminal scene where NO approach can ever become available (every
  // `when` is unsatisfiable, or there are none): the player gets stranded there (the referee
  // force-loses it at runtime, but warn the author). ---
  for (const n of graph.nodes) {
    if (n.id === entryId || n.isTerminal || !reachable.has(n.id)) continue;
    const everAvailable = n.affordances.some((a) => !a.when || predSatisfiable(a.when, graph, roster, sites));
    if (n.affordances.length > 0 && !everAvailable)
      push({
        severity: 'warning',
        code: 'NODE_SOFTLOCK',
        message: `Scene "${n.id}" can be entered, but every approach there is gated by a condition that can never be met — the player gets stuck.`,
        repairInstruction: `In scene "${n.id}", make at least one approach available: drop a "when" precondition, or gate it on a flag a reachable success actually sets.`,
        targets: { nodeId: n.id },
      });
  }

  // A non-entry TERMINAL scene ends the quest the instant it's reached, so its approaches
  // never run. Flag effect-bearing approaches there (a lone endScene is the legitimate
  // "this scene IS the ending" pattern, so it's exempt).
  for (const n of graph.nodes) {
    if (n.id === entryId || !n.isTerminal) continue;
    if (n.affordances.some((a) => a.effects.success.some((e) => e.op !== 'endScene')))
      push({
        severity: 'warning',
        code: 'TERMINAL_NODE_HAS_ACTIONS',
        message: `Scene "${n.id}" is marked as an ending (isTerminal) but has approaches that do things — the player can never act there, since arriving ends the quest.`,
        repairInstruction: `Set "${n.id}".isTerminal to false so the player can use its approaches (an endScene effect still ends the quest), or move those approaches to a non-ending scene.`,
        targets: { nodeId: n.id },
      });
  }

  // An `always` / turn-0 edge routes the player onward on their FIRST action in the scene —
  // they never really get to act there (and routing unconditionally into a terminal node is
  // the "win on turn 1" trap the user hit).
  for (const n of graph.nodes)
    for (const edge of n.edges) {
      const w = edge.when;
      if (!w.negate && (w.kind === 'always' || (w.kind === 'turnGte' && (w.value ?? 0) <= 1)))
        push({
          severity: 'warning',
          code: 'UNCONDITIONAL_EDGE',
          message: `Scene "${n.id}" routes to "${edge.to}" unconditionally — the player is moved there on their first action, so they can't really act in "${n.id}".`,
          repairInstruction: `Replace the unconditional route from "${n.id}" to "${edge.to}" with a "move" approach the player chooses, or key the route on a flag a success sets, so "${n.id}" can actually be played.`,
          targets: { nodeId: n.id },
        });
    }

  // If SOME win goal is genuinely reachable, the quest IS winnable — so a SECOND, dead
  // win goal (the model's vestigial wire-to-nothing that ensureWinGoal backstops, or a
  // hand-authored extra) is a wart, not a blocker. Downgrade the per-goal reachability
  // blockers to warnings in that case so a winnable quest is never falsely un-saveable.
  // (The quest-level catch-all only fires when NO win is reachable, so it's unaffected.)
  const WIN_REACH_CODES = new Set(['WIN_TURN_GTE_OVER_MAXTURNS', 'WIN_ENTITY_NOT_IN_ENTRY', 'WIN_NODE_UNREACHABLE', 'WIN_IN_TERMINAL_NODE', 'WIN_DECOUPLED', 'WIN_EFFECT_OVER_BAND', 'WIN_ONLY_ON_FAILURE', 'WIN_THRESHOLD_UNREACHABLE']);
  const adjusted = isWinReachableTiered(graph)
    ? problems.map((p) => (p.severity === 'blocking' && WIN_REACH_CODES.has(p.code) ? { ...p, severity: 'warning' as const } : p))
    : problems;
  return dedupeProblems(adjusted);
}

/**
 * Deterministically repair the SAFE, unambiguous coherence defects — no model needed.
 * Only ever WIDENS winnability or relocates/retargets WITHIN the existing shapes; never
 * invents fiction. Re-runs {@link boundQuestGraph} at the end and is idempotent
 * (autoFix(autoFix(g)) deep-equals autoFix(g)). The pipeline runs this BEFORE the model
 * repair loop (to shrink the repair burden) and before ensureWinGoal (the last-resort net).
 */
export function autoFixQuestGraph(graph: QuestGraph, ctx: QuestLintContext): { graph: QuestGraph; fixes: AutoFixNote[] } {
  const g = structuredClone(graph);
  const fixes: AutoFixNote[] = [];
  const note = (code: string, detail: string) => fixes.push({ code, detail });
  const nodeIds = new Set(g.nodes.map((n) => n.id));
  const roster = reachableEntityIds(g); // entities that exist on a reachable path (per-scene)
  const eachAff = (fn: (n: QuestNode, a: NodeAffordance) => void) => {
    for (const n of g.nodes) for (const a of n.affordances) fn(n, a);
  };
  const entryId = entryNode(g).id;
  // Every LEAF win condition across all win goals (a compound AND/OR flattened) — so the
  // win-advancing autofixes act on each clause, not just a top-level leaf predicate.
  const winLeaves = g.goals.filter((x) => x.outcome === 'win').flatMap((x) => predLeaves(x.predicate));

  // Unmark a non-entry node wrongly flagged isTerminal when its OWN approaches decide a win.
  // Reaching a terminal node ends the quest before any approach runs, so a win-deciding
  // approach there can never fire (and an unconditional/`move` route in turns it into an
  // instant, goal-less "win"). Such a node is a climax, not an ending — let the player act
  // there; any endScene effect still ends it. (A real ending — only endScene, no win — keeps
  // isTerminal.) This is the fix for the "attack once → routed to a terminal scene → win" trap.
  for (const node of g.nodes) {
    if (node.id === entryId || !node.isTerminal) continue;
    const decidesWin = node.affordances.some((a) => a.effects.success.some((e) => winLeaves.some((lp) => effectAdvances(lp, e))));
    if (decidesWin) {
      node.isTerminal = false;
      note('AF_UNMARK_DEAD_TERMINAL', `unmarked isTerminal on ${node.id} (its approaches decide a win, which a terminal scene can never run)`);
    }
  }

  // Warmth: retarget to the partner (anchored) or strip entirely (non-romance).
  eachAff((n, a) => {
    for (const grade of ALL_GRADES) {
      const arr = a.effects[grade];
      for (let i = arr.length - 1; i >= 0; i--) {
        const e = arr[i]!;
        if (e.op !== 'adjustWarmth') continue;
        if (ctx.partnerId) {
          if (e.characterId !== ctx.partnerId) {
            note('AF_WARMTH_RETARGET', `retargeted adjustWarmth on ${a.verb} (${n.id}) to ${ctx.partnerId}`);
            e.characterId = ctx.partnerId;
          }
        } else {
          arr.splice(i, 1);
          note('AF_WARMTH_STRIP', `dropped adjustWarmth on ${a.verb} (${n.id}) — no romance anchor`);
        }
      }
    }
  });

  // Drop a moveToNode that points nowhere (mirrors boundQuestGraph's edge pruning).
  eachAff((n, a) => {
    for (const grade of ALL_GRADES) {
      const arr = a.effects[grade];
      for (let i = arr.length - 1; i >= 0; i--) {
        const e = arr[i]!;
        if (e.op === 'moveToNode' && (!e.nodeId || !nodeIds.has(e.nodeId))) {
          arr.splice(i, 1);
          note('AF_DROP_DANGLING_MOVETONODE', `dropped moveToNode->${e.nodeId} on ${a.verb} (${n.id})`);
        }
      }
    }
  });

  // Remap an effect's dangling entityId (one not defined in any reachable scene) to the HOST
  // scene's lone entity — the common single-entity-scene typo. Scoped per-scene (the runtime
  // loads each room's roster), and only when unambiguous (the host node has exactly one entity).
  eachAff((n, a) => {
    if (n.entities.length !== 1) return;
    const only = n.entities[0]!.id;
    for (const grade of ALL_GRADES)
      for (const e of a.effects[grade])
        if ((e.op === 'moveEntityToFaction' || (e.op === 'adjustStat' && e.entityId)) && e.entityId && !roster.has(e.entityId)) {
          note('AF_REMAP_SINGLE_ENTITY', `remapped ${e.op} entityId ${e.entityId}->${only} on ${a.verb} (${n.id})`);
          e.entityId = only;
        }
  });

  // Make an entity adjustStat's stray key explicit (hp if a defeat/hp goal — incl. an hp clause
  // of a compound goal — targets it).
  const hpEntities = new Set(
    g.goals.flatMap((x) => predLeaves(x.predicate)).filter((lp) => lp.kind === 'entityHp').map((lp) => lp.entityId).filter(Boolean) as string[],
  );
  eachAff((n, a) => {
    for (const grade of ALL_GRADES)
      for (const e of a.effects[grade])
        if (e.op === 'adjustStat' && e.entityId && e.key && e.key !== 'hp' && e.key !== 'disposition') {
          const k = hpEntities.has(e.entityId) ? 'hp' : 'disposition';
          note('AF_FIX_ENTITY_STATKEY', `set adjustStat key ${e.key}->${k} on ${a.verb}`);
          e.key = k;
        }
  });

  // Snap an off-list stat to a verb-appropriate one.
  eachAff((n, a) => {
    if (!KNOWN_QUEST_STATS.has(a.stat)) {
      const snap = VERB_DEFAULT_STAT[a.verb] ?? 'grit';
      note('AF_SNAP_UNKNOWN_STAT', `snapped stat ${a.stat}->${snap} on ${a.verb}`);
      a.stat = snap;
    }
  });

  // Drop a lose goal that is true at the start (or 'always' / turnGte<=1).
  {
    const s0 = initialQuestState(g);
    g.goals = g.goals.filter((go) => {
      if (go.outcome !== 'lose') return true;
      const p = go.predicate;
      const auto = (p.kind === 'always' && !p.negate) || (p.kind === 'turnGte' && !p.negate && (p.value ?? 0) <= 1) || evalPredicate(p, s0);
      if (auto) note('AF_DROP_AUTOLOSE', `dropped auto-true lose goal ${go.id}`);
      return !auto;
    });
  }

  // Drop a lose goal that conflicts with a win (same predicate / shared un-negated flag).
  {
    const winPreds = g.goals.filter((x) => x.outcome === 'win').map((x) => x.predicate);
    g.goals = g.goals.filter((go) => {
      if (go.outcome !== 'lose') return true;
      const conflict = winPreds.some((wp) => samePredicate(wp, go.predicate) || (go.predicate.kind === 'flag' && !go.predicate.negate && wp.kind === 'flag' && !wp.negate && wp.flag === go.predicate.flag));
      if (conflict) note('AF_DROP_WINLOSE_CONFLICT', `dropped lose goal ${go.id} conflicting with a win`);
      return !conflict;
    });
  }

  // Copy a win-advancing fail/complication effect into success (adds a success path;
  // never removes the setback). Guarded against the MAX_EFFECTS_PER_OUTCOME cap. Acts on
  // each win-goal LEAF (so a compound AND/OR clause is covered too).
  for (const lp of winLeaves)
    eachAff((n, a) => {
      if (a.effects.success.some((e) => effectAdvances(lp, e))) return;
      for (const grade of ['fail', 'complication'] as const) {
        const hit = a.effects[grade].find((e) => effectAdvances(lp, e));
        if (hit && a.effects.success.length < QUEST.MAX_EFFECTS_PER_OUTCOME && !a.effects.success.some((e) => sameEffect(e, hit))) {
          a.effects.success.push(structuredClone(hit));
          note('AF_FAILGRADE_TO_SUCCESS', `copied ${hit.op} into success on ${a.verb} (${n.id})`);
        }
      }
    });

  // Raise an affordance's difficulty so a win-advancing success/partial effect can FIRE
  // (TIERS_BY_BAND is nested, so raising never drops a previously-firing effect).
  {
    const reachable = reachableNodeIds(g);
    for (const lp of winLeaves)
      for (const n of g.nodes) {
        if (!reachable.has(n.id)) continue;
        for (const a of n.affordances) {
          let req: DifficultyBand = a.difficulty;
          for (const grade of ['success', 'partial'] as const)
            for (const e of a.effects[grade]) {
              if (!effectAdvances(lp, e)) continue;
              if (e.op === 'moveEntityToFaction' && (!e.entityId || !roster.has(e.entityId))) continue;
              if (e.op === 'adjustStat' && e.entityId && !roster.has(e.entityId)) continue;
              const b = minBandForTier(effectTier(e));
              if (bandRank(b) > bandRank(req)) req = b;
            }
          if (bandRank(req) > bandRank(a.difficulty)) {
            note('AF_RAISE_WIN_BAND', `raised ${a.verb} (${n.id}) ${a.difficulty}->${req} so its win effect fires`);
            a.difficulty = req;
          }
        }
      }
  }

  // Give a 'survive' (turnGte) win enough turns to be winnable.
  for (const goal of g.goals.filter((x) => x.outcome === 'win'))
    if (goal.predicate.kind === 'turnGte' && !goal.predicate.negate) {
      const v = goal.predicate.value ?? 0;
      if (v > QUEST.MAX_TURNS_CEILING) {
        goal.predicate.value = QUEST.MAX_TURNS_CEILING;
        g.maxTurns = QUEST.MAX_TURNS_CEILING;
        note('AF_RAISE_MAXTURNS', `clamped survive win + maxTurns to ${QUEST.MAX_TURNS_CEILING}`);
      } else if (v > g.maxTurns) {
        note('AF_RAISE_MAXTURNS', `raised maxTurns ${g.maxTurns}->${v} for a survive win`);
        g.maxTurns = v;
      }
    }

  return { graph: boundQuestGraph(g), fixes };
}

// ============================================================================
// View DTOs (server → client). Not persisted; rebuilt from state each request.
// ============================================================================

/** A quest as shown on the Wayfarer lobby (eligibility-annotated). */
export interface QuestSummaryView {
  id: string;
  name: string;
  blurb: string;
  /** Partner-anchored quests show the romance anchor + warmth lock. */
  partnerId: string | null;
  partnerName: string | null;
  minWarmthBand: number;
  /** Whether the player may start it now (warmth gate met, no other quest active). */
  eligible: boolean;
  /** A short human reason when not eligible (e.g. "Grow closer to Minh An first"). */
  lockReason: string | null;
}

/** One narrated beat in the running scene log. */
export interface QuestLogEntry {
  turn: number;
  playerText: string;
  narration: string;
  grade: OutcomeGrade;
  /** A do-nothing beat (off-menu / non-diegetic input) — the client hides the chip. */
  neutral?: boolean;
  /** A narrator-voiced neutral beat (a reply or a useless-attempt description; rendered
   *  normally, unlike an inert noop which is muted). */
  voiced?: boolean;
}

/** An entity portrait in the live scene. */
export interface QuestEntityView {
  id: string;
  name: string;
  faction: QuestFaction;
  disposition: number;
  hp: number | null;
}

/** The live scene the Wayfarer "Scene" screen renders (and resumes from). */
export interface QuestSceneView {
  questId: string;
  name: string;
  status: QuestStatus;
  /** Current node's display setup text. */
  setup: string;
  nodeKind: string;
  /** "What you might try" — affordance hints, NOT a fixed button list. */
  hints: string[];
  entities: QuestEntityView[];
  log: QuestLogEntry[];
  turn: number;
  maxTurns: number;
  /** Goal labels, for an unobtrusive objective line. */
  objectives: string[];
  /** Set once the quest resolved — drives the Resolution screen. */
  resolution: {
    outcome: 'win' | 'lose';
    label: string;
    moneyEarned: number;
    /** Signed: positive = grew closer, negative = strained. */
    warmthChange: number;
    /** The romance anchor warmth routed to (so the screen can name them). */
    partnerName: string | null;
  } | null;
}

// --- small pure utilities ---------------------------------------------------

function cloneState(s: QuestState): QuestState {
  return {
    nodeId: s.nodeId,
    entities: s.entities.map((e) => ({ ...e, flags: [...e.flags] })),
    flags: [...s.flags],
    inventory: s.inventory.map((i) => ({ ...i })),
    stats: { ...s.stats },
    turn: s.turn,
  };
}

/** Two effects "match" if they target the same op + primary operand (so an LLM
 *  proposal can narrow the authored menu without having to byte-match magnitudes). */
function sameEffect(a: Effect, b: Effect): boolean {
  if (a.op !== b.op) return false;
  switch (a.op) {
    case 'setFlag':
    case 'clearFlag':
      return a.flag === b.flag;
    case 'moveEntityToFaction':
      return a.entityId === b.entityId;
    case 'adjustStat':
      return a.key === b.key && a.entityId === b.entityId;
    case 'adjustWarmth':
      return a.characterId === b.characterId;
    case 'grantItem':
    case 'removeItem':
      return a.itemId === b.itemId;
    case 'moveToNode':
      return a.nodeId === b.nodeId;
    default:
      return true;
  }
}

/** The harder of two bands (an affordance floor vs. the Interpreter's read). */
function maxBand(a: DifficultyBand, b: DifficultyBand): DifficultyBand {
  const order: DifficultyBand[] = ['trivial', 'normal', 'hard', 'desperate'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))] ?? a;
}

function cmp(v: number, op: 'lte' | 'gte', target: number): boolean {
  return op === 'lte' ? v <= target : v >= target;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.round(clamp(v, lo, hi));
}
