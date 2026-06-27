import { z } from 'zod';
import { QUEST } from './constants';
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
]);
export type PredicateKind = z.infer<typeof PredicateKindSchema>;

export const StatePredicateSchema = z.object({
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

  // 1. VALIDATE — find the affordance for the proposed verb.
  const matched = node.affordances.find((a) => a.verb === action.verb) ?? null;

  // 1a. NEUTRAL DEGRADE (the plan's "fiction valve") — ANY verb the scene offers no
  // affordance for resolves to a do-nothing beat: no roll, no effects, no turn consumed,
  // no stall. This is what stops an OFF-MENU verb from being reskinned as the node's
  // FIRST affordance and accidentally winning (the "use a rock" / off-menu "deceive"
  // that fired the Force/Aid success). The only verbs that mutate state are the ones the
  // author actually offered here. A `noop` (self-harm / meta / nonsense) is INERT — a
  // fixed safe line, never sent to the model; every OTHER unmatched verb is VOICED — the
  // narrator describes the reply (`talk`) or why the attempt came to nothing.
  if (action.verb === 'noop' || !matched) {
    return {
      newState: next, // turn unchanged — nothing mechanical happened
      outcome: { grade: 'fail', appliedEffects: [], rejected: [], expression: 'thoughtful', ended: false, neutral: true, voiced: action.verb !== 'noop' },
    };
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
  const result = predicateCore(p, state);
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

/** Build the initial runtime state for a quest from its authored entry node. */
export function initialQuestState(graph: QuestGraph, playerStats: Record<string, number> = {}): QuestState {
  const node = graph.nodes.find((n) => n.id === graph.entryNodeId) ?? graph.nodes[0]!;
  return QuestStateSchema.parse({
    nodeId: node.id,
    entities: node.entities.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      faction: d.faction,
      disposition: d.disposition,
      hp: d.hp,
      flags: [],
    })),
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

/** Defensive repair of an UNTRUSTED graph object so `QuestGraphSchema.parse` can't
 *  throw on the things the strict schema rejects: empty/duplicate ids (nodes,
 *  entities, goals) get unique fallbacks, and out-of-range numbers (maxTurns, entity
 *  disposition/hp) are clamped. A mediocre LLM that omits ids or over-ranges a number
 *  is REPAIRED here rather than rejected — everything else the schema coerces. */
function preClampGraph(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const g = input as Record<string, unknown>;
  const out: Record<string, unknown> = { ...g };
  if ('maxTurns' in g) out.maxTurns = numOr(g.maxTurns, 1, QUEST.MAX_TURNS_CEILING, QUEST.DEFAULT_MAX_TURNS);
  if (Array.isArray(g.nodes)) {
    const usedNodes = new Set<string>();
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
      return { ...node, id: pickId(node.id, `scene${i + 1}`, usedNodes), entities };
    });
  }
  if (Array.isArray(g.goals)) {
    const usedGoals = new Set<string>();
    out.goals = g.goals.map((go, i) => {
      if (!go || typeof go !== 'object') return go;
      const goal = go as Record<string, unknown>;
      return { ...goal, id: pickId(goal.id, `goal${i + 1}`, usedGoals) };
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

/** Predicate schema for generation — coerces an off-list kind to a harmless one. */
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
});

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
