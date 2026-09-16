/**
 * Streaming parser for `nmap -oX` output. Feeds chunks through saxes so a scan of a /16 with
 * service detection never has to exist as one string. Hosts are delivered one at a time as
 * soon as their closing tag is seen. Semantics match nmap2map.py's parse_xml.
 */
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { classify } from './classify.js';
import {
  NmapParseError,
  newScanHost,
  newScanPort,
  newScanRunMeta,
  sortPorts,
  type Hop,
  type ScanHost,
  type ScanPort,
  type ScanRunMeta,
  type ScriptOutput,
} from './types.js';

export interface ParseOptions {
  /** Keep only ports whose state starts with "open" (default true). */
  openOnly?: boolean;
  /** Ignore OS matches below this accuracy percentage (default 0). */
  minAccuracy?: number;
  /** Run classify() on each host (default true). */
  classify?: boolean;
  /** Emit hosts that are not "up" (default false). */
  includeDown?: boolean;
}

type ChunkSource = string | Iterable<string> | AsyncIterable<string>;

async function* chunksOf(src: ChunkSource): AsyncGenerator<string> {
  if (typeof src === 'string') {
    yield src;
    return;
  }
  for await (const c of src as AsyncIterable<string>) yield c;
}

interface OsCandidate {
  accuracy: number;
  name: string;
  cls: { family: string; vendor: string; type: string } | null;
}

/**
 * Parse an nmap XML document. `onHost` is awaited for every host, so a server-side consumer
 * can insert rows as they arrive. Resolves to the run metadata once the document ends.
 */
