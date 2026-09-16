/**
 * Pure terrain helpers shared by the server's in-memory fallbacks, the standalone MemoryTerrain,
 * and the map view: subnet aggregation, case-status overlay by IP, filtering and keyset paging.
 */
import type { CaseState, Host } from '../domain/types.js';
import { hostIps, ipSortKey, netKey, compareIps } from '../ip/ip.js';
import type { ScanHost } from '../nmap/types.js';

export interface NetAggregate {
  netKey: string;
  hosts: number;
  openPorts: number;
  flagged: number;
  buckets: Record<string, number>;
}

export type TerrainHostLite = Pick<ScanHost, 'ip' | 'openCount' | 'flags' | 'bucket'>;

export function aggregateByNet(hosts: Iterable<TerrainHostLite>, bits = 24): NetAggregate[] {
  const m = new Map<string, NetAggregate>();
  for (const h of hosts) {
    const k = netKey(h.ip, bits);
    let a = m.get(k);
    if (!a) {
      a = { netKey: k, hosts: 0, openPorts: 0, flagged: 0, buckets: {} };
      m.set(k, a);
    }
    a.hosts++;
    a.openPorts += h.openCount;
    if (h.flags.length) a.flagged++;
    a.buckets[h.bucket] = (a.buckets[h.bucket] ?? 0) + 1;
  }
  return [...m.values()].sort((a, b) =>
    compareIps(a.netKey.split('/')[0] ?? a.netKey, b.netKey.split('/')[0] ?? b.netKey),
  );
}

/** ip → case host id (first match), from each host's ip field plus manual links. */
export function caseHostByIp(state: Pick<CaseState, 'hosts' | 'links'>): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of Object.values(state.hosts))
    for (const ip of hostIps(h.ip)) if (!m.has(ip)) m.set(ip, h.id);
  for (const l of Object.values(state.links))
    if (state.hosts[l.hostId] && !m.has(l.ip)) m.set(l.ip, l.hostId);
  return m;
}

/** Per-subnet tallies of linked case hosts by status, from case state alone. */
export function overlayByNet(
  state: Pick<CaseState, 'hosts' | 'links'>,
  bits = 24,
): Record<string, Record<Host['status'], number>> {
  const out: Record<string, Record<Host['status'], number>> = {};
  const seen = new Set<string>();
  for (const [ip, hostId] of caseHostByIp(state)) {
    const h = state.hosts[hostId];
    if (!h) continue;
    const key = `${netKey(ip, bits)}|${hostId}`;
    if (seen.has(key)) continue; // one host with two ips in the same subnet counts once
    seen.add(key);
    const k = netKey(ip, bits);
    const rec = (out[k] ??= {
      compromised: 0,
      suspect: 0,
      contained: 0,
      remediated: 0,
      clean: 0,
      unknown: 0,
    });
    rec[h.status]++;
  }
  return out;
}

export interface TerrainFilter {
  net?: string | undefined;
  port?: number | undefined;
  bucket?: string | undefined;
  q?: string | undefined;
  flagged?: boolean | undefined;
}

export function matchesTerrainFilter(h: ScanHost, f: TerrainFilter, bits = 24): boolean {
  if (f.net && netKey(h.ip, bits) !== f.net) return false;
  if (f.port !== undefined && !h.ports.some((p) => p.port === f.port)) return false;
  if (f.bucket && h.bucket !== f.bucket) return false;
  if (f.flagged && !h.flags.length) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [
      h.ip,
      h.ipv6,
      h.mac,
      h.vendor,
      h.osName,
      h.role,
      ...h.hostnames,
      ...h.ports.map((p) => `${p.port} ${p.name} ${p.product}`),
    ]
      .join(' ')
      .toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export interface TerrainPage<T> {
  items: T[];
  next: string | null;
}

/** Keyset page over hosts sorted by address. `after` is the sort key of the last row seen. */
export function pageTerrainHosts(
  sortedHosts: ScanHost[],
  after: string | null,
  limit: number,
): TerrainPage<ScanHost> {
  let start = 0;
  if (after) {
    start = sortedHosts.findIndex((h) => ipSortKey(h.ip) > after);
    if (start < 0) return { items: [], next: null };
  }
  const items = sortedHosts.slice(start, start + limit);
  const more = start + limit < sortedHosts.length;
  const last = items[items.length - 1];
  return { items, next: more && last ? ipSortKey(last.ip) : null };
}

export function sortTerrainHosts(hosts: ScanHost[]): ScanHost[] {
  return [...hosts].sort((a, b) => compareIps(a.ip, b.ip));
}

/** Compact host shape for tables and maps: ports without version detail, no hops or scripts. */
export interface TerrainHostSummary extends Omit<ScanHost, 'ports' | 'trace' | 'scripts'> {
  ports: Array<{ port: number; proto: string; name: string }>;
}

export function toTerrainSummary(h: ScanHost): TerrainHostSummary {
  const { ports, trace: _trace, scripts: _scripts, ...rest } = h;
  return { ...rest, ports: ports.map((p) => ({ port: p.port, proto: p.proto, name: p.name })) };
}

/** A host summary plus its traceroute hops, for the trace layout. */
export interface TerrainTraceHost extends TerrainHostSummary {
  trace: ScanHost['trace'];
}
