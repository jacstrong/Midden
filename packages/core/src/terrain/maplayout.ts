/**
 * Network map geometry for the terrain view. Subnets are always drawn as hubs; a hub that the
 * analyst expands also draws its own hosts on concentric rings, using the same ring maths as
 * the original nmap2map layout. Pure: the view supplies the data and renders the result.
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

function hubRadius(hosts: number): number {
  return 16 + Math.min(26, 3.2 * Math.sqrt(hosts));
}

export function hostRadius(openCount: number): number {
  return 7 + Math.min(11, 2.2 * Math.sqrt(openCount));
}

/** Rings of (radius, capacity) large enough to hold `count` hosts without crowding. */
export function ringsFor(
  count: number,
  start = 110,
  step = 78,
  spacing = 70,
): Array<[number, number]> {
  const rings: Array<[number, number]> = [];
  let remaining = count;
  let r = start;
  while (remaining > 0) {
    const cap = Math.max(6, Math.floor((2 * Math.PI * r) / spacing));
    const take = Math.min(cap, remaining);
    rings.push([r, take]);
    remaining -= take;
    r += step;
  }
  return rings;
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

  // Each hub reserves room for its own rings when expanded, so clusters never overlap.
  const extents = ordered.map((n) => {
    const shown = expanded[n.netKey];
    if (!shown?.length) return hubRadius(n.hosts) + 30;
    const rings = ringsFor(shown.length);
    return (rings[rings.length - 1]?.[0] ?? 110) + 60;
  });

  // A lone subnet (or none) needs no scan-root node to hang the trunks from.
  const single = ordered.length <= 1;
  const total = extents.reduce((s, e) => s + e * 2.3, 0);
  const R = single ? 0 : Math.max(total / (2 * Math.PI), 340);
  const root = single ? null : { x: 0, y: 0, r: 26 };

  ordered.forEach((n, i) => {
    const ang = (2 * Math.PI * i) / Math.max(1, ordered.length) - Math.PI / 2;
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
    if (root) edges.push({ x1: root.x, y1: root.y, x2: cx, y2: cy, trunk: true });

    if (!shown.length) return;
    const sorted = [...shown].sort((a, b) => compareIps(a.ip, b.ip));
    const rings = ringsFor(sorted.length);
    let pos = 0;
    for (const [ringR, count] of rings) {
      for (let j = 0; j < count; j++) {
        const h = sorted[pos++];
        if (!h) break;
        const a = (2 * Math.PI * j) / count - Math.PI / 2;
        const x = cx + ringR * Math.cos(a);
        const y = cy + ringR * Math.sin(a);
        hosts.push({
          id: `h:${n.netKey}:${h.ip}`,
          ip: h.ip,
          netKey: n.netKey,
          x,
          y,
          r: hostRadius(h.openCount),
          color: OS_COLOR_MAP[h.bucket] ?? '#7b8797',
          flagged: h.flags.length > 0,
          host: h,
        });
        edges.push({ x1: cx, y1: cy, x2: x, y2: y, trunk: false });
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
