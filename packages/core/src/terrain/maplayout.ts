/**
 * Network map geometry for the terrain view. Subnets are always drawn as hubs; a hub that the
 * analyst expands also draws its own hosts on concentric rings, using the same ring maths as
 * the original nmap2map layout. Hubs are spaced by cluster size so an expanded subnet never
 * covers its neighbours or the root. Pure: the view supplies the data and renders the result.
 */
import { compareIps } from '../ip/ip.js';
import { OS_COLOR_MAP } from '../nmap/classify.js';
import type { NetAggregate, TerrainHostSummary } from './aggregate.js';

export interface MapHubNode {
  id: string;
  netKey: string;
  x: number;
  y: number;
  r: number;
  hosts: number;
  flagged: number;
  openPorts: number;
  buckets: Record<string, number>;
  expanded: boolean;
}

export interface MapHostNode {
  id: string;
  ip: string;
  netKey: string;
  x: number;
  y: number;
  r: number;
  color: string;
  flagged: boolean;
  host: TerrainHostSummary;
}

export interface MapEdgeLine {
  /** Node ids at each end ('root', a hub id or a host id), so the view can redraw it mid-move. */
  a: string;
  b: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  trunk: boolean;
}

export interface TerrainMapLayout {
  hubs: MapHubNode[];
  hosts: MapHostNode[];
  edges: MapEdgeLine[];
  root: { x: number; y: number; r: number } | null;
  bounds: { x: number; y: number; w: number; h: number };
  /** Total drawn nodes, so the view can refuse to auto-expand past its budget. */
  nodeCount: number;
}

export const MAP_NODE_BUDGET = 3000;

const ROOT_R = 26;
/** Smallest radius for the ring of hubs, so a few subnets still spread out. */
const MIN_HUB_RING = 340;
/** Clear space between neighbouring clusters. */
const CLUSTER_GAP = 40;
/** Clear space between the root node and the nearest cluster edge. */
const ROOT_CLEARANCE = 60;
/** Opening left in an expanded subnet's rings on the side facing the root, for its trunk. */
export const TRUNK_GAP = Math.PI / 3.5;

function hubRadius(hosts: number): number {
  return 16 + Math.min(26, 3.2 * Math.sqrt(hosts));
}

export function hostRadius(openCount: number): number {
  return 7 + Math.min(11, 2.2 * Math.sqrt(openCount));
}

/**
 * Rings of (radius, capacity) large enough to hold `count` hosts without crowding. `arc` is how
 * much of each ring may be used, in radians.
 */
export function ringsFor(
  count: number,
  start = 110,
  step = 78,
  spacing = 70,
  arc = 2 * Math.PI,
): Array<[number, number]> {
  const rings: Array<[number, number]> = [];
  let remaining = count;
  let r = start;
  while (remaining > 0) {
    const cap = Math.max(6, Math.floor((arc * r) / spacing));
    const take = Math.min(cap, remaining);
    rings.push([r, take]);
    remaining -= take;
    r += step;
  }
  return rings;
}

/** Half the angle, seen from the root, that a cluster of radius `extent` at distance `R` covers. */
function halfWedge(extent: number, R: number): number {
  return Math.asin(Math.min(1, (extent + CLUSTER_GAP / 2) / R));
}

/**
 * Smallest radius for the ring of hubs at which every cluster fits in its own wedge around the
 * root and none reaches the root. A disc inside its wedge cannot touch a disc in another wedge,
 * so this is what keeps clusters apart however unevenly sized they are.
 */
