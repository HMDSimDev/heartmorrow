import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  QuestGraphSchema,
  QuestActionSchema,
  resolveQuestAction,
  boundQuestGraph,
  isWinReachable,
  gradeFromRoll,
  successChance,
  effectTier,
  initialQuestState,
  evalPredicate,
  type QuestAction,
} from './quest';
import { QUEST } from './constants';

// Use the Zod INPUT types for authoring fixtures so defaulted fields stay optional.
type GraphInput = z.input<typeof QuestGraphSchema>;
type ActionInput = z.input<typeof QuestActionSchema>;

// A small one-scene quest: talk the hostile guard into switching sides, with a
// "charm the dragon for its hoard" affordance wired in to pressure-test the
// proportionality table. Parsed through the schema so defaults are exercised too.
function guardGraph(over: Partial<GraphInput> = {}) {
  return QuestGraphSchema.parse({
    entryNodeId: 'gate',
    maxTurns: 8,
    timeoutOutcome: 'resolved',
    nodes: [
      {
        id: 'gate',
        kind: 'standoff',
        setup: 'A guard bars the gate.',
        entities: [{ id: 'guard', name: 'Captain Reyes', faction: 'hostile', disposition: 0, hp: 30 }],
        affordances: [
          {
            verb: 'persuade',
            stat: 'charm',
            difficulty: 'hard',
            hint: 'Tell the guard his lord already sold him out.',
            effects: {
              success: [
                { op: 'moveEntityToFaction', entityId: 'guard', faction: 'ally' },
                { op: 'setFlag', flag: 'guard.recruited' },
                { op: 'adjustWarmth', characterId: 'char.partner', delta: 2 },
              ],
              partial: [{ op: 'adjustStat', key: 'disposition', entityId: 'guard', delta: 5 }],
              fail: [],
              complication: [{ op: 'adjustStat', key: 'hp', entityId: 'guard', delta: 0 }],
            },
          },
          {
            // The game-break attempt: a TRIVIAL framing that proposes a fortune.
            verb: 'charm',
            stat: 'charm',
            difficulty: 'trivial',
            hint: 'Charmingly ask for the whole hoard.',
            effects: {
              success: [
                { op: 'addMoney', amount: 99999 },
                { op: 'grantItem', itemId: 'legendary_hoard', qty: 1 },
              ],
              partial: [],
              fail: [],
              complication: [],
            },
          },
        ],
        edges: [],
        isTerminal: false,
      },
    ],
    goals: [
      {
        id: 'win',
        kind: 'persuade',
        outcome: 'win',
        label: 'Win the captain over',
        predicate: { kind: 'entityFaction', entityId: 'guard', faction: 'ally' },
      },
    ],
    ...over,
  });
}

const persuade = (over: Partial<ActionInput> = {}): QuestAction =>
  QuestActionSchema.parse({
    verb: 'persuade',
    stat: 'charm',
    difficulty: 'hard',
    proposedEffects: [
      { op: 'moveEntityToFaction', entityId: 'guard', faction: 'ally' },
      { op: 'setFlag', flag: 'guard.recruited' },
      { op: 'adjustWarmth', characterId: 'char.partner', delta: 2 },
    ],
    ...over,
  });

describe('gradeFromRoll', () => {
  it('bands the failure region just-missed → mid → far', () => {
    const c = 0.4;
    expect(gradeFromRoll(0.1, c)).toBe('success');
    expect(gradeFromRoll(0.5, c)).toBe('partial'); // over = 0.166
    expect(gradeFromRoll(0.7, c)).toBe('fail'); // over = 0.5
    expect(gradeFromRoll(0.95, c)).toBe('complication'); // over = 0.916
  });
  it('treats a certain check as always-success and never divides by zero', () => {
    expect(gradeFromRoll(0.99, 1)).toBe('success'); // chance 1 ⇒ always success
    expect(gradeFromRoll(0.999999, 0.999999)).toBe('partial'); // r==chance, no NaN
  });
});

describe('successChance', () => {
  it('bends the band by the tested stat (±0.25)', () => {
    expect(successChance('hard', 50)).toBeCloseTo(0.4, 5);
    expect(successChance('hard', 90)).toBeCloseTo(0.6, 5);
    expect(successChance('hard', 10)).toBeCloseTo(0.2, 5);
    expect(successChance('trivial', 100)).toBe(0.97); // clamped ceiling
  });
});

