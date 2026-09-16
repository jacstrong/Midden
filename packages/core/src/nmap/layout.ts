/** Network map layouts ported from nmap2map.py: subnet rings and traceroute topology. */
import { compareIps, netKey } from '../ip/ip.js';
import { OS_COLOR_MAP } from './classify.js';
import type { ScanHost } from './types.js';

export type NodeKind = 'root' | 'subnet' | 'host' | 'router';

export interface MapNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  r: number;
  label: string;
  sub: string;
  color: string;
  /** Index into the hosts array, or -1 for synthetic nodes. */
  host: number;
}

export interface MapEdge {
  a: string;
  b: string;
  kind: 'trunk' | 'link';
}

export interface Layout {
  nodes: MapNode[];
  edges: MapEdge[];
}

export function nodeRadius(h: Pick<ScanHost, 'openCount'>): number {
  return 9 + Math.min(13, 2.6 * Math.sqrt(h.openCount));
}

function hostLabel(h: ScanHost): string {
  return h.ip.includes('.') ? '.' + (h.ip.split('.').pop() ?? '') : h.ip;
}
function hostSub(h: ScanHost): string {
  return h.hostnames[0] ? (h.hostnames[0].split('.')[0] ?? '') : '';
}

/** Hosts on concentric rings around their subnet hub; hubs on a big ring. */
export function layoutSubnet(hosts: ScanHost[], bits = 24): Layout {
  const groups = new Map<string, number[]>();
  hosts.forEach((h, i) => {
    const k = netKey(h.ip, bits);
    const g = groups.get(k);
    if (g) g.push(i);
    else groups.set(k, [i]);
  });
  const keys = [...groups.keys()].sort((a, b) =>
    compareIps(a.split('/')[0] ?? a, b.split('/')[0] ?? b),
  );

  interface Cluster {
    key: string;
    idxs: number[];
    rings: Array<[number, number]>;
    radius: number;
  }
  const clusters: Cluster[] = keys.map((k) => {
    const idxs = [...(groups.get(k) ?? [])].sort((a, b) => compareIps(hosts[a]!.ip, hosts[b]!.ip));
    const rings: Array<[number, number]> = [];
    let remaining = idxs.length;
    let r = 120;
    while (remaining > 0) {
      const cap = Math.max(6, Math.floor((2 * Math.PI * r) / 74));
      const take = Math.min(cap, remaining);
      rings.push([r, take]);
      remaining -= take;
      r += 82;
    }
    const outer = rings.length ? rings[rings.length - 1]![0] : 120;
    return { key: k, idxs, rings, radius: outer + 58 };
  });

  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  let centers: Array<[number, number]>;
  let hasRoot = false;
  if (clusters.length === 1) {
    centers = [[0, 0]];
  } else {
    const total = clusters.reduce((s, c) => s + c.radius * 2.25, 0);
    const R = Math.max(total / (2 * Math.PI), 340);
    centers = clusters.map((_c, i) => {
      const ang = (2 * Math.PI * i) / clusters.length - Math.PI / 2;
      return [R * Math.cos(ang), R * Math.sin(ang)];
    });
    nodes.push({
      id: 'root',
      kind: 'root',
      x: 0,
      y: 0,
      r: 26,
      label: 'scan',
      sub: `${clusters.length} subnets`,
      color: '#e6edf6',
      host: -1,
    });
    hasRoot = true;
  }

  clusters.forEach((c, ci) => {
    const [cx, cy] = centers[ci]!;
    const hubId = 'net:' + c.key;
    nodes.push({
      id: hubId,
      kind: 'subnet',
      x: cx,
      y: cy,
      r: 21,
      label: c.key,
      sub: `${c.idxs.length} hosts`,
      color: '#9fb0c4',
      host: -1,
    });
    if (hasRoot) edges.push({ a: 'root', b: hubId, kind: 'trunk' });
    let pos = 0;
    for (const [ringR, count] of c.rings) {
      for (let j = 0; j < count; j++) {
        const idx = c.idxs[pos++]!;
        const ang = (2 * Math.PI * j) / count - Math.PI / 2;
        const h = hosts[idx]!;
        const nid = `h:${idx}`;
        nodes.push({
          id: nid,
          kind: 'host',
          x: cx + ringR * Math.cos(ang),
          y: cy + ringR * Math.sin(ang),
          r: nodeRadius(h),
          label: hostLabel(h),
          sub: hostSub(h),
          color: OS_COLOR_MAP[h.bucket] ?? '#7b8797',
          host: idx,
        });
        edges.push({ a: hubId, b: nid, kind: 'link' });
      }
    }
  });
  return { nodes, edges };
}

