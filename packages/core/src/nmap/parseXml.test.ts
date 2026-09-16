import { describe, expect, it } from 'vitest';
import { createReadStream, readFileSync } from 'node:fs';
import { parseNmapXml, parseNmapXmlAll } from './parseXml.js';
import { NmapParseError } from './types.js';
import { toLegacyShape } from './parity.js';
import { synthNmapXml } from './synth.js';
import { detectNmapFormat } from './detect.js';

const fixturePath = (name: string): URL => new URL(`../../fixtures/nmap/${name}`, import.meta.url);
const readFixture = (name: string): string => readFileSync(fixturePath(name), 'utf8');
const expected = (name: string): Array<Record<string, unknown>> => JSON.parse(readFixture(name));

/** nmap2map.py sorts IPv4 numerically and puts everything else after. */
const legacySort = (a: { ip: string }, b: { ip: string }): number => {
  const k = (ip: string): [number, string] =>
    /^\d+(\.\d+){3}$/.test(ip)
      ? [
          0,
          ip
            .split('.')
            .map((o) => o.padStart(3, '0'))
            .join('.'),
        ]
      : [1, ip];
  const [ka, kb] = [k(a.ip), k(b.ip)];
  return ka[0] - kb[0] || (ka[1] < kb[1] ? -1 : ka[1] > kb[1] ? 1 : 0);
};

describe('parseNmapXml parity with nmap2map.py', () => {
  it('matches the Python parser on the lab fixture', async () => {
    const { hosts, meta } = await parseNmapXmlAll(readFixture('lab-small.xml'));
    const ours = hosts.map(toLegacyShape).sort(legacySort);
    const theirs = expected('lab-small.expected.json').sort(legacySort as never);
    // Deliberate deviation: the Python classifier tags Cisco "IOS" as Apple (keyword "ios").
    for (const h of theirs) if (h.ip === '10.20.0.1') h.bucket = 'Network device';
    expect(ours).toEqual(theirs);
    expect(meta).toMatchObject({
      fmt: 'xml',
      args: 'nmap -sS -sV -O -sC --traceroute -T4 -oX lab-small.xml 10.20.0.0/16',
      start: 'Mon Jul 14 13:02:41 2026',
      version: '7.98',
      elapsed: '300.12',
      end: 'Mon Jul 14 13:07:41 2026',
      hostsUp: 6,
      hostsDown: 65530,
      hostsTotal: 65536,
    });
  });

  it('keeps per-port cpe and scripts that the Python version dropped', async () => {
    const { hosts } = await parseNmapXmlAll(readFixture('lab-small.xml'));
    const web = hosts.find((h) => h.ip === '10.20.4.31')!;
    expect(web.ports[0]?.cpe).toEqual([
      'cpe:/a:openbsd:openssh:9.2p1',
      'cpe:/o:linux:linux_kernel',
    ]);
    expect(web.ports[1]?.scripts).toEqual([{ id: 'http-title', output: 'Welcome to nginx!' }]);
    const dc = hosts.find((h) => h.ip === '10.20.1.5')!;
    expect(dc.scripts.map((s) => s.id)).toEqual(['smb-os-discovery', 'smb2-security-mode']);
    expect(dc.osName).toBe('Microsoft Windows Server 2022');
    expect(dc.osAccuracy).toBe('96');
    expect(dc.uptime).toBe('Mon Jun 30 06:06:34 2026');
    const v6 = hosts.find((h) => h.ip === '2001:db8:1::10')!;
    expect(v6.osName).toBe('FreeBSD FreeBSD');
    expect(v6.ipv6).toBe('2001:db8:1::10');
  });

  it('honours openOnly, minAccuracy, includeDown and classify options', async () => {
    const all = await parseNmapXmlAll(readFixture('lab-small.xml'), {
      openOnly: false,
      includeDown: true,
      classify: false,
      minAccuracy: 97,
    });
    expect(all.hosts).toHaveLength(7);
    const web = all.hosts.find((h) => h.ip === '10.20.4.31')!;
    expect(web.ports.map((p) => p.state)).toEqual(['open', 'open', 'open', 'closed']);
    expect(web.bucket).toBe('Unknown');
    expect(web.osName).toBe('');
    const gw = all.hosts.find((h) => h.ip === '10.20.0.1')!;
    expect(gw.osName).toBe('Cisco IOS 15.2');
  });

  it('streams chunk by chunk and delivers hosts incrementally', async () => {
    const text = readFixture('lab-small.xml');
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 700) chunks.push(text.slice(i, i + 700));
    const seen: string[] = [];
    const meta = await parseNmapXml(chunks, (h) => void seen.push(h.ip));
    expect(seen).toEqual([
      '10.20.1.5',
      '10.20.4.31',
      '10.20.9.100',
      '10.20.4.77',
      '2001:db8:1::10',
      '10.20.0.1',
    ]);
    expect(meta.hostsUp).toBe(6);
    // and from a Node stream, as the server does
    const fromStream = await parseNmapXmlAll(
      createReadStream(fixturePath('lab-small.xml'), { encoding: 'utf8', highWaterMark: 512 }),
    );
    expect(fromStream.hosts.map((h) => h.ip)).toEqual(seen);
  });

  it('rejects non-nmap and malformed XML', async () => {
    await expect(parseNmapXmlAll('<html><body>nope</body></html>')).rejects.toThrow(NmapParseError);
    await expect(
      parseNmapXmlAll('<?xml version="1.0"?><nmaprun><host><status state="up"/>'),
    ).rejects.toThrow(NmapParseError);
    await expect(parseNmapXmlAll('just text')).rejects.toThrow(NmapParseError);
  });

  it('parses a synthetic /16 with bounded memory', async () => {
    const before = process.memoryUsage().heapUsed;
    let n = 0;
    let ports = 0;
    const meta = await parseNmapXml(
      synthNmapXml({ hosts: 65536, portsPerHost: 6, seed: 7 }),
      (h) => {
        n++;
        ports += h.ports.length;
      },
    );
    const after = process.memoryUsage().heapUsed;
    expect(n).toBe(65536);
    expect(meta.hostsUp).toBe(65536);
    expect(ports).toBeGreaterThan(65536 * 3);
    // hosts are not retained by the parser; heap growth stays far below the document size
    expect(after - before).toBeLessThan(200 * 1024 * 1024);
  }, 60_000);
});

describe('detectNmapFormat', () => {
  it('sniffs xml, text and unknown', () => {
    expect(detectNmapFormat(readFileSync(fixturePath('lab-small.xml'), 'utf8').slice(0, 300))).toBe(
      'xml',
    );
    expect(
      detectNmapFormat(readFileSync(fixturePath('lab-small.nmap'), 'utf8').slice(0, 300)),
    ).toBe('text');
    expect(detectNmapFormat('﻿<?xml version="1.0"?>')).toBe('xml');
    expect(detectNmapFormat('Starting Nmap 7.98 ( https://nmap.org )')).toBe('text');
    expect(detectNmapFormat('{"hosts":[]}')).toBe('unknown');
  });
});