describe('proportionality (effectTier)', () => {
  it('ranks ops by op + magnitude', () => {
    expect(effectTier({ op: 'setFlag', flag: 'x' })).toBe('cosmetic');
    expect(effectTier({ op: 'moveEntityToFaction', entityId: 'g', faction: 'ally' })).toBe('heavy');
    expect(effectTier({ op: 'endScene', status: 'resolved' })).toBe('spine');
    expect(effectTier({ op: 'adjustStat', key: 'disposition', delta: 4 })).toBe('cosmetic');
    expect(effectTier({ op: 'adjustStat', key: 'disposition', delta: 15 })).toBe('heavy');
  });
});

describe('resolveQuestAction — the emergent success', () => {
  it('flips the guard on a hard success and fires the win goal', () => {
    const graph = guardGraph();
    const state = initialQuestState(graph, { charm: 90 });
    const { newState, outcome } = resolveQuestAction(state, graph, persuade(), 0.1);
    expect(outcome.grade).toBe('success');
    expect(newState.entities[0]!.faction).toBe('ally');
    expect(newState.flags).toContain('guard.recruited');
    expect(outcome.ended).toBe(true);
    expect(outcome.endGoal).toEqual({ outcome: 'win', label: 'Win the captain over' });
  });

  it('is fully deterministic given the same roll', () => {
    const graph = guardGraph();
    const state = initialQuestState(graph, { charm: 90 });
    const a = resolveQuestAction(state, graph, persuade(), 0.1);
    const b = resolveQuestAction(state, graph, persuade(), 0.1);
    expect(a).toEqual(b);
    // a different roll lands a different grade
    const c = resolveQuestAction(state, graph, persuade(), 0.99);
    expect(c.outcome.grade).not.toBe('success');
  });
});

describe('resolveQuestAction — the game-break attempt (the dragon hoard)', () => {
  it('rejects material/heavy effects proposed under a trivial framing', () => {
    const graph = guardGraph();
    const state = initialQuestState(graph, { charm: 90 });
    const action = QuestActionSchema.parse({
      verb: 'charm',
      stat: 'charm',
      difficulty: 'trivial',
      proposedEffects: [
        { op: 'addMoney', amount: 99999 },
        { op: 'grantItem', itemId: 'legendary_hoard', qty: 1 },
      ],
    });
    const { newState, outcome } = resolveQuestAction(state, graph, action, 0.1);
    expect(outcome.grade).toBe('success'); // the fiction let them ASK...
    expect(outcome.appliedEffects).toHaveLength(0); // ...the table refused the loot
    expect(outcome.rejected.length).toBeGreaterThanOrEqual(2);
    expect(newState.stats['_moneyAccrued'] ?? 0).toBe(0);
    expect(newState.inventory).toHaveLength(0);
  });
});

