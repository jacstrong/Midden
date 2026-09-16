/**
 * Terrain types: what an nmap scan says about a host. These mirror nmap2map.py's host record
 * (camelCased) plus per-port CPE and script output which the Python version dropped.
 */

export interface ScriptOutput {
  id: string;
  output: string;
}

export interface ScanPort {
  port: number;
  proto: string;
  state: string;
  name: string;
  product: string;
  version: string;
  extra: string;
  tunnel: string;
  cpe: string[];
  scripts: ScriptOutput[];
}

export interface Hop {
  ttl: number;
  ip: string;
  host: string;
  rtt: string;
}

export interface ScanHost {
  ip: string;
  ipv6: string;
  mac: string;
  vendor: string;
  hostnames: string[];
  state: string;
  reason: string;
  /** e.g. "12.3 ms" */
  latency: string;
  distance: number | null;
  ports: ScanPort[];
  osName: string;
  osAccuracy: string;
  osFamily: string;
  osVendor: string;
  osType: string;
  trace: Hop[];
  scripts: ScriptOutput[];
  uptime: string;
  /* filled by classify() */
  bucket: string;
  role: string;
  flags: string[];
  openCount: number;
}

export interface ScanRunMeta {
  fmt: 'xml' | 'text';
  args: string;
  start: string;
  version: string;
  elapsed: string;
  end: string;
  hostsUp: number | null;
  hostsDown: number | null;
  hostsTotal: number | null;
}

export function newScanHost(): ScanHost {
  return {
    ip: '',
    ipv6: '',
    mac: '',
    vendor: '',
    hostnames: [],
    state: 'up',
    reason: '',
    latency: '',
    distance: null,
    ports: [],
    osName: '',
    osAccuracy: '',
    osFamily: '',
    osVendor: '',
    osType: '',
    trace: [],
    scripts: [],
    uptime: '',
    bucket: 'Unknown',
    role: '',
    flags: [],
    openCount: 0,
  };
}

export function newScanRunMeta(fmt: 'xml' | 'text'): ScanRunMeta {
  return {
    fmt,
    args: '',
    start: '',
    version: '',
    elapsed: '',
    end: '',
    hostsUp: null,
    hostsDown: null,
    hostsTotal: null,
  };
}

export function newScanPort(): ScanPort {
  return {
    port: 0,
    proto: 'tcp',
    state: '',
    name: '',
    product: '',
    version: '',
    extra: '',
    tunnel: '',
    cpe: [],
    scripts: [],
  };
}

/** Sort ports the way nmap2map.py does: by protocol, then number. */
export function sortPorts(ports: ScanPort[]): ScanPort[] {
  return [...ports].sort((a, b) =>
    a.proto < b.proto ? -1 : a.proto > b.proto ? 1 : a.port - b.port,
  );
}

export class NmapParseError extends Error {
  override name = 'NmapParseError';
}
