/**
 * IP address utilities shared by terrain storage, the network map, host linking and the
 * scan builder. Pure functions, no DNS, no I/O.
 */

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIPv4(s: string): boolean {
  return V4.test(s);
}

/** Parse dotted-quad to a uint32, or null. */
export function ipv4ToInt(s: string): number | null {
  if (!V4.test(s)) return null;
  return s.split('.').reduce((acc, o) => acc * 256 + Number(o), 0);
}

export function intToIPv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Parse an IPv6 textual address into 16 bytes, or null. Handles `::`, embedded IPv4, zone ids stripped. */
export function ipv6ToBytes(input: string): Uint8Array | null {
  let s = input.trim();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s.includes(':')) return null;
  // Embedded IPv4 tail, e.g. ::ffff:10.0.0.1
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const hi = (v4 >>> 16).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    s = s.slice(0, lastColon + 1) + hi + ':' + lo;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  if (parts.length === 1 && head.length !== 8) return null;
  if (parts.length === 2 && head.length + rest.length > 7) return null;
  const groups: number[] = [];
  const push = (g: string): boolean => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return false;
    groups.push(parseInt(g, 16));
    return true;
  };
  for (const g of head) if (!push(g)) return null;
  if (parts.length === 2) for (let i = head.length + rest.length; i < 8; i++) groups.push(0);
  for (const g of rest) if (!push(g)) return null;
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    out[i * 2] = g >> 8;
    out[i * 2 + 1] = g & 255;
  });
  return out;
}

export function isIPv6(s: string): boolean {
  return ipv6ToBytes(s) !== null;
}

export function isIp(s: string): boolean {
  return isIPv4(s) || isIPv6(s);
}

/** 16-byte big-endian form; IPv4 is mapped to ::ffff:a.b.c.d so v4 and v6 sort together. */
export function ipToBytes16(s: string): Uint8Array | null {
  const v4 = ipv4ToInt(s);
  if (v4 !== null) {
    const out = new Uint8Array(16);
    out[10] = 0xff;
    out[11] = 0xff;
    out[12] = v4 >>> 24;
    out[13] = (v4 >>> 16) & 255;
    out[14] = (v4 >>> 8) & 255;
    out[15] = v4 & 255;
    return out;
  }
  return ipv6ToBytes(s);
}

/** Fixed-width hex key (32 chars) that sorts addresses numerically as strings. */
export function ipSortKey(s: string): string {
  const b = ipToBytes16(s);
  if (!b) return 'zz' + s; // unparsable addresses sort last, stably
  let out = '';
  for (const x of b) out += x.toString(16).padStart(2, '0');
  return out;
}

export function compareIps(a: string, b: string): number {
  const ka = ipSortKey(a);
  const kb = ipSortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function bytesToIPv6(b: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)).toString(16));
  // Compress the longest run of zero groups.
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > bestLen) {
      bestLen = j - i;
      bestStart = i;
    }
    i = j;
  }
  if (bestLen < 2) return groups.join(':');
  const left = groups.slice(0, bestStart).join(':');
  const right = groups.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}

/**
 * Network key for clustering, e.g. `10.20.4.0/24`. IPv6 addresses are grouped by /64
 * regardless of `bits` (mirrors the prototype). Unparsable input returns `unknown`.
 */
export function netKey(ip: string, bits = 24): string {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    const b = Math.min(32, Math.max(0, bits));
    const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
    return `${intToIPv4((v4 & mask) >>> 0)}/${b}`;
  }
  const v6 = ipv6ToBytes(ip);
  if (v6) {
    const net = new Uint8Array(16);
    net.set(v6.subarray(0, 8));
    return `${bytesToIPv6(net)}/64`;
  }
  return 'unknown';
}

const IP_IN_TEXT = /(?:\d{1,3}\.){3}\d{1,3}|(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?:%\w+)?/g;

/** Extract every valid address from free text such as a host's `ip` field. Order kept, deduplicated. */
export function hostIps(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IP_IN_TEXT)) {
    const cand = m[0];
    if (isIp(cand) && !out.includes(cand)) out.push(cand);
  }
  return out;
}

export interface CidrBlock {
  base: string;
  bits: number;
  family: 4 | 6;
}

export function parseCidr(s: string): CidrBlock | null {
  const m = /^(.+)\/(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const bits = Number(m[2]);
  const ip = m[1] ?? '';
  if (isIPv4(ip) && bits <= 32) return { base: ip, bits, family: 4 };
  if (isIPv6(ip) && bits <= 128) return { base: ip, bits, family: 6 };
  return null;
}

export interface TargetSpec {
  /** Cleaned target tokens in nmap syntax (IPs, CIDRs, octet ranges, hostnames). */
  targets: string[];
  /** Tokens that are not valid nmap targets. */
  invalid: string[];
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const OCTET_RANGE =
  /^(?:(?:\d{1,3}|\d{1,3}-\d{1,3}|\*|\d{1,3}(?:,\d{1,3})+)\.){3}(?:\d{1,3}|\d{1,3}-\d{1,3}|\*|\d{1,3}(?:,\d{1,3})+)$/;

function octetRangeValid(tok: string): boolean {
  return tok.split('.').every(
    (part) =>
      part === '*' ||
      part.split(',').every((p) => {
        const r = p.split('-');
        return (
          r.every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255) &&
          (r.length === 1 || Number(r[0]) <= Number(r[1]))
        );
      }),
  );
}

/** Parse a target list from free text: whitespace, comma or newline separated. */
export function parseTargets(text: string): TargetSpec {
  const targets: string[] = [];
  const invalid: string[] = [];
  const uncommented = text.replace(/#[^\n]*/g, '');
  const tokens = uncommented
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  for (const tok of tokens) {
    const numeric = /^[\d.*/-]+$/.test(tok);
    const ok =
      isIp(tok) ||
      parseCidr(tok) !== null ||
      (OCTET_RANGE.test(tok) && octetRangeValid(tok)) ||
      (!numeric && HOSTNAME.test(tok));
    if (ok) {
      if (!targets.includes(tok)) targets.push(tok);
    } else {
      invalid.push(tok);
    }
  }
  return { targets, invalid };
}

/** Number of addresses covered by a target token, or null when unknown (hostnames). */
export function targetSize(tok: string): number | null {
  if (isIPv4(tok)) return 1;
  const c = parseCidr(tok);
  if (c)
    return c.family === 4
      ? 2 ** (32 - c.bits)
      : c.bits >= 64
        ? 2 ** Math.min(64, 128 - c.bits)
        : Number.POSITIVE_INFINITY;
  if (OCTET_RANGE.test(tok) && octetRangeValid(tok)) {
    return tok.split('.').reduce((n, part) => {
      if (part === '*') return n * 256;
      return (
        n *
        part.split(',').reduce((m, p) => {
          const r = p.split('-').map(Number);
          return m + (r.length === 2 ? (r[1] ?? 0) - (r[0] ?? 0) + 1 : 1);
        }, 0)
      );
    }, 1);
  }
  if (isIPv6(tok)) return 1;
  return null;
}