describe('caps', () => {
  it('clamps warmth magnitude to WARMTH_DELTA_MAX', () => {
    const graph = guardGraph({
      nodes: [
        {
          id: 'gate',
          kind: 'scene',
          setup: '',
          entities: [],
          edges: [],
          isTerminal: false,
          affordances: [
            {
              verb: 'aid',
              stat: 'charm',
              difficulty: 'hard',
              hint: '',
              effects: { success: [{ op: 'adjustWarmth', characterId: 'c', delta: 10 }], partial: [], fail: [], complication: [] },
            },
          ],
        },
      ],
      goals: [],
    });
    const state = initialQuestState(graph, { charm: 99 });
    const action = QuestActionSchema.parse({ verb: 'aid', stat: 'charm', difficulty: 'hard', proposedEffects: [] });
    const { outcome } = resolveQuestAction(state, graph, action, 0.01);
    expect(outcome.grade).toBe('success');
    expect(outcome.appliedEffects[0]).toMatchObject({ op: 'adjustWarmth', delta: QUEST.WARMTH_DELTA_MAX });
  });

  it('clamps addMoney to the remaining per-quest room', () => {
    const graph = guardGraph({
      nodes: [
        {
          id: 'gate',
          kind: 'scene',
          setup: '',
          entities: [],
          edges: [],
          isTerminal: false,
          affordances: [
            {
              verb: 'aid',
              stat: 'wits',
              difficulty: 'hard',
              hint: '',
              effects: { success: [{ op: 'addMoney', amount: 60 }], partial: [], fail: [], complication: [] },
            },
          ],
        },
      ],
      goals: [],
    });
    const state = initialQuestState(graph, { wits: 99 });
    state.stats['_moneyAccrued'] = 110; // only 10 of the 120 cap remains
    const action = QuestActionSchema.parse({ verb: 'aid', stat: 'wits', difficulty: 'hard', proposedEffects: [] });
    const { outcome, newState } = resolveQuestAction(state, graph, action, 0.01);
    expect(outcome.appliedEffects[0]).toMatchObject({ op: 'addMoney', amount: 10 });
    expect(newState.stats['_moneyAccrued']).toBe(120);
  });

  it('caps CUMULATIVE addMoney within one outcome to the per-quest room', () => {
    const graph = guardGraph({
      goals: [],
      nodes: [
        {
          id: 'gate',
          kind: 'scene',
          setup: '',
          entities: [],
          edges: [],
          isTerminal: false,
          affordances: [
            {
              verb: 'aid',
              stat: 'wits',
              difficulty: 'hard',
              hint: '',
              // two payouts in one success menu — must not collectively exceed the cap
              effects: { success: [{ op: 'addMoney', amount: 60 }, { op: 'addMoney', amount: 60 }], partial: [], fail: [], complication: [] },
            },
          ],
        },
      ],
    });
    const state = initialQuestState(graph, { wits: 99 });
    state.stats['_moneyAccrued'] = 70; // only 50 of the 120 cap remains
    const action = QuestActionSchema.parse({ verb: 'aid', stat: 'wits', difficulty: 'hard', proposedEffects: [] });
    const { outcome, newState } = resolveQuestAction(state, graph, action, 0.01);
    expect(outcome.grade).toBe('success');
    const paid = outcome.appliedEffects.filter((e) => e.op === 'addMoney').reduce((s, e) => s + (e.amount ?? 0), 0);
    expect(paid).toBe(50); // not 100
    expect(newState.stats['_moneyAccrued']).toBe(120); // capped, not 170
  });
});

describe('termination is code-owned (plan §5.4)', () => {
  it('force-resolves at the turn-budget backstop', () => {
    const graph = guardGraph({ maxTurns: 1 });
    const state = initialQuestState(graph, { charm: 5 });
    const { outcome } = resolveQuestAction(state, graph, persuade(), 0.99);
    expect(outcome.ended).toBe(true);
    expect(outcome.endGoal?.outcome).toBe('lose');
  });

  it('force-resolves after STALL_LIMIT repeated no-progress attempts of the same verb', () => {
    const graph = guardGraph({
      maxTurns: 20,
      goals: [],
      nodes: [
        {
          id: 'gate',
          kind: 'scene',
          setup: '',
          entities: [],
          edges: [],
          isTerminal: false,
          // A committal verb whose menus are all empty → no progress, ever.
          affordances: [{ verb: 'force', stat: 'grit', difficulty: 'normal', hint: '', effects: {} }],
        },
      ],
    });
    let state = initialQuestState(graph, {});
    const action = QuestActionSchema.parse({ verb: 'force', stat: 'grit', difficulty: 'normal', proposedEffects: [] });
    let ended = false;
    for (let i = 0; i < QUEST.STALL_LIMIT; i += 1) {
      const r = resolveQuestAction(state, graph, action, 0.99);
      state = r.newState;
      ended = r.outcome.ended;
    }
    expect(ended).toBe(true);
    expect(state.turn).toBe(QUEST.STALL_LIMIT);
  });

  it('does NOT force-resolve on repeated inspect turns (exploration is free)', () => {
    const graph = guardGraph({
      maxTurns: 20,
      goals: [],
      nodes: [
        {
          id: 'gate',
          kind: 'scene',
          setup: '',
          entities: [],
          edges: [],
          isTerminal: false,
          affordances: [{ verb: 'inspect', stat: 'wits', difficulty: 'normal', hint: '', effects: {} }],
        },
      ],
    });
    let state = initialQuestState(graph, {});
    const action = QuestActionSchema.parse({ verb: 'inspect', stat: 'wits', difficulty: 'normal', proposedEffects: [] });
    for (let i = 0; i < QUEST.STALL_LIMIT + 2; i += 1) {
      const r = resolveQuestAction(state, graph, action, 0.99);
      state = r.newState;
      expect(r.outcome.ended).toBe(false); // looking around never loses the quest
    }
  });

  it('does NOT force-resolve on VARIED no-progress verbs (only repeats count)', () => {
    const graph = guardGraph({
      maxTurns: 20,
      goals: [],
      nodes: [
        {
          id: 'gate',
          kind: 'scene',
          setup: '',
          entities: [],
          edges: [],
          isTerminal: false,
          affordances: [
            { verb: 'persuade', stat: 'charm', difficulty: 'normal', hint: '', effects: {} },
            { verb: 'intimidate', stat: 'grit', difficulty: 'normal', hint: '', effects: {} },
            { verb: 'force', stat: 'grit', difficulty: 'normal', hint: '', effects: {} },
          ],
        },
      ],
    });
    let state = initialQuestState(graph, {});
    let ended = false;
    for (const v of ['persuade', 'intimidate', 'force'] as const) {
      const r = resolveQuestAction(state, graph, QuestActionSchema.parse({ verb: v, difficulty: 'normal', proposedEffects: [] }), 0.99);
      state = r.newState;
      ended = ended || r.outcome.ended;
    }
    expect(ended).toBe(false); // three DIFFERENT no-progress verbs never reach the limit
  });

  it('does not end a normal under-budget success with no goal', () => {
    const graph = guardGraph({
      goals: [],
      nodes: [
        {
          id: 'gate',
          kind: 'scene',
          setup: '',
          entities: [{ id: 'guard', name: 'G', faction: 'hostile', disposition: 0 }],
          edges: [],
          isTerminal: false,
          affordances: [
            {
              verb: 'persuade',
              stat: 'charm',
              difficulty: 'hard',
              hint: '',
              effects: { success: [{ op: 'adjustStat', key: 'disposition', entityId: 'guard', delta: 5 }], partial: [], fail: [], complication: [] },
            },
          ],
        },
      ],
    });
    const state = initialQuestState(graph, { charm: 99 });
    const action = QuestActionSchema.parse({ verb: 'persuade', stat: 'charm', difficulty: 'hard', proposedEffects: [] });
    const { outcome, newState } = resolveQuestAction(state, graph, action, 0.01);
    expect(outcome.grade).toBe('success');
    expect(outcome.ended).toBe(false);
    expect(newState.entities[0]!.disposition).toBe(5);
  });
});

