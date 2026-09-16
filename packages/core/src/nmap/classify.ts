/** Host classification, ported from nmap2map.py: OS bucket, role guess, notable exposures. */
import type { ScanHost } from './types.js';

export const OS_COLORS: ReadonlyArray<readonly [string, string]> = [
  ['Windows', '#5aa9ff'],
  ['Linux / Unix', '#f0a04b'],
  ['Apple', '#b98cff'],
  ['Network device', '#3fd0a8'],
  ['Printer', '#ff7fb2'],
  ['Hypervisor', '#63e0f0'],
  ['Embedded / IoT', '#e3cf4a'],
  ['Unknown', '#7b8797'],
];
export const OS_COLOR_MAP: Readonly<Record<string, string>> = Object.fromEntries(OS_COLORS);
export const OS_BUCKETS = OS_COLORS.map(([name]) => name);

/** Services worth flagging on a baseline: cleartext, legacy, or high-value remote access. */
export const NOTABLE_PORTS: Readonly<Record<number, string>> = {
  21: 'FTP (cleartext credentials)',
  23: 'Telnet (cleartext credentials)',
  69: 'TFTP (no authentication)',
  79: 'Finger (legacy)',
  111: 'rpcbind exposed',
  135: 'MSRPC exposed',
  139: 'NetBIOS / SMBv1 era',
  161: 'SNMP (check for public community)',
  389: 'LDAP (cleartext)',
  445: 'SMB exposed',
  512: 'rexec (legacy cleartext)',
  513: 'rlogin (legacy cleartext)',
  514: 'rsh (legacy cleartext)',
  1433: 'MSSQL exposed',
  1521: 'Oracle DB exposed',
  2049: 'NFS exposed',
  3306: 'MySQL exposed',
  3389: 'RDP exposed',
  5432: 'PostgreSQL exposed',
  5900: 'VNC exposed',
  5901: 'VNC exposed',
  6379: 'Redis (often unauthenticated)',
  11211: 'memcached (often unauthenticated)',
  27017: 'MongoDB (often unauthenticated)',
};

const has = (p: Set<number>, ...xs: number[]): boolean => xs.every((x) => p.has(x));
const any = (p: Set<number>, ...xs: number[]): boolean => xs.some((x) => p.has(x));

export const ROLE_RULES: ReadonlyArray<readonly [string, (p: Set<number>) => boolean]> = [
  ['Domain controller', (p) => has(p, 88, 389, 445) || has(p, 88, 464, 445)],
  ['Hypervisor', (p) => p.has(902) || p.has(5989)],
  ['Printer', (p) => any(p, 9100, 515, 631)],
  ['Database', (p) => any(p, 1433, 1521, 3306, 5432, 27017, 6379)],
  ['Mail server', (p) => any(p, 25, 110, 143, 465, 587, 993, 995)],
  ['DNS server', (p) => p.has(53)],
  ['Web server', (p) => any(p, 80, 443, 8080, 8443, 8000)],
  ['File / SMB', (p) => any(p, 445, 139, 2049)],
  ['Remote desktop', (p) => any(p, 3389, 5900)],
  ['SSH host', (p) => p.has(22)],
];

const WINDOWS = ['windows', 'microsoft'];
const APPLE = ['mac os', 'macos', 'os x', 'apple', 'ios', 'darwin'];
const HYPERVISOR = ['vmware', 'esxi', 'hyper-v', 'xen', 'proxmox', 'kvm'];
const PRINTER = ['printer', 'jetdirect', 'lexmark', 'ricoh', 'brother', 'xerox', 'canon'];
const NETDEV = [
  'cisco',
  'juniper',
  'mikrotik',
  'ubiquiti',
  'aruba',
  'fortinet',
  'palo alto',
  'netgear',
  'tp-link',
  'd-link',
  'arista',
  'router',
  'switch',
  'firewall',
  'ios-xe',
  'ios xe',
  'wap',
  'access point',
  'pfsense',
  'openwrt',
  'dd-wrt',
  'vyos',
  'sonicwall',
];
const LINUX = [
  'linux',
  'unix',
  'bsd',
  'solaris',
  'aix',
  'ubuntu',
  'debian',
  'centos',
  'red hat',
  'rhel',
  'fedora',
];
const EMBEDDED = [
  'embedded',
  'webcam',
  'camera',
  'phone',
  'voip',
  'media device',
  'game console',
  'storage-misc',
  'specialized',
];

const includesAny = (blob: string, keys: string[]): boolean => keys.some((k) => blob.includes(k));

/** Assign an OS bucket, a role guess, and any notable exposures. Returns a new host object. */
export function classify(input: ScanHost): ScanHost {
  const h: ScanHost = { ...input };
  const blob = [h.osName, h.osFamily, h.osVendor, h.osType, h.vendor].join(' ').toLowerCase();
  const svcBlob = h.ports
    .map((p) => p.name + ' ' + p.product)
    .join(' ')
    .toLowerCase();
  const ports = new Set(h.ports.filter((p) => p.proto === 'tcp').map((p) => p.port));

  // Network devices are tested before Apple: nmap2map.py checked Apple first, so a Cisco
  // "IOS" family matched the Apple keyword "ios". This is a deliberate deviation.
  let bucket = 'Unknown';
  if (includesAny(blob, WINDOWS)) bucket = 'Windows';
  else if (includesAny(blob, NETDEV)) bucket = 'Network device';
  else if (includesAny(blob, APPLE)) bucket = 'Apple';
  else if (includesAny(blob, HYPERVISOR)) bucket = 'Hypervisor';
  else if (includesAny(blob, PRINTER)) bucket = 'Printer';
  else if (includesAny(blob, LINUX)) bucket = 'Linux / Unix';
  else if (includesAny(blob, EMBEDDED)) bucket = 'Embedded / IoT';

  if (bucket === 'Unknown') {
    if (any(ports, 3389, 135, 139) && ports.has(445)) bucket = 'Windows';
    else if (svcBlob.includes('jetdirect') || any(ports, 9100, 515, 631)) bucket = 'Printer';
    else if (svcBlob.includes('openssh')) bucket = 'Linux / Unix';
  }

  let role = '';
  for (const [name, test] of ROLE_RULES) {
    if (test(ports)) {
      role = name;
      break;
    }
  }
  if (!role && h.distance === 1 && h.ip.endsWith('.1')) role = 'Likely gateway';

  const flags: string[] = [];
  for (const p of h.ports) {
    const note = NOTABLE_PORTS[p.port];
    if (note && p.proto === 'tcp') flags.push(`${p.port}/${p.proto} - ${note}`);
  }

  h.bucket = bucket;
  h.role = role;
  h.flags = flags;
  h.openCount = h.ports.length;
  return h;
}
