import { describe, expect, it } from 'vitest';
import {
  layoutBounds,
  layoutSubnet,
  layoutTrace,
  nodeRadius,
  summarize,
  traceBranches,
  traceFanouts,
  TRACE_FANOUT_LIMIT,
} from './layout.js';
import { classify } from './classify.js';
import { newScanHost, newScanPort, type ScanHost } from './types.js';

const mk = (ip: string, ports: number[] = [], extra: Partial<ScanHost> = {}): ScanHost =>
  classify({
    ...newScanHost(),
    ip,
    ports: ports.map((p) => ({ ...newScanPort(), port: p, state: 'open' })),
    ...extra,
  });

describe('classify', () => {
  it('buckets by OS blob, then by services', () => {
    expect(mk('10.0.0.1', [445, 3389]).bucket).toBe('Windows');
    expect(mk('10.0.0.1', [9100]).bucket).toBe('Printer');
    expect(
      mk('10.0.0.1', [22], {
        ports: [{ ...newScanPort(), port: 22, state: 'open', name: 'ssh', product: 'OpenSSH' }],
      }).bucket,
    ).toBe('Linux / Unix');
    expect(mk('10.0.0.1', [22], { osName: 'Cisco IOS 15' }).bucket).toBe('Network device');
    expect(mk('10.0.0.1', [], { vendor: 'Apple, Inc.' }).bucket).toBe('Apple');
    expect(mk('10.0.0.1', [80]).bucket).toBe('Unknown');
  });
  it('picks the first matching role, then gateway heuristic', () => {
    expect(mk('10.0.0.5', [88, 389, 445]).role).toBe('Domain controller');
    expect(mk('10.0.0.5', [445, 80]).role).toBe('Web server');
    expect(mk('10.0.0.1', [], { distance: 1 }).role).toBe('Likely gateway');
    expect(mk('10.0.0.2', [], { distance: 1 }).role).toBe('');
  });
  it('flags notable tcp ports only', () => {
    const h = mk('10.0.0.1', [23, 445], {
      ports: [
        { ...newScanPort(), port: 23, state: 'open' },
        { ...newScanPort(), port: 161, proto: 'udp', state: 'open' },
      ],
    });
    expect(h.flags).toEqual(['23/tcp - Telnet (cleartext credentials)']);
    expect(h.openCount).toBe(2);
  });
});

