import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  layoutTerrainMap,
  ringsFor,
  hostRadius,
  hubRingRadius,
  MAP_NODE_BUDGET,
  type TerrainMapLayout,
} from './maplayout.js';
import { toTerrainSummary, type NetAggregate } from './aggregate.js';
import { classify } from '../nmap/classify.js';
import { newScanHost, newScanPort } from '../nmap/types.js';

const net = (netKey: string, hosts: number, extra: Partial<NetAggregate> = {}): NetAggregate => ({
  netKey,
  hosts,
  openPorts: hosts * 2,
  flagged: 0,
  buckets: { Unknown: hosts },
  ...extra,
});
const host = (ip: string, ports: number[] = []) =>
  toTerrainSummary(
    classify({
      ...newScanHost(),
      ip,
      ports: ports.map((p) => ({ ...newScanPort(), port: p, state: 'open' })),
    }),
  );

/** Radius of the disc a hub's drawing occupies: the hub alone, or out to its farthest host. */
function clusterRadius(l: TerrainMapLayout, netKey: string): number {
  const hub = l.hubs.find((h) => h.netKey === netKey)!;
  let r = hub.r;
  for (const h of l.hosts)
    if (h.netKey === netKey) r = Math.max(r, Math.hypot(h.x - hub.x, h.y - hub.y) + h.r);
  return r;
}

/** Distance from point p to the segment a-b. */
function toSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Every way a cluster could be drawn on top of something else. */
function overlaps(l: TerrainMapLayout): string[] {
  const out: string[] = [];
  const radius = new Map(l.hubs.map((h) => [h.netKey, clusterRadius(l, h.netKey)]));
  for (const [i, a] of l.hubs.entries()) {
    const ra = radius.get(a.netKey)!;
    if (l.root && Math.hypot(a.x - l.root.x, a.y - l.root.y) < ra + l.root.r)
      out.push(`${a.netKey} covers the root`);
    for (const b of l.hubs.slice(i + 1))
      if (Math.hypot(a.x - b.x, a.y - b.y) < ra + radius.get(b.netKey)!)
        out.push(`${a.netKey} overlaps ${b.netKey}`);
    if (!l.root) continue;
    for (const b of l.hubs)
      if (b !== a && toSegment(b, l.root, a) < radius.get(b.netKey)!)
        out.push(`trunk to ${a.netKey} crosses ${b.netKey}`);
    for (const h of l.hosts)
      if (h.netKey === a.netKey && toSegment(h, l.root, a) < h.r)
        out.push(`trunk to ${a.netKey} crosses ${h.ip}`);
  }
  return out;
}

const pool = Array.from({ length: 254 }, (_, i) => host(`10.9.0.${i + 1}`, i % 7 ? [] : [22, 445]));

