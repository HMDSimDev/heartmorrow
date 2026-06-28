import { describe, it, expect } from 'vitest';
import {
  boundQuestGraph,
  lintQuestGraph,
  autoFixQuestGraph,
  isWinReachable,
  isWinReachableTiered,
  reachableNodeIds,
  actableNodeIds,
  entryEntityIds,
  resolveQuestAction,
  initialQuestState,
  QuestActionSchema,
  availableAffordances,
  currentNode,
  type QuestGraph,
  type QuestLintContext,
} from './index';

const NONE: QuestLintContext = { partnerId: null };

/** Build a bounded graph from a plain object (mirrors the real post-parse pipeline). */
function g(obj: unknown): QuestGraph {
  return boundQuestGraph(obj);
}

/** A one-scene graph whose single `persuade` success flips the watchman's faction —
 *  the canonical "win effect is too big for its band" defect. The flip is `heavy`, so
 *  it needs `hard`; on `normal` the referee silently drops it. */
function factionFlipOnBand(band: string): QuestGraph {
  return g({
    entryNodeId: 'gate',
    maxTurns: 8,
    timeoutOutcome: 'resolved',
    nodes: [
      {
        id: 'gate',
        setup: 'A watchman bars the gate.',
        entities: [{ id: 'watch', name: 'Watchman', faction: 'neutral', disposition: 0 }],
        affordances: [
          {
            verb: 'persuade',
            stat: 'charm',
            difficulty: band,
            hint: 'Talk him round.',
            effects: { success: [{ op: 'moveEntityToFaction', entityId: 'watch', faction: 'ally' }], partial: [], fail: [], complication: [] },
          },
        ],
        edges: [],
        isTerminal: false,
      },
    ],
    goals: [{ id: 'win', kind: 'persuade', outcome: 'win', label: 'Win the watchman over', predicate: { kind: 'entityFaction', entityId: 'watch', faction: 'ally' } }],
  });
}

const blocking = (graph: QuestGraph, ctx: QuestLintContext = NONE) => lintQuestGraph(graph, ctx).filter((p) => p.severity === 'blocking');
const codes = (graph: QuestGraph, ctx: QuestLintContext = NONE) => new Set(lintQuestGraph(graph, ctx).map((p) => p.code));

/** Play the graph greedily, forcing every roll to a success (roll=0), always taking an
 *  affordance whose success advances a win goal — proving PRACTICAL winnability. */
function simulateWin(graph: QuestGraph): boolean {
  let state = initialQuestState(graph);
  for (let i = 0; i < graph.maxTurns + 2; i++) {
    const node = graph.nodes.find((n) => n.id === state.nodeId) ?? graph.nodes[0]!;
    // Prefer an affordance whose success could satisfy a win goal; else the first one.
    const aff = node.affordances[0];
    if (!aff) return false;
    const action = QuestActionSchema.parse({ verb: aff.verb, stat: aff.stat, difficulty: aff.difficulty, targetEntityId: state.entities[0]?.id, proposedEffects: [], rationale: '' });
    const { newState, outcome } = resolveQuestAction(state, graph, action, 0);
    state = newState;
    if (outcome.ended) return outcome.endGoal?.outcome === 'win';
  }
  return false;
}

describe('isWinReachableTiered — tier-aware where isWinReachable is blind', () => {
  it('a faction-flip win on a `normal` approach is reachable to the OLD check but not the tiered one', () => {
    const broken = factionFlipOnBand('normal');
    expect(isWinReachable(broken)).toBe(true); // permissive: a matching effect EXISTS
    expect(isWinReachableTiered(broken)).toBe(false); // but it can never FIRE on `normal`
  });

  it('the same win on a `hard` approach is reachable to both', () => {
    const ok = factionFlipOnBand('hard');
    expect(isWinReachable(ok)).toBe(true);
    expect(isWinReachableTiered(ok)).toBe(true);
  });
});

