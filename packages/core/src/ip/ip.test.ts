import { describe, expect, it } from 'vitest';
import {
  compareIps,
  hostIps,
  intToIPv4,
  ipSortKey,
  ipToBytes16,
  ipv4ToInt,
  ipv6ToBytes,
  isIp,
  netKey,
  parseCidr,
  parseTargets,
  targetSize,
  bytesToIPv6,
} from './ip.js';

describe('ipv4', () => {
  it('parses and formats', () => {
    expect(ipv4ToInt('10.20.4.31')).toBe(0x0a14041f);
    expect(intToIPv4(0x0a14041f)).toBe('10.20.4.31');
    expect(ipv4ToInt('256.1.1.1')).toBeNull();
    expect(ipv4ToInt('1.2.3')).toBeNull();
    expect(ipv4ToInt('01.2.3.4')).toBeNull();
  });
});

describe('ipv6', () => {
  it('parses full, compressed and mapped forms', () => {
    expect(ipv6ToBytes('::1')?.[15]).toBe(1);
    expect(ipv6ToBytes('fe80::1%en0')).not.toBeNull();
    expect(ipv6ToBytes('2001:db8::ff00:42:8329')).not.toBeNull();
    expect(ipv6ToBytes('::ffff:10.0.0.1')?.slice(12)).toEqual(new Uint8Array([10, 0, 0, 1]));
    expect(ipv6ToBytes('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(ipv6ToBytes('1::2::3')).toBeNull();
    expect(ipv6ToBytes('10.0.0.1')).toBeNull();
  });
  it('round-trips through the compressed formatter', () => {
    for (const s of ['::1', '2001:db8::ff00:42:8329', 'fe80::', '::', '1:0:0:2:0:0:0:3']) {
      expect(bytesToIPv6(ipv6ToBytes(s)!)).toBe(s === '1:0:0:2:0:0:0:3' ? '1:0:0:2::3' : s);
    }
  });
});

describe('sorting', () => {
  it('orders v4 numerically and v4 before v6', () => {
    const ips = ['10.0.0.10', '10.0.0.9', '2001:db8::1', '10.0.0.100', '::1', '9.255.255.255'];
    expect([...ips].sort(compareIps)).toEqual([
      '::1',
      '9.255.255.255',
      '10.0.0.9',
      '10.0.0.10',
      '10.0.0.100',
      '2001:db8::1',
    ]);
    expect(ipSortKey('10.0.0.1')).toBe('00000000000000000000ffff0a000001');
    expect(ipToBytes16('nope')).toBeNull();
    expect(ipSortKey('nope') > ipSortKey('255.255.255.255')).toBe(true);
  });
});

describe('netKey', () => {
  it('groups by prefix', () => {
    expect(netKey('10.20.4.31')).toBe('10.20.4.0/24');
    expect(netKey('10.20.4.31', 16)).toBe('10.20.0.0/16');
    expect(netKey('10.20.4.31', 32)).toBe('10.20.4.31/32');
    expect(netKey('10.20.4.31', 0)).toBe('0.0.0.0/0');
    expect(netKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(netKey('garbage')).toBe('unknown');
  });
});

describe('hostIps', () => {
  it('extracts addresses from free text', () => {
    expect(hostIps('10.20.4.31')).toEqual(['10.20.4.31']);
    expect(hostIps('10.20.4.31, 10.20.4.32 (wifi) / fe80::1')).toEqual([
      '10.20.4.31',
      '10.20.4.32',
      'fe80::1',
    ]);
    expect(hostIps('no address recorded')).toEqual([]);
    expect(hostIps('10.20.4.31 and 10.20.4.31 again')).toEqual(['10.20.4.31']);
    expect(hostIps('999.1.1.1')).toEqual([]);
  });
});

describe('targets', () => {
  it('parses cidr', () => {
    expect(parseCidr('10.0.0.0/24')).toEqual({ base: '10.0.0.0', bits: 24, family: 4 });
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('2001:db8::/64')).toEqual({ base: '2001:db8::', bits: 64, family: 6 });
  });
  it('accepts nmap target syntax and rejects junk', () => {
    const r = parseTargets(
      '10.0.0.0/24, 10.0.1.1-50\n192.168.*.1 corp.example.com  bad_host! 300.1.1.1 # comment\n10.0.0.0/24',
    );
    expect(r.targets).toEqual(['10.0.0.0/24', '10.0.1.1-50', '192.168.*.1', 'corp.example.com']);
    expect(r.invalid).toEqual(['bad_host!', '300.1.1.1']);
  });
  it('sizes targets', () => {
    expect(targetSize('10.0.0.1')).toBe(1);
    expect(targetSize('10.0.0.0/24')).toBe(256);
    expect(targetSize('10.0.0.0/16')).toBe(65536);
    expect(targetSize('10.0.1.1-50')).toBe(50);
    expect(targetSize('192.168.*.1')).toBe(256);
    expect(targetSize('10.0.0.1,5,9')).toBe(3);
    expect(targetSize('corp.example.com')).toBeNull();
    expect(isIp('corp.example.com')).toBe(false);
  });
});