describe('neutral degrade (off-menu / non-diegetic input)', () => {
  it('resolves a noop sentinel to a do-nothing beat — no roll, no effects, no turn', () => {
    const graph = guardGraph();
    const state = initialQuestState(graph, { charm: 90 });
    const action = QuestActionSchema.parse({ verb: 'noop', difficulty: 'trivial', proposedEffects: [] });
    const { newState, outcome } = resolveQuestAction(state, graph, action, 0.01);
    expect(outcome.neutral).toBe(true);
    expect(outcome.voiced).toBeFalsy(); // inert — a fixed safe line, never voiced
    expect(outcome.appliedEffects).toHaveLength(0);
    expect(outcome.ended).toBe(false);
    expect(newState.turn).toBe(state.turn); // turn not consumed
    expect(newState.entities[0]!.faction).toBe('hostile'); // nothing changed
  });

  it('neutral-degrades a talk the scene offers no affordance for, voiced so a character replies', () => {
    const graph = guardGraph(); // affordances: persuade, charm — no talk
    const state = initialQuestState(graph, { charm: 90 });
    const action = QuestActionSchema.parse({ verb: 'talk', difficulty: 'normal', proposedEffects: [] });
    const { newState, outcome } = resolveQuestAction(state, graph, action, 0.01);
    expect(outcome.neutral).toBe(true);
    expect(outcome.voiced).toBe(true); // a character should still reply (fiction valve)
    expect(newState.entities[0]!.faction).toBe('hostile'); // no deceive/persuade applied
    expect(newState.turn).toBe(0);
  });

  it('does NOT snap an off-menu verb onto the first affordance — it comes to nothing, never wins', () => {
    // guardGraph's first affordance is a `persuade` whose SUCCESS flips the guard + fires
    // the win goal. An off-menu `use_item` must NOT borrow that and win.
    const graph = guardGraph();
    const state = initialQuestState(graph, { charm: 99 });
    const action = QuestActionSchema.parse({ verb: 'use_item', difficulty: 'trivial', proposedEffects: [] });
    const { newState, outcome } = resolveQuestAction(state, graph, action, 0.01); // a roll that WOULD succeed
    expect(outcome.neutral).toBe(true);
    expect(outcome.voiced).toBe(true); // narrator describes it falling flat
    expect(outcome.appliedEffects).toHaveLength(0);
    expect(outcome.ended).toBe(false); // the quest did NOT resolve
    expect(newState.entities[0]!.faction).toBe('hostile'); // the guard was not flipped
    expect(newState.turn).toBe(0); // no turn consumed
  });

  it('resolves a talk normally when the node DOES offer a talk affordance', () => {
    const graph = guardGraph({
      goals: [],
      nodes: [
        {
          id: 'gate',
          kind: 'scene',
          setup: '',
          entities: [{ id: 'guard', name: 'G', faction: 'hostile', disposition: 0 }],
          edges: [],
          isTerminal: false,
          affordances: [
            { verb: 'talk', stat: 'wits', difficulty: 'normal', hint: '', effects: { success: [{ op: 'setFlag', flag: 'asked' }], partial: [], fail: [], complication: [] } },
          ],
        },
      ],
    });
    const state = initialQuestState(graph, { wits: 99 });
    const action = QuestActionSchema.parse({ verb: 'talk', difficulty: 'normal', proposedEffects: [] });
    const { newState, outcome } = resolveQuestAction(state, graph, action, 0.01);
    expect(outcome.neutral).toBeFalsy();
    expect(newState.flags).toContain('asked');
    expect(newState.turn).toBe(1);
  });
});

