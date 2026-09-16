/** Branch-graph geometry (one lane per host, pivot curves), ported from the prototype's renderGraph. */
import type { CaseState, Event } from '../domain/types.js';
import { toEpoch } from '../time/time.js';
import { fmtDate, type TzMode } from './display.js';
import { laneList, laneMeta, UNASSIGNED_LANE, type LaneMeta } from './derive.js';

export const G = { PAD: 32, LW: 46, ROW: 52, MIN: 38, TOP: 48, DAY: 34, R: 6 } as const;

export type GraphMode = 'seq' | 'time';

export interface GraphOptions {
  mode: GraphMode;
  tz: TzMode;
  laneAll: boolean;
  selectedId?: string | null | undefined;
}

export interface GraphLane {
  key: string;
  x: number;
  meta: LaneMeta;
  /** y extent of the active spine, or null when the lane has no events. */
  spine: [number, number] | null;
}

export interface GraphNode {
  event: Event;
  x: number;
  y: number;
  r: number;
  fill: string;
  stroke: string;
  selected: boolean;
}

export interface GraphPivot {
  eventId: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  c1: { x: number; y: number };
  c2: { x: number; y: number };
}

export interface DayBreak {
  y: number;
  label: string;
}

export interface GraphLayout {
  lanes: GraphLane[];
  nodes: GraphNode[];
  pivots: GraphPivot[];
  breaks: DayBreak[];
  rowsY: number[];
  width: number;
  height: number;
}

export function layoutY(
  events: Event[],
  mode: GraphMode,
  tz: TzMode,
): { ys: number[]; breaks: DayBreak[] } {
  const ys: number[] = [];
  const breaks: DayBreak[] = [];
  if (!events.length) return { ys, breaks };
  let lastDay = '';
  let shift = 0;
  let prev = -1e9;
  const t0 = toEpoch(events[0]!.ts);
  const t1 = toEpoch(events[events.length - 1]!.ts);
  const span = Math.max(1, t1 - t0);
  const H = Math.max(events.length * G.ROW, 520);
  events.forEach((e, i) => {
    const day = fmtDate(e, tz);
    const newDay = day !== lastDay;
    if (newDay && i > 0) shift += G.DAY;
    let y =
      mode === 'seq'
        ? G.TOP + i * G.ROW + shift
        : G.TOP + ((toEpoch(e.ts) - t0) / span) * H + shift;
    const floor = prev + (newDay && i > 0 ? G.MIN + G.DAY : G.MIN);
    if (y < floor) y = floor;
    prev = y;
    ys.push(y);
    if (newDay) {
      lastDay = day;
      breaks.push({ y: Math.round(y - 26), label: day });
    }
  });
  return { ys, breaks };
}

export function layoutBranchGraph(
  state: CaseState,
  events: Event[],
  opts: GraphOptions,
  tacticColor: (e: Event) => string | null,
): GraphLayout {
  const laneKeys = laneList(events, state.hosts, opts.laneAll);
  const lx = new Map<string, number>();
  laneKeys.forEach((k, i) => lx.set(k, G.PAD + i * G.LW));
  const { ys, breaks } = layoutY(events, opts.mode, opts.tz);
  const width = G.PAD + laneKeys.length * G.LW + 10;
  const height = ys.length ? ys[ys.length - 1]! + 70 : 520;

  const laneEvents = new Map<string, number[]>();
  for (const k of laneKeys) laneEvents.set(k, []);
  events.forEach((e, i) => laneEvents.get(e.hostId || UNASSIGNED_LANE)?.push(i));

  const lanes: GraphLane[] = laneKeys.map((key) => {
    const idx = laneEvents.get(key) ?? [];
    return {
      key,
      x: lx.get(key)!,
      meta: laneMeta(state, key),
      spine: idx.length ? [ys[idx[0]!]!, ys[idx[idx.length - 1]!]!] : null,
    };
  });

  const pivots: GraphPivot[] = [];
  events.forEach((e, i) => {
    if (!e.srcHostId) return;
    const dk = e.hostId || UNASSIGNED_LANE;
    const sk = e.srcHostId;
    const sx = lx.get(sk);
    const dx = lx.get(dk);
    if (sk === dk || sx === undefined || dx === undefined) return;
    const y = ys[i]!;
    let ay: number | null = null;
    for (const j of laneEvents.get(sk) ?? []) if (ys[j]! <= y) ay = ys[j]!;
    if (ay === null) ay = Math.max(0, y - G.ROW);
    pivots.push({
      eventId: e.id,
      from: { x: sx, y: ay },
      to: { x: dx, y: y - G.R - 3 },
      c1: { x: sx, y: ay + (y - ay) * 0.55 },
      c2: { x: dx, y: y - (y - ay) * 0.42 },
    });
  });

  const nodes: GraphNode[] = [];
  events.forEach((e, i) => {
    const k = e.hostId || UNASSIGNED_LANE;
    const x = lx.get(k);
    if (x === undefined) return;
    nodes.push({
      event: e,
      x,
      y: ys[i]!,
      r: e.key ? G.R + 2 : G.R,
      fill: tacticColor(e) ?? '#0d1524',
      stroke: laneMeta(state, k).color,
      selected: opts.selectedId === e.id,
    });
  });

  return { lanes, nodes, pivots, breaks, rowsY: ys, width, height };
}
