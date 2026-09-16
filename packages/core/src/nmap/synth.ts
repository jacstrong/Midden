/**
 * Synthetic nmap XML generator for tests and load runs. Streams chunks so a /16 with
 * service detection (hundreds of MB) never has to exist in memory.
 */
import { intToIPv4 } from '../ip/ip.js';

export interface SynthOptions {
  /** Base network as dotted quad, e.g. "10.0.0.0". */
  base?: string;
  hosts: number;
  /** Ports per host (open). */
  portsPerHost?: number;
  serviceDetection?: boolean;
  osDetection?: boolean;
  traceroute?: boolean;
  seed?: number;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

const SERVICES: Array<[number, string, string]> = [
  [22, 'ssh', 'OpenSSH'],
  [80, 'http', 'nginx'],
  [443, 'https', 'Apache httpd'],
  [445, 'microsoft-ds', ''],
  [3389, 'ms-wbt-server', 'Microsoft Terminal Services'],
  [135, 'msrpc', 'Microsoft Windows RPC'],
  [139, 'netbios-ssn', 'Microsoft Windows netbios-ssn'],
  [53, 'domain', 'ISC BIND'],
  [25, 'smtp', 'Postfix smtpd'],
  [3306, 'mysql', 'MySQL'],
  [5432, 'postgresql', 'PostgreSQL DB'],
  [8080, 'http-proxy', ''],
  [9100, 'jetdirect', ''],
  [21, 'ftp', 'vsftpd'],
  [23, 'telnet', ''],
  [88, 'kerberos-sec', 'Microsoft Windows Kerberos'],
  [389, 'ldap', 'Microsoft Windows Active Directory LDAP'],
];
const OSES: Array<[string, string, string]> = [
  ['Microsoft Windows 10', 'Windows', 'Microsoft'],
  ['Linux 5.4 - 5.15', 'Linux', 'Linux'],
  ['Apple macOS 14', 'macOS', 'Apple'],
  ['Cisco IOS 15', 'IOS', 'Cisco'],
  ['HP JetDirect', 'embedded', 'HP'],
];

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export function* synthNmapXml(opts: SynthOptions): Generator<string> {
  const base = (opts.base ?? '10.0.0.0').split('.').map(Number);
  const baseInt = ((base[0]! << 24) | (base[1]! << 16) | (base[2]! << 8) | base[3]!) >>> 0;
  const ppH = opts.portsPerHost ?? 8;
  const rand = rng(opts.seed ?? 1);
  yield `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE nmaprun>\n<nmaprun scanner="nmap" args="nmap -sS -sV -O -oX synth.xml ${intToIPv4(baseInt)}/16" start="1752498161" startstr="Mon Jul 14 13:02:41 2026" version="7.98" xmloutputversion="1.05">\n`;
  yield `<scaninfo type="syn" protocol="tcp" numservices="1000" services="1-1000"/>\n<verbose level="0"/><debugging level="0"/>\n`;
  let buf = '';
  for (let i = 0; i < opts.hosts; i++) {
    const ip = intToIPv4((baseInt + 1 + i) >>> 0);
    const os = OSES[Math.floor(rand() * OSES.length)]!;
    buf += `<host starttime="1752498161" endtime="1752498200"><status state="up" reason="syn-ack" reason_ttl="64"/>\n`;
    buf += `<address addr="${ip}" addrtype="ipv4"/>\n`;
    if (rand() < 0.5)
      buf += `<address addr="00:50:56:${hex(rand)}:${hex(rand)}:${hex(rand)}" addrtype="mac" vendor="VMware"/>\n`;
    buf += `<hostnames><hostname name="host-${i}.lab.example" type="PTR"/></hostnames>\n<ports>`;
    const chosen = new Set<number>();
    for (let p = 0; p < ppH; p++) chosen.add(Math.floor(rand() * SERVICES.length));
    for (const idx of [...chosen].sort((a, b) => SERVICES[a]![0] - SERVICES[b]![0])) {
      const [port, name, product] = SERVICES[idx]!;
      buf += `<port protocol="tcp" portid="${port}"><state state="open" reason="syn-ack" reason_ttl="64"/>`;
      buf +=
        opts.serviceDetection === false
          ? `<service name="${name}" method="table" conf="3"/>`
          : `<service name="${name}"${product ? ` product="${esc(product)}"` : ''} version="${(rand() * 9).toFixed(1)}" method="probed" conf="10"><cpe>cpe:/a:${name}:${name}</cpe></service>`;
      buf += `</port>\n`;
    }
    buf += `</ports>\n`;
    if (opts.osDetection !== false) {
      buf += `<os><osmatch name="${esc(os[0])}" accuracy="${90 + Math.floor(rand() * 10)}" line="1"><osclass type="general purpose" vendor="${esc(os[2])}" osfamily="${esc(os[1])}" accuracy="95"/></osmatch></os>\n`;
    }
    buf += `<distance value="${1 + (i % 3)}"/><times srtt="${Math.floor(rand() * 20000)}" rttvar="1000" to="100000"/>\n`;
    if (opts.traceroute) {
      buf += `<trace port="443" proto="tcp"><hop ttl="1" ipaddr="${intToIPv4((baseInt + 1) >>> 0)}" rtt="0.5"/><hop ttl="2" ipaddr="${ip}" rtt="1.2"/></trace>\n`;
    }
    buf += `</host>\n`;
    if (buf.length > 65536) {
      yield buf;
      buf = '';
    }
  }
  if (buf) yield buf;
  yield `<runstats><finished time="1752498461" timestr="Mon Jul 14 13:07:41 2026" elapsed="300.00" summary="Nmap done" exit="success"/><hosts up="${opts.hosts}" down="0" total="${opts.hosts}"/></runstats>\n</nmaprun>\n`;
}

function hex(rand: () => number): string {
  return Math.floor(rand() * 256)
    .toString(16)
    .padStart(2, '0');
}

export function synthNmapXmlString(opts: SynthOptions): string {
  let out = '';
  for (const c of synthNmapXml(opts)) out += c;
  return out;
}
