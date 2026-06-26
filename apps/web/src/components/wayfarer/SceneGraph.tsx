import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { QuestGraph } from '@dsim/shared';
import { Icon } from '../Icon';
import {
  NODE_W,
  NODE_H,
  PAD,
  MIN_ZOOM,
  MAX_ZOOM,
  clamp,
  computeEdges,
  computeLayout,
  borderPoint,
  type XY,
} from './scene-graph-layout';

/**
 * A pannable node-graph view of a quest's scenes — the comprehension surface for
 * the Wayfarer author. Scenes are boxes, routes are arrows (solid for a routing
 * edge, dashed for a `moveToNode` jump). The entry is starred, terminals flagged,
 * and any scene the player can't reach from the entry is dimmed. Positions are
 * auto-laid-out (the graph schema stores none) with layered BFS, then nudgeable
 * by drag (ephemeral — "Tidy" re-runs the layout). Clicking a scene selects it;
 * the editor renders that scene's full form below.
 */

interface SceneGraphProps {
  graph: QuestGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddScene: () => void;
  onSetEntry: (id: string) => void;
}

export function SceneGraph({ graph, selectedId, onSelect, onAddScene, onSetEntry }: SceneGraphProps) {
  const canvasRef = useRef<HTMLDivElement>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<XY>({ x: 0, y: 0 });
  const [manual, setManual] = useState<Record<string, XY>>({});
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  zoomRef.current = zoom;
  panRef.current = pan;

  // Re-layout (and drop manual nudges) only when the scene SET or entry changes —
  // editing an edge shouldn't reshuffle the board under the author.
  const sig = graph.nodes.map((n) => n.id).join('|') + '#' + graph.entryNodeId;
  const [nonce, setNonce] = useState(0);
  const prevSig = useRef(sig);
  useEffect(() => {
    if (prevSig.current !== sig) {
      prevSig.current = sig;
      setManual({});
      setNonce((n) => n + 1);
    }
  }, [sig]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute is gated on `nonce` (set-change), using the latest graph by closure.
  const layout = useMemo(() => computeLayout(graph), [nonce]);
  const edges = useMemo(() => computeEdges(graph), [graph]);
  const posOf = useCallback((id: string): XY => manual[id] ?? layout.pos[id] ?? { x: PAD, y: PAD }, [manual, layout]);
  // Size the canvas to its content so a small quest doesn't float one node in a void,
  // while a sprawling one still gets room to pan (capped).
  const canvasH = Math.round(clamp(layout.height + 48, 196, 460));

  const fit = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const z = clamp(Math.min((w - 24) / layout.width, (h - 24) / layout.height, 1), MIN_ZOOM, MAX_ZOOM);
    setZoom(z);
    setPan({ x: (w - layout.width * z) / 2, y: Math.max(14, (h - layout.height * z) / 2) });
  }, [layout]);

  // Fit once, after first paint (refs + measured size ready).
  const didFit = useRef(false);
  useLayoutEffect(() => {
    if (didFit.current) return;
    didFit.current = true;
    fit();
  }, [fit]);

  // Cursor-anchored wheel zoom (native, non-passive, so we can preventDefault).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = ev.clientX - rect.left;
      const cy = ev.clientY - rect.top;
      const z = zoomRef.current;
      const p = panRef.current;
      const nz = clamp(z * Math.exp(-ev.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
      setPan({ x: cx - ((cx - p.x) / z) * nz, y: cy - ((cy - p.y) / z) * nz });
      setZoom(nz);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // --- drag a node (ephemeral) / click-to-select ---
  const drag = useRef<{ id: string; sx: number; sy: number; origin: XY; moved: boolean } | null>(null);
  const onNodeDown = (e: ReactPointerEvent, id: string) => {
    e.stopPropagation();
    drag.current = { id, sx: e.clientX, sy: e.clientY, origin: { ...posOf(id) }, moved: false };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (Math.abs(ev.clientX - d.sx) + Math.abs(ev.clientY - d.sy) > 4) d.moved = true;
      setManual((m) => ({ ...m, [d.id]: { x: d.origin.x + (ev.clientX - d.sx) / zoomRef.current, y: d.origin.y + (ev.clientY - d.sy) / zoomRef.current } }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const d = drag.current;
      drag.current = null;
      if (d && !d.moved) onSelect(d.id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // --- pan the board (drag the background) ---
  const onCanvasDown = (e: ReactPointerEvent) => {
    const start = { ...panRef.current };
    const sx = e.clientX;
    const sy = e.clientY;
    const move = (ev: PointerEvent) => setPan({ x: start.x + (ev.clientX - sx), y: start.y + (ev.clientY - sy) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Edge geometry, with a gentle bow so parallel / reciprocal routes don't overlap.
  const dirIndex = new Map<string, number>();
  const geos = edges.map((e) => {
    const a = posOf(e.from);
    const b = posOf(e.to);
    const ca = { x: a.x + NODE_W / 2, y: a.y + NODE_H / 2 };
    const cb = { x: b.x + NODE_W / 2, y: b.y + NODE_H / 2 };
    const self = e.from === e.to;
    const k = `${e.from}|${e.to}`;
    const idx = dirIndex.get(k) ?? 0;
    dirIndex.set(k, idx + 1);
    const hasReverse = edges.some((o) => o.from === e.to && o.to === e.from);

    if (self) {
      const x = a.x + NODE_W;
      const y = a.y + NODE_H / 2;
      return { ...e, d: `M ${x - 14} ${y - 18} C ${x + 40} ${y - 34}, ${x + 40} ${y + 34}, ${x - 14} ${y + 18}`, lx: x + 30, ly: y };
    }
    const p1 = borderPoint(ca.x, ca.y, NODE_W / 2, NODE_H / 2, cb.x, cb.y);
    const p2 = borderPoint(cb.x, cb.y, NODE_W / 2, NODE_H / 2, ca.x, ca.y);
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const bow = (idx - (hasReverse ? -0.5 : 0)) * 26 + (hasReverse ? 22 : 0);
    const cx = mx + (-dy / len) * bow;
    const cy = my + (dx / len) * bow;
    // Lift the label a touch off the connector so it floats clear of the line.
    return { ...e, d: `M ${p1.x} ${p1.y} Q ${cx} ${cy} ${p2.x} ${p2.y}`, lx: (mx + cx) / 2, ly: (my + cy) / 2 - 14 };
  });

  const zoomBy = (f: number) => {
    const el = canvasRef.current;
    const w = el?.clientWidth ?? 0;
    const h = el?.clientHeight ?? 0;
    const z = zoomRef.current;
    const p = panRef.current;
    const nz = clamp(z * f, MIN_ZOOM, MAX_ZOOM);
    setPan({ x: w / 2 - ((w / 2 - p.x) / z) * nz, y: h / 2 - ((h / 2 - p.y) / z) * nz });
    setZoom(nz);
  };

  return (
    <div className="sg">
      <div className="sg-toolbar">
        <button className="btn primary sm" onClick={onAddScene}>
          <Icon name="plus" size={14} /> Scene
        </button>
        <div className="sg-legend" aria-hidden>
          <span className="sg-leg sg-leg-route">route</span>
          <span className="sg-leg sg-leg-jump">jump</span>
          <span className="sg-leg sg-leg-entry">entry</span>
          <span className="sg-leg sg-leg-unreach">unreachable</span>
        </div>
        <div className="sg-zoom">
          <button className="btn ghost sm" onClick={() => zoomBy(1 / 1.2)} title="Zoom out" aria-label="Zoom out">−</button>
          <span className="sg-zoom-pct">{Math.round(zoom * 100)}%</span>
          <button className="btn ghost sm" onClick={() => zoomBy(1.2)} title="Zoom in" aria-label="Zoom in">+</button>
          <button className="btn ghost sm" onClick={() => { setManual({}); setNonce((n) => n + 1); requestAnimationFrame(fit); }} title="Tidy layout">
            <Icon name="refresh" size={13} /> Tidy
          </button>
          <button className="btn ghost sm" onClick={fit} title="Fit to view">Fit</button>
        </div>
      </div>

      <div ref={canvasRef} className="sg-canvas" style={{ height: canvasH }} onPointerDown={onCanvasDown}>
        <div className="sg-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          <svg className="sg-edges" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
            <defs>
              <marker id="sg-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
              </marker>
            </defs>
            {geos.map((g) => {
              const hot = g.from === selectedId || g.to === selectedId;
              return (
                <g key={g.key} className={`sg-edge sg-edge-${g.kind}${hot ? ' hot' : ''}`}>
                  <path d={g.d} fill="none" markerEnd="url(#sg-arrow)" />
                </g>
              );
            })}
          </svg>

          {/* Route conditions, as pill-chips on the selected scene's edges (HTML, so
              they read cleanly over nodes/grid instead of clipping like SVG text). */}
          <div className="sg-labels">
            {geos.map((g) =>
              g.label && (g.from === selectedId || g.to === selectedId) ? (
                <span key={g.key} className="sg-edge-chip" style={{ left: g.lx, top: g.ly }}>{g.label}</span>
              ) : null,
            )}
          </div>

          <div className="sg-nodes">
            {graph.nodes.map((n, i) => {
              const p = posOf(n.id);
              const isEntry = n.id === graph.entryNodeId;
              const unreachable = !layout.reachable.has(n.id);
              const selected = n.id === selectedId;
              return (
                <div
                  key={n.id}
                  className={`sg-node${selected ? ' selected' : ''}${isEntry ? ' entry' : ''}${unreachable ? ' unreachable' : ''}`}
                  style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                  onPointerDown={(e) => onNodeDown(e, n.id)}
                  title={unreachable ? 'No route reaches this scene from the entry' : undefined}
                >
                  <div className="sg-node-head">
                    <span className="sg-node-no">{i + 1}</span>
                    <span className="sg-node-id">{n.id}</span>
                    {!isEntry && (
                      <button
                        className="sg-node-entrybtn"
                        title="Make this the entry scene"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); onSetEntry(n.id); }}
                      >
                        <Icon name="play" size={11} />
                      </button>
                    )}
                  </div>
                  <div className="sg-node-tags">
                    {isEntry && <span className="sg-tag entry"><Icon name="play" size={9} /> Entry</span>}
                    {n.isTerminal && <span className="sg-tag term"><Icon name="end" size={9} /> End</span>}
                    {unreachable && <span className="sg-tag warn"><Icon name="warn" size={9} /> Unreachable</span>}
                    {!isEntry && !n.isTerminal && !unreachable && n.kind !== 'scene' && <span className="sg-tag">{n.kind}</span>}
                  </div>
                  <div className="sg-node-stats">
                    <span className="sg-stat" title="entities"><Icon name="people" size={11} /> {n.entities.length}</span>
                    <span className="sg-stat" title="approaches"><Icon name="quest" size={11} /> {n.affordances.length}</span>
                    <span className="sg-stat" title="routes out"><Icon name="send" size={11} /> {n.edges.length}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="sg-hint">
          {graph.nodes.length <= 1
            ? 'One scene so far — add scenes with ＋ to branch it into routes'
            : 'Drag to pan · scroll to zoom · click a scene to edit'}
        </div>
      </div>
    </div>
  );
}