describe('lintQuestGraph — blocking coherence defects', () => {
  it('flags WIN_EFFECT_OVER_BAND with the required band', () => {
    const probs = blocking(factionFlipOnBand('normal'));
    const over = probs.find((p) => p.code === 'WIN_EFFECT_OVER_BAND');
    expect(over).toBeTruthy();
    expect(over!.targets?.requiredBand).toBe('hard');
  });

  it('flags WIN_ENTITY_NOT_IN_ENTRY when a win targets an entity outside the entry scene', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [
        { id: 'a', setup: 'x', entities: [{ id: 'p', name: 'P', faction: 'neutral' }, { id: 'q', name: 'Q', faction: 'neutral' }], affordances: [{ verb: 'persuade', stat: 'charm', difficulty: 'hard', hint: 'h', effects: { success: [{ op: 'moveEntityToFaction', entityId: 'ghost', faction: 'ally' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false },
      ],
      goals: [{ id: 'win', kind: 'persuade', outcome: 'win', label: 'W', predicate: { kind: 'entityFaction', entityId: 'ghost', faction: 'ally' } }],
    });
    expect(codes(graph).has('WIN_ENTITY_NOT_IN_ENTRY')).toBe(true);
  });

  it('flags AUTO_LOSE_AT_START for an `always` lose goal', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [], affordances: [{ verb: 'inspect', stat: 'intellect', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'won' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false }],
      goals: [
        { id: 'win', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } },
        { id: 'lose', kind: 'flag', outcome: 'lose', label: 'L', predicate: { kind: 'always' } },
      ],
    });
    expect(codes(graph).has('AUTO_LOSE_AT_START')).toBe(true);
  });

  it('flags WIN_DECOUPLED when nothing produces the win flag', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [], affordances: [{ verb: 'inspect', stat: 'intellect', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'other' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false }],
      goals: [{ id: 'win', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'never_set' } }],
    });
    expect(codes(graph).has('WIN_DECOUPLED')).toBe(true);
  });

  it('flags ENTRY_NO_FIREABLE_SUCCESS when the opening scene cannot progress', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [], affordances: [{ verb: 'wait', stat: 'intellect', difficulty: 'normal', hint: 'h', effects: { success: [], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false }],
      goals: [{ id: 'win', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } }],
    });
    expect(codes(graph).has('ENTRY_NO_FIREABLE_SUCCESS')).toBe(true);
  });

  it('flags WIN_ONLY_ON_FAILURE when the win effect lives only on a fail/complication', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [], affordances: [{ verb: 'force', stat: 'grit', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'noise' }], partial: [], fail: [{ op: 'setFlag', flag: 'won' }], complication: [] } }], edges: [], isTerminal: false }],
      goals: [{ id: 'win', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } }],
    });
    expect(codes(graph).has('WIN_ONLY_ON_FAILURE')).toBe(true);
  });

  it('a clean, winnable quest produces NO blocking problems', () => {
    expect(blocking(factionFlipOnBand('hard'))).toHaveLength(0);
  });

  it('flags WIN_THRESHOLD_UNREACHABLE for a disposition-LTE win the deltas can never drive low enough', () => {
    // The reach math must follow the predicate's OP, not its kind: this is a `lte` (drive
    // disposition DOWN) win, and -5/turn from 20 over 8 turns floors at -20, never <= -60.
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [{ id: 'rival', name: 'R', faction: 'neutral', disposition: 20 }], affordances: [{ verb: 'intimidate', stat: 'confidence', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'adjustStat', entityId: 'rival', key: 'disposition', delta: -5 }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false }],
      goals: [{ id: 'win', kind: 'persuade', outcome: 'win', label: 'Cow them', predicate: { kind: 'entityDisposition', entityId: 'rival', op: 'lte', value: -60 } }],
    });
    expect(isWinReachableTiered(graph)).toBe(false);
    expect(blocking(graph).some((p) => p.code === 'WIN_THRESHOLD_UNREACHABLE')).toBe(true);
  });

  it('does not count a node reachable only through an edge whose condition nothing can satisfy', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [
        { id: 'a', setup: 'x', entities: [], affordances: [{ verb: 'force', stat: 'grit', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'noise' }], partial: [], fail: [], complication: [] } }], edges: [{ when: { kind: 'flag', flag: 'key' }, to: 'b' }], isTerminal: false },
        { id: 'b', setup: 'y', entities: [], affordances: [{ verb: 'inspect', stat: 'intellect', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'won' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false },
      ],
      goals: [{ id: 'win', kind: 'reach', outcome: 'win', label: 'Reach b', predicate: { kind: 'atNode', nodeId: 'b' } }],
    });
    expect(reachableNodeIds(graph).has('b')).toBe(false); // edge keyed on 'key', which nothing sets
    expect(isWinReachableTiered(graph)).toBe(false);
    expect(blocking(graph).some((p) => p.code === 'WIN_NODE_UNREACHABLE')).toBe(true);
  });

  it('downgrades a dead extra win goal to a WARNING when another win is genuinely reachable', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [], affordances: [{ verb: 'inspect', stat: 'intellect', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'won' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false }],
      goals: [
        { id: 'good', kind: 'flag', outcome: 'win', label: 'Real', predicate: { kind: 'flag', flag: 'won' } },
        { id: 'dead', kind: 'flag', outcome: 'win', label: 'Dead', predicate: { kind: 'flag', flag: 'never_set' } },
      ],
    });
    expect(isWinReachableTiered(graph)).toBe(true);
    expect(blocking(graph)).toHaveLength(0); // the quest IS winnable, so the dead goal isn't blocking
    expect(codes(graph).has('WIN_DECOUPLED')).toBe(true); // still surfaced — as a warning
  });
});