describe('boundQuestGraph (authoring sanitiser)', () => {
  it('repairs a bad entry node, prunes dead edges, clamps magnitudes, drops malformed effects', () => {
    const bounded = boundQuestGraph({
      entryNodeId: 'ghost', // not a real node → falls back to the first node
      maxTurns: 999, // over the ceiling → pre-clamped (not rejected)
      nodes: [
        {
          id: 'a',
          setup: '',
          affordances: [
            {
              verb: 'aid',
              stat: 'grit',
              difficulty: 'hard',
              hint: '',
              effects: {
                success: [
                  { op: 'addMoney', amount: 99999 }, // clamped to MONEY_DELTA_MAX
                  { op: 'setFlag' }, // malformed (no flag) → dropped
                  { op: 'adjustWarmth', characterId: 'c', delta: 50 }, // clamped to WARMTH_DELTA_MAX
                ],
              },
            },
          ],
          edges: [{ when: { kind: 'always' }, to: 'nowhere' }], // dead edge → pruned
        },
      ],
      goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'win', predicate: { kind: 'always' } }],
    });
    expect(bounded.entryNodeId).toBe('a');
    expect(bounded.maxTurns).toBe(QUEST.MAX_TURNS_CEILING);
    expect(bounded.nodes[0]!.edges).toHaveLength(0);
    const eff = bounded.nodes[0]!.affordances[0]!.effects.success;
    expect(eff).toHaveLength(2); // the malformed setFlag was dropped
    expect(eff.find((e) => e.op === 'addMoney')!.amount).toBe(QUEST.MONEY_DELTA_MAX);
    expect(eff.find((e) => e.op === 'adjustWarmth')!.delta).toBe(QUEST.WARMTH_DELTA_MAX);
  });

  it('repairs a MISSING/empty entryNodeId instead of throwing (the omitted-field generation failure)', () => {
    // A model that omits graph.entryNodeId leaves the lenient default "", which the strict
    // schema's z.string().min(1) used to reject — throwing before the post-parse repair ran.
    const bounded = boundQuestGraph({
      // no entryNodeId
      maxTurns: 6,
      nodes: [
        { id: 'delivery', setup: 's', affordances: [{ verb: 'aid', stat: 'grit', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'done' }] } }] },
        { id: 'finish', setup: 's2', affordances: [], isTerminal: true },
      ],
      goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'win', predicate: { kind: 'flag', flag: 'done' } }],
    });
    expect(bounded.entryNodeId).toBe('delivery'); // repaired to the first node, no throw
  });

  it('drops an edge whose `to` is empty instead of throwing', () => {
    const bounded = boundQuestGraph({
      entryNodeId: 'a',
      nodes: [{ id: 'a', setup: '', affordances: [{ verb: 'wait', stat: 'grit', difficulty: 'normal', hint: '', effects: { success: [{ op: 'setFlag', flag: 'x' }] } }], edges: [{ when: { kind: 'always' }, to: '' }] }],
      goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'w', predicate: { kind: 'flag', flag: 'x' } }],
    });
    expect(bounded.nodes[0]!.edges).toHaveLength(0);
  });

  it('is idempotent on an already-bounded graph', () => {
    const once = boundQuestGraph(guardGraph());
    const twice = boundQuestGraph(once);
    expect(twice).toEqual(once);
  });

  it('repairs empty + duplicate ids instead of throwing (a mediocre LLM draft)', () => {
    // Mirrors a real failed generation: empty node/entity/goal ids + over-range numbers.
    const bounded = boundQuestGraph({
      entryNodeId: 'real',
      nodes: [
        { id: '', setup: '', entities: [{ id: '', name: '', faction: 'neutral', disposition: 999 }], affordances: [{ verb: 'wait', stat: 'grit', difficulty: 'normal', hint: '', effects: { success: [{ op: 'setFlag', flag: 'a' }] } }] },
        { id: '', setup: '', affordances: [] },
        { id: 'real', setup: 'x', affordances: [] },
      ],
      goals: [{ id: '', kind: 'flag', outcome: 'win', label: 'win', predicate: { kind: 'flag', flag: 'a' } }],
    });
    const ids = bounded.nodes.map((n) => n.id);
    expect(ids.every((id) => id.length > 0)).toBe(true); // no empty node ids
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(bounded.nodes[0]!.entities[0]!.id.length).toBeGreaterThan(0); // entity id minted
    expect(bounded.nodes[0]!.entities[0]!.disposition).toBe(100); // 999 → clamped
    expect(bounded.goals[0]!.id.length).toBeGreaterThan(0); // goal id minted
  });
});

