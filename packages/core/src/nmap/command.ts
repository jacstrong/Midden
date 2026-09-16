/**
 * nmap command builder. A declarative plan renders to argv (for validation and tests) and to a
 * shell-quoted command line (for copy/paste). Presets cover the hunt workflow:
 * host discovery of target subnets, then service/version scanning of the alive hosts.
 */
import type { ScanPhase } from '../domain/types.js';

export type Discovery = 'default' | 'ping-only' | 'skip' | 'arp' | 'icmp' | 'tcp-syn' | 'tcp-ack';
export type ScanType = 'syn' | 'connect' | 'udp' | 'syn+udp' | 'ack' | 'none';
export type Timing = 0 | 1 | 2 | 3 | 4 | 5;
export type OutputFormat = 'xml' | 'normal' | 'grepable' | 'all';

export interface NmapPlan {
  /** Target tokens in nmap syntax. */
  targets: string[];
  /** Path to a target file for -iL (used instead of, or in addition to, targets). */
  targetFile?: string | undefined;
  excludes?: string[] | undefined;
  excludeFile?: string | undefined;
  discovery: Discovery;
  /** Extra discovery probe ports for tcp-syn / tcp-ack discovery, e.g. "22,80,443". */
  discoveryPorts?: string | undefined;
  scan: ScanType;
  /** -p spec; ignored when topPorts is set. */
  ports?: string | undefined;
  topPorts?: number | undefined;
  serviceDetection: boolean;
  versionIntensity?: number | undefined;
  osDetection: boolean;
  /** true = -sC, string[] = --script list. */
  scripts?: boolean | string[] | undefined;
  traceroute: boolean;
  timing?: Timing | undefined;
  noDns: boolean;
  reason: boolean;
  openOnly: boolean;
  ipv6: boolean;
  minRate?: number | undefined;
  maxRetries?: number | undefined;
  hostTimeout?: string | undefined;
  /** Output basename without extension. */
  outputBase: string;
  outputFormats: OutputFormat[];
  /** Whether the command will run as root; determines whether -sS is allowed. */
  privileged: boolean;
  /** Raw extra flags appended verbatim. */
  extra?: string[] | undefined;
}

export interface PlanIssue {
  level: 'error' | 'warning';
  message: string;
}

export function defaultPlan(): NmapPlan {
  return {
    targets: [],
    discovery: 'default',
    scan: 'syn',
    serviceDetection: false,
    osDetection: false,
    traceroute: false,
    timing: 4,
    noDns: false,
    reason: false,
    openOnly: false,
    ipv6: false,
    outputBase: 'scan',
    outputFormats: ['xml'],
    privileged: true,
  };
}

/** Phase 1: which hosts are alive on the target subnets. */
export function presetHostDiscovery(targets: string[], outputBase = 'discovery'): NmapPlan {
  return {
    ...defaultPlan(),
    targets,
    discovery: 'ping-only',
    scan: 'none',
    noDns: true,
    outputBase,
    outputFormats: ['xml', 'normal'],
  };
}

/** Phase 2: service, version and OS detail on the hosts found alive. */
export function presetServiceScan(targetFile: string, outputBase = 'services'): NmapPlan {
  return {
    ...defaultPlan(),
    targets: [],
    targetFile,
    discovery: 'skip',
    scan: 'syn',
    serviceDetection: true,
    osDetection: true,
    traceroute: true,
    scripts: true,
    outputBase,
    outputFormats: ['xml', 'normal'],
  };
}

export function presetFullTcp(targets: string[], outputBase = 'full-tcp'): NmapPlan {
  return {
    ...defaultPlan(),
    targets,
    ports: '-',
    serviceDetection: true,
    outputBase,
    outputFormats: ['xml', 'normal'],
  };
}

export function presetTopUdp(targets: string[], outputBase = 'udp-top'): NmapPlan {
  return {
    ...defaultPlan(),
    targets,
    scan: 'udp',
    topPorts: 100,
    serviceDetection: true,
    outputBase,
    outputFormats: ['xml', 'normal'],
  };
}

export function presetQuick(targets: string[], outputBase = 'quick'): NmapPlan {
  return {
    ...defaultPlan(),
    targets,
    topPorts: 100,
    timing: 4,
    outputBase,
    outputFormats: ['xml'],
  };
}

export const PRESETS = {
  'host-discovery': presetHostDiscovery,
  'service-scan': presetServiceScan,
  'full-tcp': presetFullTcp,
  'udp-top': presetTopUdp,
  quick: presetQuick,
} as const;