describe('lintQuestGraph — warnings', () => {
  it('warns about warmth on a non-romance quest, and about a missing partner deepen on a romance one', () => {
    const withWarmth = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [{ id: 'm', name: 'M', faction: 'ally' }], affordances: [{ verb: 'charm', stat: 'charm', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'won' }, { op: 'adjustWarmth', characterId: 'someone', delta: 2 }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false }],
      goals: [{ id: 'win', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } }],
    });
    expect(codes(withWarmth, { partnerId: null }).has('WARMTH_ON_NONROMANCE')).toBe(true);
    // Anchored to a partner but the warmth points at the wrong id → WARMTH_TARGET.
    expect(codes(withWarmth, { partnerId: 'char:1' }).has('WARMTH_TARGET')).toBe(true);
  });
});

describe('autoFixQuestGraph — safe deterministic repairs', () => {
  it('raises a `normal` faction-flip approach to `hard` so the win can fire', () => {
    const { graph: fixed, fixes } = autoFixQuestGraph(factionFlipOnBand('normal'), NONE);
    expect(fixes.some((f) => f.code === 'AF_RAISE_WIN_BAND')).toBe(true);
    expect(isWinReachableTiered(fixed)).toBe(true);
    expect(blocking(fixed)).toHaveLength(0);
    expect(simulateWin(fixed)).toBe(true);
  });

  it('drops an auto-true lose goal', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [], affordances: [{ verb: 'inspect', stat: 'intellect', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'won' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false }],
      goals: [
        { id: 'win', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } },
        { id: 'lose', kind: 'flag', outcome: 'lose', label: 'L', predicate: { kind: 'always' } },
      ],
    });
    const { graph: fixed, fixes } = autoFixQuestGraph(graph, NONE);
    expect(fixes.some((f) => f.code === 'AF_DROP_AUTOLOSE')).toBe(true);
    expect(fixed.goals.some((x) => x.outcome === 'lose')).toBe(false);
    expect(simulateWin(fixed)).toBe(true);
  });

  it('copies a fail-only win effect into success', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [], affordances: [{ verb: 'force', stat: 'grit', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'noise' }], partial: [], fail: [{ op: 'setFlag', flag: 'won' }], complication: [] } }], edges: [], isTerminal: false }],
      goals: [{ id: 'win', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } }],
    });
    const { graph: fixed } = autoFixQuestGraph(graph, NONE);
    const successFlags = fixed.nodes[0]!.affordances[0]!.effects.success.filter((e) => e.op === 'setFlag').map((e) => e.flag);
    expect(successFlags).toContain('won');
    expect(simulateWin(fixed)).toBe(true);
  });

  it('retargets adjustWarmth to the partner when anchored, and strips it when not', () => {
    const make = () =>
      g({
        entryNodeId: 'a',
        maxTurns: 8,
        nodes: [{ id: 'a', setup: 'x', entities: [{ id: 'm', name: 'M', faction: 'ally' }], affordances: [{ verb: 'charm', stat: 'charm', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'won' }, { op: 'adjustWarmth', characterId: 'wrong', delta: 2 }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false }],
        goals: [{ id: 'win', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } }],
      });
    const anchored = autoFixQuestGraph(make(), { partnerId: 'char:1' }).graph;
    const warmth = anchored.nodes[0]!.affordances[0]!.effects.success.find((e) => e.op === 'adjustWarmth');
    expect(warmth?.characterId).toBe('char:1');
    const stripped = autoFixQuestGraph(make(), { partnerId: null }).graph;
    expect(stripped.nodes[0]!.affordances[0]!.effects.success.some((e) => e.op === 'adjustWarmth')).toBe(false);
  });

  it('remaps a dangling effect entity to the HOST scene’s lone entity (per-scene rosters)', () => {
    // Entities now load per-scene, so an effect in scene b that targets a dangling id should
    // remap to scene b's own lone entity ('local') — the entity that exists when you're there.
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [
        { id: 'a', setup: 'x', entities: [{ id: 'hero', name: 'Hero', faction: 'neutral' }], affordances: [{ verb: 'move', stat: 'grit', difficulty: 'desperate', hint: 'go', effects: { success: [{ op: 'moveToNode', nodeId: 'b' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false },
        { id: 'b', setup: 'y', entities: [{ id: 'local', name: 'Local', faction: 'neutral' }], affordances: [{ verb: 'persuade', stat: 'charm', difficulty: 'hard', hint: 'h', effects: { success: [{ op: 'moveEntityToFaction', entityId: 'ghost', faction: 'ally' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false },
      ],
      goals: [{ id: 'win', kind: 'persuade', outcome: 'win', label: 'W', predicate: { kind: 'entityFaction', entityId: 'local', faction: 'ally' } }],
    });
    const { graph: fixed } = autoFixQuestGraph(graph, NONE);
    const eff = fixed.nodes.find((n) => n.id === 'b')!.affordances[0]!.effects.success.find((e) => e.op === 'moveEntityToFaction');
    expect(eff?.entityId).toBe('local'); // remapped to scene b's own entity
  });

  it('is idempotent: autoFix(autoFix(g)) deep-equals autoFix(g)', () => {
    const once = autoFixQuestGraph(factionFlipOnBand('normal'), NONE).graph;
    const twice = autoFixQuestGraph(once, NONE).graph;
    expect(twice).toEqual(once);
  });

  it('never turns a winnable quest unwinnable', () => {
    for (const band of ['trivial', 'normal', 'hard', 'desperate']) {
      const before = factionFlipOnBand(band);
      const after = autoFixQuestGraph(before, NONE).graph;
      if (isWinReachableTiered(before)) expect(isWinReachableTiered(after)).toBe(true);
    }
  });
});

describe('terminal-node awareness (a win effect in a terminal scene can never fire)', () => {
  // Entry routes UNCONDITIONALLY into a terminal scene whose approaches set the win flag —
  // the "attack once → routed into the terminal scene → instant win" trap. The entry scene
  // has a non-winning fireable success so ENTRY_NO_FIREABLE_SUCCESS doesn't also fire.
  const make = () =>
    g({
      entryNodeId: 'a',
      maxTurns: 6,
      nodes: [
        { id: 'a', setup: 'start', entities: [], affordances: [{ verb: 'inspect', stat: 'intellect', difficulty: 'normal', hint: 'look', effects: { success: [{ op: 'setFlag', flag: 'looked' }], partial: [], fail: [], complication: [] } }], edges: [{ when: { kind: 'always' }, to: 'b' }], isTerminal: false },
        { id: 'b', setup: 'climax', entities: [], affordances: [{ verb: 'persuade', stat: 'charm', difficulty: 'hard', hint: 'merge', effects: { success: [{ op: 'setFlag', flag: 'won' }, { op: 'endScene', status: 'resolved' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: true },
      ],
      goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'Win', predicate: { kind: 'flag', flag: 'won' } }],
    });

  it('actableNodeIds excludes a non-entry terminal node (you can arrive but not act)', () => {
    const graph = make();
    expect(reachableNodeIds(graph).has('b')).toBe(true);
    expect(actableNodeIds(graph).has('b')).toBe(false);
  });

  it('isWinReachableTiered is false when the only win effect lives in a terminal node', () => {
    expect(isWinReachableTiered(make())).toBe(false);
    expect(isWinReachable(make())).toBe(true); // the OLD check is fooled (it's terminal-blind)
  });

  it('lint flags WIN_IN_TERMINAL_NODE (blocking) + the structural warnings', () => {
    const probs = make();
    expect(blocking(probs).some((p) => p.code === 'WIN_IN_TERMINAL_NODE')).toBe(true);
    const all = codes(probs);
    expect(all.has('TERMINAL_NODE_HAS_ACTIONS')).toBe(true);
    expect(all.has('UNCONDITIONAL_EDGE')).toBe(true);
  });

  it('autoFix unmarks the dead terminal so the win is reachable AND arriving no longer ends the quest', () => {
    const { graph: fixed, fixes } = autoFixQuestGraph(make(), NONE);
    expect(fixes.some((f) => f.code === 'AF_UNMARK_DEAD_TERMINAL')).toBe(true);
    expect(isWinReachableTiered(fixed)).toBe(true);
    expect(blocking(fixed)).toHaveLength(0);
    // Routing into b (now non-terminal) via the always edge must NOT end the quest on turn 1.
    const s0 = initialQuestState(fixed);
    const action = QuestActionSchema.parse({ verb: 'inspect', stat: 'intellect', difficulty: 'normal', proposedEffects: [], rationale: '' });
    const { outcome, newState } = resolveQuestAction(s0, fixed, action, 0);
    expect(outcome.ended).toBe(false);
    expect(newState.nodeId).toBe('b');
  });

  it('does NOT unmark a genuine ending scene (only endScene, no win-deciding approach)', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 6,
      nodes: [
        { id: 'a', setup: 's', entities: [], affordances: [{ verb: 'inspect', stat: 'intellect', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'won' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false },
        { id: 'end', setup: 'fin', entities: [], affordances: [{ verb: 'wait', stat: 'grit', difficulty: 'desperate', hint: 'rest', effects: { success: [{ op: 'endScene', status: 'resolved' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: true },
      ],
      goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'Win', predicate: { kind: 'flag', flag: 'won' } }],
    });
    const { fixes } = autoFixQuestGraph(graph, NONE);
    expect(fixes.some((f) => f.code === 'AF_UNMARK_DEAD_TERMINAL')).toBe(false); // its approach only ends — it's a real ending
  });
});

describe('conditionals — preconditions + compound predicates + per-scene entities', () => {
  // The user's exact "impossible" quest, now authorable: ask Mira (room A) → unlock move
  // boxes → unlock the OPTION to go to room B → ask the porter (who exists only in room B) →
  // do the now-known help → WIN (an AND of both rooms' progress).
  const miraQuest = () =>
    g({
      entryNodeId: 'roomA',
      maxTurns: 14,
      nodes: [
        {
          id: 'roomA', kind: 'scene', setup: 'Mira among crates.',
          entities: [{ id: 'mira', name: 'Mira', faction: 'party', disposition: 30 }],
          affordances: [
            { verb: 'talk', stat: 'charm', difficulty: 'normal', hint: 'Ask Mira what is wrong.', effects: { success: [{ op: 'setFlag', flag: 'asked_mira' }], partial: [], fail: [], complication: [] } },
            { verb: 'force', stat: 'grit', difficulty: 'normal', hint: 'Move the boxes.', when: { kind: 'flag', flag: 'asked_mira' }, effects: { success: [{ op: 'setFlag', flag: 'boxes_moved' }], partial: [], fail: [], complication: [] } },
            { verb: 'move', stat: 'grit', difficulty: 'desperate', hint: 'Go to the back room.', when: { kind: 'flag', flag: 'boxes_moved' }, effects: { success: [{ op: 'moveToNode', nodeId: 'roomB' }], partial: [{ op: 'moveToNode', nodeId: 'roomB' }], fail: [], complication: [] } },
          ],
          edges: [], isTerminal: false,
        },
        {
          id: 'roomB', kind: 'scene', setup: 'A back room; a porter waits.',
          entities: [{ id: 'porter', name: 'Porter', faction: 'neutral', disposition: 0 }],
          affordances: [
            { verb: 'talk', stat: 'charm', difficulty: 'normal', hint: 'Ask what help is needed.', effects: { success: [{ op: 'setFlag', flag: 'asked_porter' }], partial: [], fail: [], complication: [] } },
            { verb: 'aid', stat: 'empathy', difficulty: 'normal', hint: 'Do the help.', when: { kind: 'flag', flag: 'asked_porter' }, effects: { success: [{ op: 'setFlag', flag: 'helped' }], partial: [], fail: [], complication: [] } },
          ],
          edges: [], isTerminal: false,
        },
      ],
      goals: [{ id: 'win', kind: 'flag', outcome: 'win', label: 'Help both rooms', predicate: { kind: 'all', clauses: [{ kind: 'flag', flag: 'boxes_moved' }, { kind: 'flag', flag: 'helped' }] } }],
    });

  it('the multi-room gated quest lints CLEAN and is win-reachable', () => {
    const graph = miraQuest();
    expect(blocking(graph)).toHaveLength(0);
    expect(isWinReachableTiered(graph)).toBe(true);
  });

  it('preconditions gate approaches, the player-chosen move unlocks, the porter exists in room B, and the AND win fires', () => {
    const graph = miraQuest();
    let state = initialQuestState(graph);
    const avail = () => availableAffordances(currentNode(graph, state), state).map((a) => a.verb);
    const act = (verb: string) => {
      const a = QuestActionSchema.parse({ verb, stat: 'grit', difficulty: 'normal', proposedEffects: [], rationale: '' });
      const r = resolveQuestAction(state, graph, a, 0); // roll 0 → success
      state = r.newState;
      return r.outcome;
    };
    expect(avail()).toEqual(['talk']); // force + move are gated off at the start
    expect(act('force').gated).toBe(true); // attempting a gated approach → a "not yet" beat
    act('talk'); // asks Mira → sets asked_mira
    expect(avail()).toContain('force'); // move-boxes unlocked
    act('force'); // sets boxes_moved
    expect(avail()).toContain('move'); // the OPTION to go to room B unlocked (player-chosen)
    act('move'); // moveToNode roomB
    expect(state.nodeId).toBe('roomB');
    expect(state.entities.some((e) => e.id === 'porter')).toBe(true); // per-scene entity loaded
    act('talk'); // asks the porter → sets asked_porter
    const last = act('aid'); // sets helped → the all[boxes_moved, helped] win fires
    expect(last.ended).toBe(true);
    expect(last.endGoal?.outcome).toBe('win');
  });

  it('a compound AND win is not falsely flagged when each clause is reachable', () => {
    expect(blocking(miraQuest()).some((p) => p.code.startsWith('WIN'))).toBe(false);
  });

  it('a one-shot approach (when NOT tried + sets tried) disappears after one use', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [], affordances: [{ verb: 'force', stat: 'grit', difficulty: 'normal', hint: 'Try the lever once.', when: { kind: 'flag', flag: 'tried', negate: true }, effects: { success: [{ op: 'setFlag', flag: 'tried' }, { op: 'setFlag', flag: 'won' }], partial: [{ op: 'setFlag', flag: 'tried' }], fail: [{ op: 'setFlag', flag: 'tried' }], complication: [{ op: 'setFlag', flag: 'tried' }] } }], edges: [], isTerminal: false }],
      goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } }],
    });
    let state = initialQuestState(graph);
    expect(availableAffordances(currentNode(graph, state), state)).toHaveLength(1);
    // First attempt (roll 0.9 → fail) sets `tried`; the approach then vanishes.
    const r = resolveQuestAction(state, graph, QuestActionSchema.parse({ verb: 'force', stat: 'grit', difficulty: 'normal', proposedEffects: [], rationale: '' }), 0.9);
    state = r.newState;
    expect(state.flags).toContain('tried');
    expect(availableAffordances(currentNode(graph, state), state)).toHaveLength(0); // removed from the menu
  });

  it('a fully-gated non-terminal scene force-loses (no hang) instead of stalling forever', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [], affordances: [{ verb: 'force', stat: 'grit', difficulty: 'normal', hint: 'h', when: { kind: 'flag', flag: 'never' }, effects: { success: [{ op: 'setFlag', flag: 'won' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false }],
      goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } }],
    });
    const r = resolveQuestAction(initialQuestState(graph), graph, QuestActionSchema.parse({ verb: 'force', stat: 'grit', difficulty: 'normal', proposedEffects: [], rationale: '' }), 0);
    expect(r.outcome.ended).toBe(true);
    expect(r.outcome.endGoal?.outcome).toBe('lose');
    // It's also lint-flagged (so the author sees it before play).
    expect(codes(graph).has('ENTRY_NO_AVAILABLE_AFFORDANCE')).toBe(true);
  });

  it('flags COMPOUND_EMPTY for an all/any with no clauses', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [], affordances: [{ verb: 'inspect', stat: 'intellect', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'won' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false }],
      goals: [
        { id: 'w', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } },
        { id: 'e', kind: 'flag', outcome: 'lose', label: 'L', predicate: { kind: 'any', clauses: [] } },
      ],
    });
    expect(codes(graph).has('COMPOUND_EMPTY')).toBe(true);
  });

  it('does NOT flag a room-B entity referenced by a room-B effect (per-scene rosters)', () => {
    const graph = miraQuest();
    // The porter (room B) is targeted by nothing dangling; no EFFECT_ENTITY_REF / PRED_ENTITY_REF.
    const all = lintQuestGraph(graph, NONE).map((p) => p.code);
    expect(all).not.toContain('EFFECT_ENTITY_REF');
    expect(all).not.toContain('PRED_ENTITY_REF');
  });

  it('the referee picks the AVAILABLE same-verb approach, not a leading gated duplicate', () => {
    // Two "persuade" approaches: the FIRST is gated-off (flag X unset); the SECOND is ungated
    // and wins. The referee must resolve the available one, not neutral-degrade as "gated".
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [], affordances: [
        { verb: 'persuade', stat: 'charm', difficulty: 'hard', hint: 'locked', when: { kind: 'flag', flag: 'X' }, effects: { success: [{ op: 'setFlag', flag: 'other' }], partial: [], fail: [], complication: [] } },
        { verb: 'persuade', stat: 'charm', difficulty: 'normal', hint: 'open', effects: { success: [{ op: 'setFlag', flag: 'won' }], partial: [], fail: [], complication: [] } },
      ], edges: [], isTerminal: false }],
      goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } }],
    });
    const r = resolveQuestAction(initialQuestState(graph), graph, QuestActionSchema.parse({ verb: 'persuade', stat: 'charm', difficulty: 'normal', proposedEffects: [], rationale: '' }), 0);
    expect(r.outcome.neutral).toBeFalsy(); // resolved the ungated approach
    expect(r.outcome.gated).toBeFalsy();
    expect(r.newState.flags).toContain('won');
  });

  it('a terminal ENTRY node with no available approach force-loses (no hang)', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [], isTerminal: true, affordances: [{ verb: 'force', stat: 'grit', difficulty: 'normal', hint: 'h', when: { kind: 'flag', flag: 'never' }, effects: { success: [{ op: 'setFlag', flag: 'won' }], partial: [], fail: [], complication: [] } }], edges: [] }],
      goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } }],
    });
    const r = resolveQuestAction(initialQuestState(graph), graph, QuestActionSchema.parse({ verb: 'force', stat: 'grit', difficulty: 'normal', proposedEffects: [], rationale: '' }), 0);
    expect(r.outcome.ended).toBe(true);
    expect(r.outcome.endGoal?.outcome).toBe('lose');
  });

  it('an AND-goal clause set only on a FAIL grade is winnable, not falsely blocked', () => {
    // flag A only on force.fail, flag B on inspect.success; win = all[A,B]. Player fails force
    // (sets A) and succeeds inspect (sets B) → both set → win. Must NOT be a blocking WIN_*.
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [{ id: 'a', setup: 'x', entities: [], affordances: [
        { verb: 'force', stat: 'grit', difficulty: 'normal', hint: 'risky', effects: { success: [], partial: [], fail: [{ op: 'setFlag', flag: 'A' }], complication: [{ op: 'setFlag', flag: 'A' }] } },
        { verb: 'inspect', stat: 'intellect', difficulty: 'normal', hint: 'look', effects: { success: [{ op: 'setFlag', flag: 'B' }], partial: [], fail: [], complication: [] } },
      ], edges: [], isTerminal: false }],
      goals: [{ id: 'w', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'all', clauses: [{ kind: 'flag', flag: 'A' }, { kind: 'flag', flag: 'B' }] } }],
    });
    expect(isWinReachableTiered(graph)).toBe(true);
    expect(blocking(graph)).toHaveLength(0);
  });

  it('a def-satisfied entity win confined to a TERMINAL room is flagged (it can never fire)', () => {
    // foe starts 'ally' in roomB, win = entityFaction foe=ally, but roomB is terminal → arriving
    // resolves the scene before the goal check, so the win never fires. Must be caught.
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [
        { id: 'a', setup: 'start', entities: [], affordances: [{ verb: 'move', stat: 'grit', difficulty: 'desperate', hint: 'go', effects: { success: [{ op: 'moveToNode', nodeId: 'b' }], partial: [{ op: 'moveToNode', nodeId: 'b' }], fail: [], complication: [] } }], edges: [], isTerminal: false },
        { id: 'b', setup: 'end', entities: [{ id: 'foe', name: 'Foe', faction: 'ally', disposition: 0 }], affordances: [], edges: [], isTerminal: true },
      ],
      goals: [{ id: 'w', kind: 'persuade', outcome: 'win', label: 'W', predicate: { kind: 'entityFaction', entityId: 'foe', faction: 'ally' } }],
    });
    expect(isWinReachableTiered(graph)).toBe(false); // not a false-pass anymore
    expect(blocking(graph).length).toBeGreaterThan(0);
  });
});