describe('layoutTerrainMap', () => {
  it('centres a single subnet with no root node', () => {
    const l = layoutTerrainMap([net('10.0.0.0/24', 5)]);
    expect(l.root).toBeNull();
    expect(l.hubs).toHaveLength(1);
    expect(l.hubs[0]).toMatchObject({
      x: 0,
      y: 0,
      netKey: '10.0.0.0/24',
      hosts: 5,
      expanded: false,
    });
    expect(l.hosts).toEqual([]);
    expect(l.edges).toEqual([]);
    expect(l.nodeCount).toBe(1);
  });

  it('places several subnets on a ring around a root, ordered by address', () => {
    const l = layoutTerrainMap([
      net('10.0.2.0/24', 3),
      net('10.0.10.0/24', 1),
      net('10.0.1.0/24', 2),
    ]);
    expect(l.hubs.map((h) => h.netKey)).toEqual(['10.0.1.0/24', '10.0.2.0/24', '10.0.10.0/24']);
    expect(l.root).toMatchObject({ x: 0, y: 0 });
    expect(l.edges.filter((e) => e.trunk)).toHaveLength(3);
    expect(l.hubs[0]!.y).toBeLessThan(0); // first hub starts at twelve o'clock
    for (const h of l.hubs) expect(Math.hypot(h.x, h.y)).toBeGreaterThan(300);
  });

  it('draws hosts on concentric rings around an expanded hub only', () => {
    const nets = [net('10.0.0.0/24', 3), net('10.0.1.0/24', 2)];
    const l = layoutTerrainMap(nets, {
      '10.0.0.0/24': [host('10.0.0.3', [22]), host('10.0.0.1'), host('10.0.0.2', [445, 3389])],
    });
    expect(l.hubs.find((h) => h.netKey === '10.0.0.0/24')!.expanded).toBe(true);
    expect(l.hubs.find((h) => h.netKey === '10.0.1.0/24')!.expanded).toBe(false);
    expect(l.hosts.map((h) => h.ip)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    const hub = l.hubs.find((h) => h.netKey === '10.0.0.0/24')!;
    for (const h of l.hosts) expect(Math.hypot(h.x - hub.x, h.y - hub.y)).toBeCloseTo(110, 5);
    expect(l.hosts.find((h) => h.ip === '10.0.0.2')!.flagged).toBe(true);
    expect(l.hosts.find((h) => h.ip === '10.0.0.1')!.flagged).toBe(false);
    expect(l.edges.filter((e) => !e.trunk)).toHaveLength(3);
    expect(l.nodeCount).toBe(6);
  });

  it('overflows crowded subnets onto further rings and grows the bounds', () => {
    const many = Array.from({ length: 30 }, (_, i) => host(`10.0.0.${i + 1}`));
    const l = layoutTerrainMap([net('10.0.0.0/24', 30)], { '10.0.0.0/24': many });
    const hub = l.hubs[0]!;
    const radii = new Set(l.hosts.map((h) => Math.round(Math.hypot(h.x - hub.x, h.y - hub.y))));
    expect(radii.size).toBeGreaterThan(1);
    expect([...radii]).toContain(110);
    expect(l.bounds.w).toBeGreaterThan(400);
    expect(l.hosts).toHaveLength(30);
  });

  it('sizes rings and radii predictably', () => {
    expect(ringsFor(3)).toEqual([[110, 3]]);
    expect(ringsFor(100)[0]![1]).toBe(9);
    expect(ringsFor(100).reduce((n, r) => n + r[1], 0)).toBe(100);
    expect(hostRadius(0)).toBe(7);
    expect(hostRadius(100)).toBe(18);
    expect(MAP_NODE_BUDGET).toBe(3000);
  });

  it('keeps a fully expanded /24 clear of the root and its neighbours', () => {
    const nets = ['10.0.0.0/24', '10.0.1.0/24', '10.0.2.0/24', '10.0.3.0/24', '10.0.4.0/24'];
    const l = layoutTerrainMap(
      nets.map((k) => net(k, k === '10.0.2.0/24' ? 254 : 3)),
      { '10.0.2.0/24': pool },
    );
    expect(l.hosts).toHaveLength(254);
    expect(overlaps(l)).toEqual([]);
  });

  it('never overlaps clusters, the root or the trunks, whatever is expanded', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ hosts: fc.integer({ min: 1, max: 254 }), open: fc.boolean() }), {
          minLength: 2,
          maxLength: 40,
        }),
        (spec) => {
          const nets = spec.map((s, i) => net(`10.${i >> 8}.${i & 255}.0/24`, s.hosts));
          const expanded = Object.fromEntries(
            spec.flatMap((s, i) => (s.open ? [[nets[i]!.netKey, pool.slice(0, s.hosts)]] : [])),
          );
          expect(overlaps(layoutTerrainMap(nets, expanded))).toEqual([]);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('opens expanded rings towards the root', () => {
    const l = layoutTerrainMap([net('10.0.0.0/24', 3), net('10.0.1.0/24', 2)], {
      '10.0.0.0/24': pool.slice(0, 3),
    });
    const hub = l.hubs[0]!;
    const towardRoot = Math.atan2(-hub.y, -hub.x);
    for (const h of l.hosts) {
      const off = Math.abs(
        ((Math.atan2(h.y - hub.y, h.x - hub.x) - towardRoot + 3 * Math.PI) % (2 * Math.PI)) -
          Math.PI,
      );
      expect(off).toBeGreaterThan(Math.PI / 8);
    }
  });

  it('names both ends of every edge', () => {
    const l = layoutTerrainMap([net('10.0.0.0/24', 2), net('10.0.1.0/24', 1)], {
      '10.0.0.0/24': pool.slice(0, 2),
    });
    const ids = new Set(['root', ...l.hubs.map((h) => h.id), ...l.hosts.map((h) => h.id)]);
    for (const e of l.edges) expect(ids.has(e.a) && ids.has(e.b)).toBe(true);
  });

  it('grows the hub ring only as far as the clusters need', () => {
    expect(hubRingRadius([])).toBe(340);
    expect(hubRingRadius([60, 60, 60])).toBe(340);
    const big = hubRingRadius([716, 70, 70, 70, 70]);
    expect(big).toBeGreaterThanOrEqual(716 + 26 + 60);
    expect(hubRingRadius(Array(256).fill(70))).toBeGreaterThan(5000);
  });

  it('handles an empty scan', () => {
    const l = layoutTerrainMap([]);
    expect(l.hubs).toEqual([]);
    expect(l.bounds.w).toBeGreaterThan(0);
    expect(l.nodeCount).toBe(0);
  });
});