export function validatePlan(p: NmapPlan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (!p.targets.length && !p.targetFile)
    issues.push({ level: 'error', message: 'No targets. Add subnets, hosts, or a target file.' });
  if (!p.outputBase.trim())
    issues.push({
      level: 'error',
      message: 'Output file basename is required so results can be uploaded.',
    });
  if (!p.outputFormats.length)
    issues.push({
      level: 'error',
      message: 'Choose at least one output format (XML is what Midden imports).',
    });
  if (!p.outputFormats.includes('xml') && !p.outputFormats.includes('all'))
    issues.push({
      level: 'warning',
      message: 'Without XML output Midden falls back to the best-effort text parser.',
    });
  if (!p.privileged && (p.scan === 'syn' || p.scan === 'syn+udp' || p.scan === 'ack'))
    issues.push({
      level: 'error',
      message: 'SYN/ACK scans need root. Run with sudo or switch to a connect scan (-sT).',
    });
  if (!p.privileged && (p.scan === 'udp' || p.osDetection || p.traceroute || p.discovery === 'arp'))
    issues.push({
      level: 'warning',
      message: 'UDP scans, OS detection, traceroute and ARP discovery need raw sockets (root).',
    });
  if (
    (p.scan === 'none' || p.discovery === 'ping-only') &&
    (p.serviceDetection || p.osDetection || p.ports || p.topPorts)
  )
    issues.push({
      level: 'warning',
      message: 'Ping-only scans do not probe ports; service/OS options will be ignored by nmap.',
    });
  if (p.ports && p.topPorts)
    issues.push({
      level: 'warning',
      message: 'Both a port list and --top-ports are set; --top-ports wins here.',
    });
  if (p.timing !== undefined && p.timing >= 5)
    issues.push({
      level: 'warning',
      message: 'T5 is aggressive enough to miss ports on slow links.',
    });
  return issues;
}

export function renderArgv(p: NmapPlan): string[] {
  const a: string[] = ['nmap'];
  if (p.ipv6) a.push('-6');
  switch (p.discovery) {
    case 'ping-only':
      a.push('-sn');
      break;
    case 'skip':
      a.push('-Pn');
      break;
    case 'arp':
      a.push('-PR');
      break;
    case 'icmp':
      a.push('-PE');
      break;
    case 'tcp-syn':
      a.push('-PS' + (p.discoveryPorts ?? ''));
      break;
    case 'tcp-ack':
      a.push('-PA' + (p.discoveryPorts ?? ''));
      break;
    case 'default':
      break;
  }
  if (p.scan !== 'none' && p.discovery !== 'ping-only') {
    switch (p.scan) {
      case 'syn':
        a.push('-sS');
        break;
      case 'connect':
        a.push('-sT');
        break;
      case 'udp':
        a.push('-sU');
        break;
      case 'syn+udp':
        a.push('-sS', '-sU');
        break;
      case 'ack':
        a.push('-sA');
        break;
    }
    if (p.topPorts) a.push('--top-ports', String(p.topPorts));
    else if (p.ports) a.push('-p', p.ports);
    if (p.serviceDetection) a.push('-sV');
    if (p.versionIntensity !== undefined) a.push('--version-intensity', String(p.versionIntensity));
    if (p.osDetection) a.push('-O');
    if (p.scripts === true) a.push('-sC');
    else if (Array.isArray(p.scripts) && p.scripts.length) a.push('--script', p.scripts.join(','));
    if (p.traceroute) a.push('--traceroute');
    if (p.openOnly) a.push('--open');
  }
  if (p.timing !== undefined) a.push(`-T${p.timing}`);
  if (p.noDns) a.push('-n');
  if (p.reason) a.push('--reason');
  if (p.minRate) a.push('--min-rate', String(p.minRate));
  if (p.maxRetries !== undefined) a.push('--max-retries', String(p.maxRetries));
  if (p.hostTimeout) a.push('--host-timeout', p.hostTimeout);
  if (p.excludes?.length) a.push('--exclude', p.excludes.join(','));
  if (p.excludeFile) a.push('--excludefile', p.excludeFile);
  const base = p.outputBase.trim() || 'scan';
  if (p.outputFormats.includes('all')) a.push('-oA', base);
  else {
    if (p.outputFormats.includes('xml')) a.push('-oX', `${base}.xml`);
    if (p.outputFormats.includes('normal')) a.push('-oN', `${base}.nmap`);
    if (p.outputFormats.includes('grepable')) a.push('-oG', `${base}.gnmap`);
  }
  if (p.extra?.length) a.push(...p.extra);
  if (p.targetFile) a.push('-iL', p.targetFile);
  a.push(...p.targets);
  return a;
}

/** POSIX shell quoting; leaves plain tokens bare so commands stay readable. */
export function shellQuote(tok: string): string {
  if (/^[A-Za-z0-9_./:,=+@%*-]+$/.test(tok)) return tok;
  return `'${tok.replace(/'/g, `'\\''`)}'`;
}

export function renderCommand(p: NmapPlan): string {
  const argv = renderArgv(p);
  const line = argv.map(shellQuote).join(' ');
  const needsRoot = p.privileged;
  return needsRoot ? `sudo ${line}` : line;
}

/** Guess a scan's phase from its recorded argument string. */
export function inferPhase(args: string): ScanPhase {
  const toks = args.trim().split(/\s+/);
  if (toks.includes('-sn') || toks.includes('-sP')) return 'discovery';
  if (
    toks.some((t) => /^-(sV|sC|O|A)$/.test(t) || t.startsWith('--script') || t === '--traceroute')
  )
    return 'service';
  return 'other';
}

/** The alive-host list to feed the next phase via -iL. */
export function targetsFile(ips: Iterable<string>): string {
  return [...new Set(ips)].join('\n') + '\n';
}
