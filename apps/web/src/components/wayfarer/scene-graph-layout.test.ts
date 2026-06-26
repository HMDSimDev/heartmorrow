import { describe, expect, it } from 'vitest';
import type { QuestGraph, QuestNode, NodeAffordance, StatePredicate } from '@dsim/shared';
import { borderPoint, computeEdges, computeLayout, shortPredicate, COL_W, PAD } from './scene-graph-layout';

function aff(over: Partial<NodeAffordance> = {}): NodeAffordance {
  return { verb: 'persuade', stat: 'charm', difficulty: 'normal', hint: '', effects: { success: [], partial: [], fail: [], complication: [] }, ...over };
}
function node(id: string, over: Partial<QuestNode> = {}): QuestNode {
  return { id, kind: 'scene', setup: '', entities: [], affordances: [aff()], edges: [], isTerminal: false, ...over };
}
const flag = (f: string): StatePredicate => ({ kind: 'flag', flag: f });

/** s1 --route(door)--> s2 ==jump==> s3 --route(always)--> s1 (cycle); `orphan` is
 *  unreachable. s3 is reachable ONLY through the moveToNode jump from s2. */
function fixture(): QuestGraph {
  return {
    entryNodeId: 's1',
    maxTurns: 8,
    timeoutOutcome: 'resolved',
    nodes: [
      node('s1', { edges: [{ when: flag('door'), to: 's2' }] }),
      node('s2', {
        affordances: [aff({ effects: { success: [{ op: 'moveToNode', nodeId: 's3' }], partial: [], fail: [{ op: 'moveToNode', nodeId: 's3' }], complication: [] } })],
      }),
      node('s3', { edges: [{ when: { kind: 'always' }, to: 's1' }], isTerminal: true }),
      node('orphan'),
    ],
    goals: [{ id: 'win', kind: 'flag', outcome: 'win', label: 'done', predicate: flag('door') }],
  };
}

describe('computeLayout', () => {
  const layout = computeLayout(fixture());

  it('reaches scenes through both routes and moveToNode jumps', () => {
    expect(layout.reachable.has('s1')).toBe(true);
    expect(layout.reachable.has('s2')).toBe(true);
    // s3 is only reachable via the jump from s2 — proves jumps count as transitions.
    expect(layout.reachable.has('s3')).toBe(true);
  });

  it('flags a scene with no path from the entry as unreachable', () => {
    expect(layout.reachable.has('orphan')).toBe(false);
  });

  it('places scenes in BFS-level columns, entry leftmost', () => {
    expect(layout.pos.s1!.x).toBe(PAD); // level 0
    expect(layout.pos.s2!.x).toBe(PAD + COL_W); // level 1 (route)
    expect(layout.pos.s3!.x).toBe(PAD + 2 * COL_W); // level 2 (jump)
    // The orphan is parked one column past the reachable graph.
    expect(layout.pos.orphan!.x).toBe(PAD + 3 * COL_W);
  });

  it('gives every scene a distinct position', () => {
    const seen = new Set(Object.values(layout.pos).map((p) => `${p.x},${p.y}`));
    expect(seen.size).toBe(4);
  });
});

describe('computeEdges', () => {
  const edges = computeEdges(fixture());

  it('extracts routing edges and dedupes moveToNode jumps', () => {
    const route = edges.filter((e) => e.kind === 'route');
    const jump = edges.filter((e) => e.kind === 'jump');
    // s1->s2 and s3->s1 are routes; s2->s3 is a single jump (deduped from two grades).
    expect(route.map((e) => `${e.from}->${e.to}`).sort()).toEqual(['s1->s2', 's3->s1']);
    expect(jump.map((e) => `${e.from}->${e.to}`)).toEqual(['s2->s3']);
  });

  it('labels routing edges with their predicate', () => {
    const e = edges.find((x) => x.from === 's1' && x.to === 's2')!;
    expect(e.label).toBe('⚑ door');
  });

  it('drops edges pointing at scenes that do not exist', () => {
    const g = fixture();
    g.nodes[0]!.edges = [{ when: flag('x'), to: 'ghost' }];
    expect(computeEdges(g).some((e) => e.to === 'ghost')).toBe(false);
  });
});

describe('shortPredicate', () => {
  it('renders each predicate kind tersely', () => {
    expect(shortPredicate({ kind: 'always' })).toBe('always');
    expect(shortPredicate({ kind: 'turnGte', value: 3 })).toBe('turn ≥ 3');
    expect(shortPredicate({ kind: 'atNode', nodeId: 's2' })).toBe('at s2');
    expect(shortPredicate({ kind: 'flag', flag: 'lit', negate: true })).toBe('¬⚑ lit');
  });
});

describe('borderPoint', () => {
  it('exits an axis-aligned box along the ray to the target', () => {
    // box centered at origin, half-extents 10x5
    expect(borderPoint(0, 0, 10, 5, 100, 0)).toEqual({ x: 10, y: 0 }); // due right → right edge
    expect(borderPoint(0, 0, 10, 5, 0, 100)).toEqual({ x: 0, y: 5 }); // due down → bottom edge
    expect(borderPoint(0, 0, 10, 5, 100, 100)).toEqual({ x: 5, y: 5 }); // diagonal → clipped by nearer (y) edge
  });
});