/** Real topology from --traceroute hop data. Depth = column. Returns null when no host has a trace. */
export function layoutTrace(hosts: ScanHost[]): Layout | null {
  if (!hosts.some((h) => h.trace.length)) return null;
  const byIp = new Map<string, number>();
  hosts.forEach((h, i) => byIp.set(h.ip, i));

  const parent = new Map<string, string>();
  const children = new Map<string, string[]>([['root', []]]);
  const label = new Map<string, string>();
  const ensure = (nid: string, lbl: string): void => {
    if (!children.has(nid)) {
      children.set(nid, []);
      label.set(nid, lbl);
    }
  };
  const attach = (nid: string, par: string): void => {
    if (!parent.has(nid)) {
      parent.set(nid, par);
      if (!children.has(par)) children.set(par, []);
      children.get(par)!.push(nid);
    }
  };

  hosts.forEach((h, i) => {
    let prev = 'root';
    for (const hop of h.trace) {
      if (!hop.ip || hop.ip === h.ip) continue;
      const known = byIp.get(hop.ip);
      const nid = known !== undefined ? `h:${known}` : `r:${hop.ip}`;
      if (known === undefined) ensure(nid, hop.ip);
      attach(nid, prev);
      prev = nid;
    }
    const nid = `h:${i}`;
    ensure(nid, h.ip);
    attach(nid, prev);
  });
  hosts.forEach((h, i) => {
    const nid = `h:${i}`;
    if (!parent.has(nid)) {
      ensure(nid, h.ip);
      attach(nid, 'root');
    }
  });

  const depthOf = new Map<string, number>();
  const walk = (nid: string, depth: number): void => {
    depthOf.set(nid, depth);
    for (const k of children.get(nid) ?? []) walk(k, depth + 1);
  };
  walk('root', 0);

  const slot = new Map<string, number>();
  let row = 0;
  const assign = (nid: string): number => {
    const kids = children.get(nid) ?? [];
    if (!kids.length) {
      slot.set(nid, row);
      return row++;
    }
    const ys = kids.map(assign);
    const y = ys.reduce((a, b) => a + b, 0) / ys.length;
    slot.set(nid, y);
    return y;
  };
  assign('root');

  const nodes: MapNode[] = [
    {
      id: 'root',
      kind: 'root',
      x: 0,
      y: (slot.get('root') ?? 0) * 62,
      r: 24,
      label: 'scanner',
      sub: 'hop 0',
      color: '#e6edf6',
      host: -1,
    },
  ];
  const edges: MapEdge[] = [];
  for (const nid of children.keys()) {
    if (nid === 'root') continue;
    const d = depthOf.get(nid) ?? 1;
    const y = (slot.get(nid) ?? 0) * 62;
    const x = d * 250;
    if (nid.startsWith('h:')) {
      const idx = Number(nid.slice(2));
      const h = hosts[idx]!;
      nodes.push({
        id: nid,
        kind: 'host',
        x,
        y,
        r: nodeRadius(h),
        label: h.ip,
        sub: hostSub(h),
        color: OS_COLOR_MAP[h.bucket] ?? '#7b8797',
        host: idx,
      });
    } else {
      nodes.push({
        id: nid,
        kind: 'router',
        x,
        y,
        r: 15,
        label: label.get(nid) ?? nid,
        sub: `hop ${d}`,
        color: '#9fb0c4',
        host: -1,
      });
    }
  }
  for (const [nid, par] of parent)
    edges.push({ a: par, b: nid, kind: nid.startsWith('h:') ? 'link' : 'trunk' });
  return { nodes, edges };
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function layoutBounds(nodes: MapNode[], pad = 90): Bounds {
  if (!nodes.length) return { x: -pad, y: -pad, w: 2 * pad, h: 2 * pad };
  const xs = nodes.map((n) => n.x);
  const ys = nodes.map((n) => n.y);
  const rs = Math.max(...nodes.map((n) => n.r), 10);
  const minx = Math.min(...xs) - rs - pad;
  const maxx = Math.max(...xs) + rs + pad;
  const miny = Math.min(...ys) - rs - pad;
  const maxy = Math.max(...ys) + rs + pad * 0.6;
  return { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
}

export interface TerrainSummary {
  hosts: number;
  openPorts: number;
  flagged: number;
  subnets: number;
  topServices: Array<[string, number]>;
  buckets: Record<string, number>;
}

export function summarize(hosts: ScanHost[], bits = 24): TerrainSummary {
  const svc = new Map<string, number>();
  const buckets: Record<string, number> = {};
  const nets = new Set<string>();
  let openPorts = 0;
  let flagged = 0;
  for (const h of hosts) {
    for (const p of h.ports) {
      const key = p.name || `${p.port}/${p.proto}`;
      svc.set(key, (svc.get(key) ?? 0) + 1);
    }
    openPorts += h.openCount;
    if (h.flags.length) flagged++;
    buckets[h.bucket] = (buckets[h.bucket] ?? 0) + 1;
    nets.add(netKey(h.ip, bits));
  }
  const topServices = [...svc.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 8);
  return { hosts: hosts.length, openPorts, flagged, subnets: nets.size, topServices, buckets };
}
