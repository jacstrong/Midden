import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Moves map nodes from where they were drawn to where a new layout puts them, and pulls the
 * camera back to fit the whole map, so expanding a subnet reads as the graph rebalancing rather
 * than as a jump. Nodes that appear grow out of their parent.
 */

export interface Point {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Pan and zoom on top of the viewBox: screen = k * point + (x, y). */
export interface View {
  k: number;
  x: number;
  y: number;
}
export interface Frame {
  pos: Map<string, Point>;
  bounds: Box;
  /** Frames only animate into frames of the same scope (the same loaded scan data). */
  scope: unknown;
}

export const MOTION_MS = 380;
/** Past this many nodes a tween costs more frames than it is worth; the map just jumps. */
export const MOTION_NODE_LIMIT = 1500;

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** The part of the scene actually on screen, as a viewBox with no pan or zoom applied. */
export function visibleBox(bounds: Box, v: View): Box {
  return {
    x: (bounds.x - v.x) / v.k,
    y: (bounds.y - v.y) / v.k,
    w: bounds.w / v.k,
    h: bounds.h / v.k,
  };
}

/**
 * The frame `t` of the way from `from` to `to`. Nodes only in `to` start at their parent's
 * old position (or its new one, if the parent is new too); nodes only in `from` are dropped.
 */
export function blend(
  from: Frame,
  to: Frame,
  t: number,
  parentOf: ReadonlyMap<string, string>,
): Frame {
  const e = ease(t);
  const start = (id: string): Point | undefined => {
    for (let cur: string | undefined = id; cur !== undefined; cur = parentOf.get(cur)) {
      const p = from.pos.get(cur);
      if (p) return p;
    }
    return undefined;
  };
  const pos = new Map<string, Point>();
  for (const [id, p] of to.pos) {
    const s = start(id) ?? to.pos.get(parentOf.get(id) ?? '') ?? p;
    pos.set(id, { x: mix(s.x, p.x, e), y: mix(s.y, p.y, e) });
  }
  const a = from.bounds;
  const b = to.bounds;
  return {
    pos,
    scope: to.scope,
    bounds: { x: mix(a.x, b.x, e), y: mix(a.y, b.y, e), w: mix(a.w, b.w, e), h: mix(a.h, b.h, e) },
  };
}

function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * The frame to draw now. Whenever `target` changes the camera refits: the current pan and zoom
 * are folded into the starting viewBox and `onRefit` clears them, so the view glides out to the
 * new bounds. Moving to a different scope (another scan) simply lands on the target.
 */
export function useMapMotion(
  target: Frame,
  parentOf: ReadonlyMap<string, string>,
  opts: { getView: () => View; onRefit: () => void },
): Frame {
  const [frame, setFrame] = useState(target);
  const painted = useRef(target);
  const settled = useRef<Frame | null>(target);
  const { getView, onRefit } = opts;

  useLayoutEffect(() => {
    if (settled.current === target) return;
    settled.current = target;
    const from: Frame = {
      ...painted.current,
      bounds: visibleBox(painted.current.bounds, getView()),
    };
    onRefit();
    if (from.scope !== target.scope || reducedMotion() || target.pos.size > MOTION_NODE_LIMIT) {
      painted.current = target;
      setFrame(target);
      return;
    }
    const first = blend(from, target, 0, parentOf);
    painted.current = first;
    setFrame(first);
    const t0 = performance.now();
    let raf = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - t0) / MOTION_MS);
      const f = t >= 1 ? target : blend(from, target, t, parentOf);
      painted.current = f;
      setFrame(f);
      if (t < 1) raf = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(raf);
      // Interrupted part-way: let the next run carry on from wherever the nodes are now.
      if (painted.current !== target) settled.current = null;
    };
    // getView and onRefit are read at the moment the target changes, not tracked
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, parentOf]);

  return frame;
}