describe('helpers', () => {
  it('entryEntityIds is scoped to the entry node only', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [
        { id: 'a', setup: 'x', entities: [{ id: 'hero', name: 'H', faction: 'neutral' }], affordances: [{ verb: 'inspect', stat: 'intellect', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'setFlag', flag: 'won' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false },
        { id: 'b', setup: 'y', entities: [{ id: 'other', name: 'O', faction: 'neutral' }], affordances: [], edges: [], isTerminal: false },
      ],
      goals: [{ id: 'win', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } }],
    });
    expect([...entryEntityIds(graph)]).toEqual(['hero']);
  });

  it('reachableNodeIds follows edges and desperate moveToNode, not weaker bands', () => {
    const graph = g({
      entryNodeId: 'a',
      maxTurns: 8,
      nodes: [
        { id: 'a', setup: 'x', entities: [], affordances: [{ verb: 'move', stat: 'grit', difficulty: 'normal', hint: 'h', effects: { success: [{ op: 'moveToNode', nodeId: 'b' }], partial: [], fail: [], complication: [] } }], edges: [], isTerminal: false },
        { id: 'b', setup: 'y', entities: [], affordances: [], edges: [], isTerminal: false },
      ],
      goals: [{ id: 'win', kind: 'flag', outcome: 'win', label: 'W', predicate: { kind: 'flag', flag: 'won' } }],
    });
    // moveToNode is spine → it can't fire on a `normal` approach, so b is NOT reachable.
    expect(reachableNodeIds(graph).has('b')).toBe(false);
  });
});
