import { describe, expect, it } from 'vitest';
import { layoutTerrainMap, ringsFor, hostRadius, MAP_NODE_BUDGET } from './maplayout.js';
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

  it('handles an empty scan', () => {
    const l = layoutTerrainMap([]);
    expect(l.hubs).toEqual([]);
    expect(l.bounds.w).toBeGreaterThan(0);
    expect(l.nodeCount).toBe(0);
  });
});