describe('layoutSubnet', () => {
  it('lays a single subnet around the origin with no root', () => {
    const hosts = [mk('10.0.0.3'), mk('10.0.0.1'), mk('10.0.0.2')];
    const l = layoutSubnet(hosts);
    expect(l.nodes.find((n) => n.kind === 'root')).toBeUndefined();
    const hub = l.nodes.find((n) => n.kind === 'subnet')!;
    expect(hub).toMatchObject({ id: 'net:10.0.0.0/24', x: 0, y: 0, sub: '3 hosts' });
    const hostNodes = l.nodes.filter((n) => n.kind === 'host');
    expect(hostNodes).toHaveLength(3);
    // hosts are placed by ascending ip on ring 120
    expect(hostNodes.map((n) => hosts[n.host]!.ip)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    for (const n of hostNodes) expect(Math.hypot(n.x, n.y)).toBeCloseTo(120, 5);
    expect(l.edges.every((e) => e.a === hub.id)).toBe(true);
  });
  it('rings overflow and multiple subnets get a root', () => {
    const many = Array.from({ length: 20 }, (_, i) => mk(`10.0.0.${i + 1}`));
    const other = [mk('10.0.1.1'), mk('192.168.0.1')];
    const l = layoutSubnet([...many, ...other]);
    expect(l.nodes.find((n) => n.kind === 'root')).toMatchObject({ sub: '3 subnets' });
    const hubs = l.nodes.filter((n) => n.kind === 'subnet').map((n) => n.label);
    expect(hubs).toEqual(['10.0.0.0/24', '10.0.1.0/24', '192.168.0.0/24']);
    const radii = new Set(
      l.nodes
        .filter((n) => n.kind === 'host' && n.id !== 'h:20' && n.id !== 'h:21')
        .map((n) => Math.round(Math.hypot(n.x - l.nodes[1]!.x, n.y - l.nodes[1]!.y))),
    );
    expect(radii).toEqual(new Set([120, 202]));
    expect(l.edges.filter((e) => e.kind === 'trunk')).toHaveLength(3);
    expect(nodeRadius({ openCount: 0 })).toBe(9);
    expect(nodeRadius({ openCount: 100 })).toBe(22);
  });
});

describe('layoutTrace', () => {
  it('returns null without hop data', () => {
    expect(layoutTrace([mk('10.0.0.1')])).toBeNull();
  });
  it('builds a tree through routers and known hosts', () => {
    const gw = mk('10.0.0.1', [], { trace: [{ ttl: 1, ip: '10.0.0.1', host: '', rtt: '1' }] });
    const a = mk('10.0.1.5', [], {
      trace: [
        { ttl: 1, ip: '10.0.0.1', host: '', rtt: '1' },
        { ttl: 2, ip: '10.0.1.254', host: '', rtt: '2' },
        { ttl: 3, ip: '10.0.1.5', host: '', rtt: '3' },
      ],
    });
    const b = mk('10.0.1.6', [], {
      trace: [
        { ttl: 1, ip: '10.0.0.1', host: '', rtt: '1' },
        { ttl: 2, ip: '10.0.1.254', host: '', rtt: '2' },
        { ttl: 3, ip: '10.0.1.6', host: '', rtt: '3' },
      ],
    });
    const orphan = mk('172.16.0.9');
    const l = layoutTrace([gw, a, b, orphan])!;
    const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    expect(byId['h:0']!.x).toBe(250);
    expect(byId['r:10.0.1.254']).toMatchObject({ kind: 'router', x: 500, sub: 'hop 2' });
    expect(byId['h:1']!.x).toBe(750);
    expect(byId['h:2']!.x).toBe(750);
    expect(byId['h:3']!.x).toBe(250);
    expect(l.edges).toContainEqual({ a: 'root', b: 'h:0', kind: 'link' });
    expect(l.edges).toContainEqual({ a: 'h:0', b: 'r:10.0.1.254', kind: 'trunk' });
    expect(l.edges).toContainEqual({ a: 'r:10.0.1.254', b: 'h:1', kind: 'link' });
    const bounds = layoutBounds(l.nodes);
    expect(bounds.w).toBeGreaterThan(750);
  });
});

describe('collapsing the trace', () => {
  const hop = (ttl: number, ip: string) => ({ ttl, ip, host: '', rtt: String(ttl) });
  // scanner -> 10.0.0.1 (scanned gateway) -> router 10.0.1.254 -> n hosts; plus one host on the gateway
  const scan = (n: number): ScanHost[] => [
    mk('10.0.0.1', [], { trace: [hop(1, '10.0.0.1')] }),
    mk('10.0.0.9', [], { trace: [hop(1, '10.0.0.1'), hop(2, '10.0.0.9')] }),
    ...Array.from({ length: n }, (_, i) =>
      mk(`10.0.1.${i + 1}`, [], {
        trace: [hop(1, '10.0.0.1'), hop(2, '10.0.1.254'), hop(3, `10.0.1.${i + 1}`)],
      }),
    ),
  ];

  it('counts children and the scanned hosts below every node', () => {
    const l = layoutTrace(scan(3))!;
    const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
    expect(byId['h:0']).toMatchObject({ kids: 2, below: 4, collapsed: false });
    expect(byId['r:10.0.1.254']).toMatchObject({ kids: 3, below: 3, collapsed: false });
    expect(byId['h:2']).toMatchObject({ kids: 0, below: 0, collapsed: false });
    expect(byId['root']).toMatchObject({ below: 5, collapsed: false });
  });

  it('folds a subtree into its node and closes up the rows', () => {
    const full = layoutTrace(scan(3))!;
    const folded = layoutTrace(scan(3), new Set(['r:10.0.1.254']))!;
    expect(full.nodes).toHaveLength(7);
    expect(folded.nodes.map((n) => n.id).sort()).toEqual(['h:0', 'h:1', 'r:10.0.1.254', 'root']);
    expect(folded.nodes.find((n) => n.id === 'r:10.0.1.254')).toMatchObject({
      collapsed: true,
      kids: 3,
      below: 3,
    });
    // no edge leads to a node that is not drawn
    const ids = new Set(folded.nodes.map((n) => n.id));
    for (const e of folded.edges) expect(ids.has(e.a) && ids.has(e.b)).toBe(true);
    const span = (l: typeof full) =>
      Math.max(...l.nodes.map((n) => n.y)) - Math.min(...l.nodes.map((n) => n.y));
    expect(span(folded)).toBeLessThan(span(full));
  });

  it('draws the same tree as before when nothing is collapsed, and never folds the root', () => {
    expect(layoutTrace(scan(3), new Set())).toEqual(layoutTrace(scan(3)));
    expect(layoutTrace(scan(3), new Set(['root']))).toEqual(layoutTrace(scan(3)));
    // a leaf in the set has nothing to fold
    const l = layoutTrace(scan(3), new Set(['h:2']))!;
    expect(l.nodes.find((n) => n.id === 'h:2')!.collapsed).toBe(false);
  });

  it('starts large fan-outs folded and can list every branch', () => {
    expect(traceFanouts(scan(TRACE_FANOUT_LIMIT))).toEqual(new Set());
    expect(traceFanouts(scan(TRACE_FANOUT_LIMIT + 1))).toEqual(new Set(['r:10.0.1.254']));
    expect(traceBranches(scan(3))).toEqual(new Set(['h:0', 'r:10.0.1.254']));
    expect(traceFanouts([mk('10.0.0.1')])).toEqual(new Set());
  });
});

describe('summarize', () => {
  it('counts hosts, ports, flags, subnets, buckets and top services', () => {
    const hosts = [
      mk('10.0.0.1', [], {
        ports: [
          { ...newScanPort(), port: 445, state: 'open', name: 'microsoft-ds' },
          { ...newScanPort(), port: 80, state: 'open', name: 'http' },
        ],
      }),
      mk('10.0.1.1', [], { ports: [{ ...newScanPort(), port: 80, state: 'open', name: 'http' }] }),
    ];
    const s = summarize(hosts);
    expect(s).toMatchObject({ hosts: 2, openPorts: 3, flagged: 1, subnets: 2 });
    expect(s.topServices).toEqual([
      ['http', 2],
      ['microsoft-ds', 1],
    ]);
  });
});