export async function parseNmapXml(
  input: ChunkSource,
  onHost: (host: ScanHost) => void | Promise<void>,
  opts: ParseOptions = {},
): Promise<ScanRunMeta> {
  const openOnly = opts.openOnly ?? true;
  const minAccuracy = opts.minAccuracy ?? 0;
  const doClassify = opts.classify ?? true;
  const includeDown = opts.includeDown ?? false;

  const meta = newScanRunMeta('xml');
  const parser = new SaxesParser({ xmlns: false, position: true });
  const stack: string[] = [];
  const pending: ScanHost[] = [];
  let sawRun = false;

  let host: ScanHost | null = null;
  let port: ScanPort | null = null;
  let osCands: OsCandidate[] = [];
  let osFallback: OsCandidate['cls'] = null;
  let text = '';

  const parent = (n = 1): string => stack[stack.length - 1 - n] ?? '';

  parser.on('opentag', (tag: SaxesTagPlain) => {
    const a = tag.attributes as Record<string, string>;
    const name = tag.name;
    stack.push(name);
    text = '';
    switch (name) {
      case 'nmaprun':
        sawRun = true;
        meta.args = a.args ?? '';
        meta.start = a.startstr ?? '';
        meta.version = a.version ?? '';
        break;
      case 'finished':
        meta.elapsed = a.elapsed ?? '';
        meta.end = a.timestr ?? '';
        break;
      case 'hosts':
        if (parent() === 'runstats') {
          meta.hostsUp = num(a.up);
          meta.hostsDown = num(a.down);
          meta.hostsTotal = num(a.total);
        }
        break;
      case 'host':
        host = newScanHost();
        port = null;
        osCands = [];
        osFallback = null;
        break;
      case 'status':
        if (host && parent() === 'host') {
          host.state = a.state ?? 'unknown';
          host.reason = a.reason ?? '';
        }
        break;
      case 'address':
        if (!host) break;
        if (a.addrtype === 'ipv4') host.ip = a.addr ?? '';
        else if (a.addrtype === 'ipv6') host.ipv6 = a.addr ?? '';
        else if (a.addrtype === 'mac') {
          host.mac = a.addr ?? '';
          host.vendor = a.vendor ?? '';
        }
        break;
      case 'hostname':
        if (host && a.name && !host.hostnames.includes(a.name)) host.hostnames.push(a.name);
        break;
      case 'times':
        if (host && a.srtt) {
          const srtt = Number(a.srtt);
          if (Number.isFinite(srtt)) host.latency = (srtt / 1000).toFixed(1) + ' ms';
        }
        break;
      case 'distance':
        if (host && a.value !== undefined) {
          const d = Number(a.value);
          if (Number.isInteger(d)) host.distance = d;
        }
        break;
      case 'uptime':
        if (host && a.lastboot) host.uptime = a.lastboot;
        break;
      case 'port':
        if (!host) break;
        port = newScanPort();
        port.port = Number(a.portid ?? 0) || 0;
        port.proto = a.protocol ?? 'tcp';
        break;
      case 'state':
        if (port && parent() === 'port') port.state = a.state ?? '';
        break;
      case 'service':
        if (port && parent() === 'port') {
          port.name = a.name ?? '';
          port.product = a.product ?? '';
          port.version = a.version ?? '';
          port.extra = a.extrainfo ?? '';
          port.tunnel = a.tunnel ?? '';
        }
        break;
      case 'script': {
        const s: ScriptOutput = { id: a.id ?? '', output: (a.output ?? '').trim() };
        if (port && parent() === 'port') port.scripts.push(s);
        else if (host && parent() === 'hostscript') host.scripts.push(s);
        break;
      }
      case 'osmatch':
        if (host)
          osCands.push({ accuracy: Number(a.accuracy ?? 0) || 0, name: a.name ?? '', cls: null });
        break;
      case 'osclass': {
        if (!host) break;
        const cls = { family: a.osfamily ?? '', vendor: a.vendor ?? '', type: a.type ?? '' };
        if (parent() === 'osmatch') {
          const cand = osCands[osCands.length - 1];
          if (cand && !cand.cls) cand.cls = cls;
        } else if (parent() === 'os' && !osFallback) {
          osFallback = cls;
        }
        break;
      }
      case 'hop':
        if (host && parent() === 'trace') {
          const hop: Hop = {
            ttl: Number(a.ttl ?? 0) || 0,
            ip: a.ipaddr ?? '',
            host: a.host ?? '',
            rtt: a.rtt ?? '',
          };
          host.trace.push(hop);
        }
        break;
    }
  });

  parser.on('text', (t: string) => {
    text += t;
  });

  parser.on('closetag', (tag: SaxesTagPlain) => {
    const name = tag.name;
    if (name === 'cpe' && port && parent() === 'service') {
      const v = text.trim();
      if (v) port.cpe.push(v);
    }
    stack.pop();
    text = '';
    if (name === 'port' && host && port) {
      if (!openOnly || port.state.startsWith('open')) host.ports.push(port);
      port = null;
    } else if (name === 'host' && host) {
      const h = finishHost(host, osCands, osFallback, minAccuracy);
      host = null;
      if (h && (includeDown || h.state === 'up')) pending.push(doClassify ? classify(h) : h);
    }
  });

  try {
    for await (const chunk of chunksOf(input)) {
      parser.write(chunk);
      while (pending.length) await onHost(pending.shift()!);
    }
    parser.close();
    while (pending.length) await onHost(pending.shift()!);
  } catch (err) {
    if (err instanceof NmapParseError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new NmapParseError(`Could not parse nmap XML: ${msg}`);
  }
  if (!sawRun) throw new NmapParseError('Not an nmap XML document (no <nmaprun> element)');
  return meta;
}

function finishHost(
  h: ScanHost,
  cands: OsCandidate[],
  fallback: OsCandidate['cls'],
  minAccuracy: number,
): ScanHost | null {
  if (!h.ip && h.ipv6) h.ip = h.ipv6;
  if (!h.ip) return null;
  h.ports = sortPorts(h.ports);
  h.trace.sort((a, b) => a.ttl - b.ttl);

  let best: OsCandidate | null = null;
  for (const c of cands) {
    if (c.accuracy < minAccuracy) continue;
    if (!best || c.accuracy > best.accuracy) best = c;
  }
  if (best) {
    h.osName = best.name;
    h.osAccuracy = String(best.accuracy);
    if (best.cls) {
      h.osFamily = best.cls.family;
      h.osVendor = best.cls.vendor;
      h.osType = best.cls.type;
    }
  }
  if (!h.osName && fallback) {
    h.osFamily = fallback.family;
    h.osVendor = fallback.vendor;
    h.osType = fallback.type;
    h.osName = `${fallback.vendor} ${fallback.family}`.trim();
  }
  return h;
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Convenience for small documents and tests. */
export async function parseNmapXmlAll(
  input: ChunkSource,
  opts?: ParseOptions,
): Promise<{ hosts: ScanHost[]; meta: ScanRunMeta }> {
  const hosts: ScanHost[] = [];
  const meta = await parseNmapXml(input, (h) => void hosts.push(h), opts);
  return { hosts, meta };
}