export function hubRingRadius(extents: number[]): number {
  if (!extents.length) return MIN_HUB_RING;
  const fits = (R: number): boolean =>
    extents.reduce((s, e) => s + 2 * halfWedge(e, R), 0) <= 2 * Math.PI;
  let lo = Math.max(MIN_HUB_RING, Math.max(...extents) + ROOT_R + ROOT_CLEARANCE);
  if (fits(lo)) return lo;
  let hi = lo * 2;
  while (!fits(hi)) hi *= 2;
  for (let i = 0; i < 40 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

export function layoutTerrainMap(
  nets: NetAggregate[],
  expanded: Record<string, TerrainHostSummary[]> = {},
): TerrainMapLayout {
  const ordered = [...nets].sort((a, b) =>
    compareIps(a.netKey.split('/')[0] ?? a.netKey, b.netKey.split('/')[0] ?? b.netKey),
  );
  const hubs: MapHubNode[] = [];
  const hosts: MapHostNode[] = [];
  const edges: MapEdgeLine[] = [];

  // A lone subnet (or none) needs no scan-root node to hang the trunks from, and can use
  // its whole ring because no trunk arrives.
  const single = ordered.length <= 1;
  const arc = single ? 2 * Math.PI : 2 * Math.PI - TRUNK_GAP;
  const root = single ? null : { x: 0, y: 0, r: ROOT_R };

  // Each cluster's radius: just the hub when collapsed, its outer ring when expanded.
  const extents = ordered.map((n) => {
    const shown = expanded[n.netKey];
    if (!shown?.length) return hubRadius(n.hosts) + 30;
    const rings = ringsFor(shown.length, undefined, undefined, undefined, arc);
    return (rings[rings.length - 1]?.[0] ?? 110) + 60;
  });

  // Hubs sit on one ring around the root, each in a wedge sized to its cluster, with spare
  // angle shared out evenly. The first hub stays at twelve o'clock.
  const R = single ? 0 : hubRingRadius(extents);
  const half = extents.map((e) => (single ? 0 : halfWedge(e, R)));
  const slack = single ? 0 : (2 * Math.PI - 2 * half.reduce((s, h) => s + h, 0)) / ordered.length;
  let ang = -Math.PI / 2;

  ordered.forEach((n, i) => {
    if (i > 0) ang += half[i - 1]! + slack + half[i]!;
    const cx = single ? 0 : R * Math.cos(ang);
    const cy = single ? 0 : R * Math.sin(ang);
    const shown = expanded[n.netKey] ?? [];
    const hub: MapHubNode = {
      id: `net:${n.netKey}`,
      netKey: n.netKey,
      x: cx,
      y: cy,
      r: hubRadius(n.hosts),
      hosts: n.hosts,
      flagged: n.flagged,
      openPorts: n.openPorts,
      buckets: n.buckets,
      expanded: shown.length > 0,
    };
    hubs.push(hub);
    if (root)
      edges.push({ a: 'root', b: hub.id, x1: root.x, y1: root.y, x2: cx, y2: cy, trunk: true });

    if (!shown.length) return;
    // Rings open towards the root, so the trunk reaches the hub without crossing any host.
    const from = single ? -Math.PI / 2 : ang + Math.PI + TRUNK_GAP / 2;
    const sorted = [...shown].sort((a, b) => compareIps(a.ip, b.ip));
    const rings = ringsFor(sorted.length, undefined, undefined, undefined, arc);
    let pos = 0;
    for (const [ringR, count] of rings) {
      for (let j = 0; j < count; j++) {
        const h = sorted[pos++];
        if (!h) break;
        const a = single ? from + (arc * j) / count : from + (arc * (j + 0.5)) / count;
        const x = cx + ringR * Math.cos(a);
        const y = cy + ringR * Math.sin(a);
        const id = `h:${n.netKey}:${h.ip}`;
        hosts.push({
          id,
          ip: h.ip,
          netKey: n.netKey,
          x,
          y,
          r: hostRadius(h.openCount),
          color: OS_COLOR_MAP[h.bucket] ?? '#7b8797',
          flagged: h.flags.length > 0,
          host: h,
        });
        edges.push({ a: hub.id, b: id, x1: cx, y1: cy, x2: x, y2: y, trunk: false });
      }
    }
  });

  const pts = [...hubs, ...hosts, ...(root ? [{ x: root.x, y: root.y, r: root.r }] : [])];
  const pad = 90;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const maxR = Math.max(10, ...pts.map((p) => p.r));
  const bounds = pts.length
    ? {
        x: Math.min(...xs) - maxR - pad,
        y: Math.min(...ys) - maxR - pad,
        w: Math.max(...xs) - Math.min(...xs) + 2 * (maxR + pad),
        h: Math.max(...ys) - Math.min(...ys) + 2 * (maxR + pad),
      }
    : { x: -pad, y: -pad, w: 2 * pad, h: 2 * pad };
  return {
    hubs,
    hosts,
    edges,
    root,
    bounds,
    nodeCount: hubs.length + hosts.length + (root ? 1 : 0),
  };
}
