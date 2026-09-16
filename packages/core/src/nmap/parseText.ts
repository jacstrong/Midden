/** Best-effort parser for `nmap -oN` normal output, ported from nmap2map.py. */
import { classify } from './classify.js';
import {
  newScanHost,
  newScanPort,
  newScanRunMeta,
  sortPorts,
  type ScanHost,
  type ScanRunMeta,
} from './types.js';
import type { ParseOptions } from './parseXml.js';

const RE_REPORT = /^Nmap scan report for (?:(\S+) \(([\d.:a-fA-F]+)\)|([\d.:a-fA-F]+))\s*$/;
const RE_PORT = /^(\d+)\/(tcp|udp|sctp)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/;
const RE_MAC = /^MAC Address:\s+([0-9A-Fa-f:]{17})\s*(?:\((.*)\))?/;
const RE_OSDET = /^(?:OS details|Aggressive OS guesses|Running):\s*(.+)$/;
const RE_LAT = /^Host is up.*?\(([\d.]+)s latency\)/;
const RE_DIST = /^Network Distance:\s+(\d+) hop/;
const RE_HOP = /^(\d+)\s+([\d.]+ ms|\.\.\.)\s+(\S+)(?:\s+\(([\d.]+)\))?/;
const RE_INIT = /^# Nmap (\S+) scan initiated (.+?) as: (.+)$/;
const RE_DONE =
  /^# Nmap done at (.+?) -- (\d+) IP address(?:es)? \((\d+) hosts? up\) scanned in ([\d.]+) seconds/;

export function parseNmapText(
  text: string,
  opts: ParseOptions = {},
): { hosts: ScanHost[]; meta: ScanRunMeta } {
  const openOnly = opts.openOnly ?? true;
  const doClassify = opts.classify ?? true;
  const includeDown = opts.includeDown ?? false;
  const meta = newScanRunMeta('text');
  const hosts: ScanHost[] = [];
  let cur: ScanHost | null = null;
  let inTrace = false;
  let sawAnything = false;

  const flush = (): void => {
    if (!cur) return;
    cur.ports = sortPorts(cur.ports);
    if (includeDown || cur.state === 'up') hosts.push(doClassify ? classify(cur) : cur);
    cur = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m = RE_INIT.exec(line);
    if (m) {
      sawAnything = true;
      meta.version = m[1] ?? '';
      meta.start = m[2] ?? '';
      meta.args = m[3] ?? '';
      continue;
    }
    m = RE_DONE.exec(line);
    if (m) {
      sawAnything = true;
      meta.end = m[1] ?? '';
      meta.hostsTotal = Number(m[2]);
      meta.hostsUp = Number(m[3]);
      meta.hostsDown = meta.hostsTotal - meta.hostsUp;
      meta.elapsed = m[4] ?? '';
      continue;
    }
    if (/^Starting Nmap /.test(line)) sawAnything = true;

    m = RE_REPORT.exec(line);
    if (m) {
      sawAnything = true;
      flush();
      cur = newScanHost();
      inTrace = false;
      if (m[3]) cur.ip = m[3];
      else {
        cur.hostnames = [m[1] ?? ''];
        cur.ip = m[2] ?? '';
      }
      continue;
    }
    if (!cur) continue;

    if (/^Host is down/.test(line)) {
      cur.state = 'down';
      continue;
    }
    if (line.startsWith('TRACEROUTE')) {
      inTrace = true;
      continue;
    }
    if (inTrace) {
      const hm = RE_HOP.exec(line.trim());
      if (hm) {
        cur.trace.push({
          ttl: Number(hm[1]),
          ip: hm[4] ?? hm[3] ?? '',
          host: hm[4] ? (hm[3] ?? '') : '',
          rtt: hm[2] ?? '',
        });
        continue;
      }
      if (!line.trim()) inTrace = false;
    }
    m = RE_LAT.exec(line);
    if (m) {
      cur.latency = (Number(m[1]) * 1000).toFixed(1) + ' ms';
      continue;
    }
    m = RE_MAC.exec(line);
    if (m) {
      cur.mac = m[1] ?? '';
      cur.vendor = m[2] ?? '';
      continue;
    }
    m = RE_DIST.exec(line);
    if (m) {
      cur.distance = Number(m[1]);
      continue;
    }
    m = RE_OSDET.exec(line);
    if (m && !cur.osName) {
      cur.osName = (m[1] ?? '').split(',')[0]?.trim() ?? '';
      continue;
    }
    m = RE_PORT.exec(line);
    if (m) {
      const state = m[3] ?? '';
      if (openOnly && !state.startsWith('open')) continue;
      const p = newScanPort();
      p.port = Number(m[1]);
      p.proto = m[2] ?? 'tcp';
      p.state = state;
      p.name = m[4] ?? '';
      p.product = (m[5] ?? '').trim();
      cur.ports.push(p);
      continue;
    }
  }
  flush();
  if (!sawAnything) throw new Error('Not nmap normal output (no "Nmap scan report" lines)');
  return { hosts, meta };
}