describe('isWinReachable (catches a win wired to nothing)', () => {
  const oneAffordance = (success: unknown[], entities: unknown[] = []) =>
    ({
      entryNodeId: 'n',
      nodes: [{ id: 'n', setup: '', entities, affordances: [{ verb: 'persuade', stat: 'charm', difficulty: 'hard', hint: '', effects: { success } }] }],
      goals: [] as unknown[],
    });

  it('true when a success sets the win flag, false when nothing does', () => {
    const reachable = boundQuestGraph({ ...oneAffordance([{ op: 'setFlag', flag: 'won' }]), goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: '', predicate: { kind: 'flag', flag: 'won' } }] });
    expect(isWinReachable(reachable)).toBe(true);
    const unreachable = boundQuestGraph({ ...oneAffordance([{ op: 'setFlag', flag: 'other' }]), goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: '', predicate: { kind: 'flag', flag: 'never_set' } }] });
    expect(isWinReachable(unreachable)).toBe(false);
  });

  it('reads faction / disposition / entry-node reachability', () => {
    const base = oneAffordance(
      [{ op: 'moveEntityToFaction', entityId: 'g', faction: 'ally' }, { op: 'adjustStat', key: 'disposition', entityId: 'g', delta: 10 }],
      [{ id: 'g', name: 'G', faction: 'hostile', disposition: 0 }],
    );
    const g = boundQuestGraph(base);
    expect(isWinReachable({ ...g, goals: [{ id: 'a', kind: 'persuade', outcome: 'win', label: '', predicate: { kind: 'entityFaction', entityId: 'g', faction: 'ally' } }] })).toBe(true);
    expect(isWinReachable({ ...g, goals: [{ id: 'b', kind: 'persuade', outcome: 'win', label: '', predicate: { kind: 'entityDisposition', entityId: 'g', op: 'gte', value: 30 } }] })).toBe(true);
    expect(isWinReachable({ ...g, goals: [{ id: 'c', kind: 'reach', outcome: 'win', label: '', predicate: { kind: 'atNode', nodeId: 'n' } }] })).toBe(true);
  });
});

describe('predicates', () => {
  it('evaluates faction, item, flag, and negation', () => {
    const graph = guardGraph();
    const state = initialQuestState(graph, {});
    state.flags.push('a');
    state.inventory.push({ itemId: 'key', qty: 2 });
    expect(evalPredicate({ kind: 'flag', flag: 'a' }, state)).toBe(true);
    expect(evalPredicate({ kind: 'flag', flag: 'a', negate: true }, state)).toBe(false);
    expect(evalPredicate({ kind: 'hasItem', itemId: 'key', value: 2 }, state)).toBe(true);
    expect(evalPredicate({ kind: 'hasItem', itemId: 'key', value: 3 }, state)).toBe(false);
    expect(evalPredicate({ kind: 'entityFaction', entityId: 'guard', faction: 'hostile' }, state)).toBe(true);
  });
});
