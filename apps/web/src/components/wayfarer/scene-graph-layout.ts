import type { QuestGraph, StatePredicate } from '@dsim/shared';

/**
 * Pure geometry + topology for the scene-graph canvas (see SceneGraph.tsx). Kept
 * free of React so the layout (the error-prone part — BFS levelling, reachability,
 * edge extraction) can be unit-tested directly.
 */

export const GRADES = ['success', 'partial', 'fail', 'complication'] as const;

export const NODE_W = 178;
export const NODE_H = 104;
export const COL_W = 236;
export const ROW_H = 150;
export const PAD = 30;
export const MIN_ZOOM = 0.35;
export const MAX_ZOOM = 1.6;

export type XY = { x: number; y: number };
export interface Layout {
  pos: Record<string, XY>;
  reachable: Set<string>;
  width: number;
  height: number;
}
export interface GEdge {
  from: string;
  to: string;
  kind: 'route' | 'jump';
  label: string;
  key: string;
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Forward links a scene can follow: routing edges + `moveToNode` effect jumps. */
function forwardLinks(graph: QuestGraph): Map<string, Set<string>> {
  const order = new Set(graph.nodes.map((n) => n.id));
  const adj = new Map<string, Set<string>>(graph.nodes.map((n) => [n.id, new Set<string>()]));
  const link = (from: string, to: string) => {
    if (from !== to && order.has(from) && order.has(to)) adj.get(from)!.add(to);
  };
  for (const n of graph.nodes) {
    for (const e of n.edges) link(n.id, e.to);
    for (const a of n.affordances)
      for (const grade of GRADES)
        for (const eff of a.effects[grade]) if (eff.op === 'moveToNode' && eff.nodeId) link(n.id, eff.nodeId);
  }
  return adj;
}

/** Layered BFS from the entry → left-to-right columns. Scenes with no path from
 *  the entry are flagged (not in `reachable`) and parked in a trailing column. */
export function computeLayout(graph: QuestGraph): Layout {
  const ids = graph.nodes.map((n) => n.id);
  const order = new Map(ids.map((id, i) => [id, i] as const));
  const adj = forwardLinks(graph);

  const level = new Map<string, number>();
  const start = order.has(graph.entryNodeId) ? graph.entryNodeId : ids[0];
  const queue: string[] = [];
  if (start) {
    level.set(start, 0);
    queue.push(start);
  }
  while (queue.length) {
    const cur = queue.shift()!;
    for (const nb of adj.get(cur)!)
      if (!level.has(nb)) {
        level.set(nb, level.get(cur)! + 1);
        queue.push(nb);
      }
  }
  const reachable = new Set(level.keys());
  const maxLevel = reachable.size ? Math.max(...level.values()) : 0;

  const byLevel = new Map<number, string[]>();
  for (const id of ids) {
    if (!reachable.has(id)) continue;
    const l = level.get(id)!;
    (byLevel.get(l) ?? byLevel.set(l, []).get(l)!).push(id);
  }
  const pos: Record<string, XY> = {};
  for (const [l, group] of byLevel) {
    group.sort((a, b) => order.get(a)! - order.get(b)!);
    group.forEach((id, row) => (pos[id] = { x: PAD + l * COL_W, y: PAD + row * ROW_H }));
  }
  ids
    .filter((id) => !reachable.has(id))
    .forEach((id, row) => (pos[id] = { x: PAD + (maxLevel + 1) * COL_W, y: PAD + row * ROW_H }));

  const xs = Object.values(pos).map((p) => p.x);
  const ys = Object.values(pos).map((p) => p.y);
  return {
    pos,
    reachable,
    width: (xs.length ? Math.max(...xs) : 0) + NODE_W + PAD,
    height: (ys.length ? Math.max(...ys) : 0) + NODE_H + PAD,
  };
}

/** Every drawable transition: routing edges + (deduped per from→to) moveToNode jumps. */
export function computeEdges(graph: QuestGraph): GEdge[] {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const out: GEdge[] = [];
  const jumpSeen = new Set<string>();
  for (const n of graph.nodes) {
    n.edges.forEach((e, i) => {
      if (ids.has(e.to)) out.push({ from: n.id, to: e.to, kind: 'route', label: shortPredicate(e.when), key: `r:${n.id}:${i}` });
    });
    for (const a of n.affordances)
      for (const grade of GRADES)
        for (const eff of a.effects[grade])
          if (eff.op === 'moveToNode' && eff.nodeId && ids.has(eff.nodeId)) {
            const key = `j:${n.id}->${eff.nodeId}`;
            if (jumpSeen.has(key)) continue;
            jumpSeen.add(key);
            out.push({ from: n.id, to: eff.nodeId, kind: 'jump', label: '', key });
          }
  }
  return out;
}

/** A terse, human label for a routing predicate (drawn on a highlighted edge). */
export function shortPredicate(p: StatePredicate): string {
  switch (p.kind) {
    case 'flag': return `${p.negate ? '¬' : ''}⚑ ${p.flag || '—'}`;
    case 'entityFaction': return `${p.entityId || '—'} → ${p.faction ?? 'ally'}`;
    case 'entityHp': return `${p.entityId || '—'} hp ${p.op === 'lte' ? '≤' : '≥'} ${p.value ?? 0}`;
    case 'entityDisposition': return `${p.entityId || '—'} feel ${p.op === 'lte' ? '≤' : '≥'} ${p.value ?? 0}`;
    case 'hasItem': return `has ${p.itemId || '—'}`;
    case 'atNode': return `at ${p.nodeId || '—'}`;
    case 'turnGte': return `turn ≥ ${p.value ?? 0}`;
    case 'always': return 'always';
    default: return p.kind;
  }
}

/** Where the center→toward ray exits an axis-aligned box (so arrows touch borders). */
export function borderPoint(cx: number, cy: number, halfW: number, halfH: number, tx: number, ty: number): XY {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}
