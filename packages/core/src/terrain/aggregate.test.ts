import { describe, expect, it } from 'vitest';
import {
  aggregateByNet,
  caseHostByIp,
  matchesTerrainFilter,
  overlayByNet,
  pageTerrainHosts,
  sortTerrainHosts,
} from './aggregate.js';
import { demoCaseState } from '../demo/demoCase.js';
import { newScanHost, newScanPort, type ScanHost } from '../nmap/types.js';
import { classify } from '../nmap/classify.js';
import { apply } from '../ops/reducer.js';

const mk = (ip: string, ports: number[] = [], extra: Partial<ScanHost> = {}): ScanHost =>
  classify({
    ...newScanHost(),
    ip,
    ports: ports.map((p) => ({ ...newScanPort(), port: p, state: 'open', name: `svc${p}` })),
    ...extra,
  });

describe('aggregateByNet', () => {
  it('tallies hosts, ports, flags and buckets per subnet in address order', () => {
    const agg = aggregateByNet([
      mk('10.20.4.31', [22, 80]),
      mk('10.20.4.77', [445, 3389]),
      mk('10.20.1.5', [88, 389, 445]),
      mk('10.20.4.99'),
    ]);
    expect(agg.map((a) => a.netKey)).toEqual(['10.20.1.0/24', '10.20.4.0/24']);
    expect(agg[1]).toEqual({
      netKey: '10.20.4.0/24',
      hosts: 3,
      openPorts: 4,
      flagged: 1,
      buckets: { Unknown: 2, Windows: 1 },
    });
    expect(aggregateByNet([mk('10.20.4.31'), mk('10.21.0.1')], 16).map((a) => a.netKey)).toEqual([
      '10.20.0.0/16',
      '10.21.0.0/16',
    ]);
  });
});

describe('overlay from case state', () => {
  it('maps ips to case hosts and tallies statuses per subnet', () => {
    let s = demoCaseState();
    s = apply(s, { type: 'link.set', hostId: 'h_vpn', ip: '10.20.9.99' });
    const byIp = caseHostByIp(s);
    expect(byIp.get('10.20.4.31')).toBe('h_wks');
    expect(byIp.get('10.20.9.99')).toBe('h_vpn');
    const ov = overlayByNet(s);
    expect(ov['10.20.9.0/24']).toMatchObject({ compromised: 2, clean: 1 });
    expect(ov['172.16.0.0/24']).toMatchObject({ clean: 1 });
    expect(ov['10.20.4.0/24']).toMatchObject({ compromised: 1 });
  });
});

describe('filter and page', () => {
  const hosts = sortTerrainHosts([
    mk('10.0.0.10', [80]),
    mk('10.0.0.2', [22, 445]),
    mk('10.0.1.1', [23]),
    mk('10.0.0.1'),
  ]);
  it('sorts numerically and pages by keyset', () => {
    expect(hosts.map((h) => h.ip)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.10', '10.0.1.1']);
    const p1 = pageTerrainHosts(hosts, null, 2);
    expect(p1.items.map((h) => h.ip)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(p1.next).not.toBeNull();
    const p2 = pageTerrainHosts(hosts, p1.next, 2);
    expect(p2.items.map((h) => h.ip)).toEqual(['10.0.0.10', '10.0.1.1']);
    expect(p2.next).toBeNull();
    expect(pageTerrainHosts(hosts, p2.next ?? 'ffff', 2).items).toEqual([]);
  });
  it('filters by net, port, bucket, flags and text', () => {
    expect(hosts.filter((h) => matchesTerrainFilter(h, { net: '10.0.0.0/24' })).length).toBe(3);
    expect(hosts.filter((h) => matchesTerrainFilter(h, { port: 445 })).map((h) => h.ip)).toEqual([
      '10.0.0.2',
    ]);
    expect(
      hosts.filter((h) => matchesTerrainFilter(h, { flagged: true })).map((h) => h.ip),
    ).toEqual(['10.0.0.2', '10.0.1.1']);
    expect(hosts.filter((h) => matchesTerrainFilter(h, { q: 'svc80' })).map((h) => h.ip)).toEqual([
      '10.0.0.10',
    ]);
    expect(hosts.filter((h) => matchesTerrainFilter(h, { bucket: 'Unknown' })).length).toBe(4);
  });
});
