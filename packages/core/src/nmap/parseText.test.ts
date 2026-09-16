import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNmapText } from './parseText.js';
import { toLegacyShape } from './parity.js';

const readFixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/nmap/${name}`, import.meta.url), 'utf8');

describe('parseNmapText parity with nmap2map.py', () => {
  it('matches the Python text parser on the lab fixture', () => {
    const { hosts, meta } = parseNmapText(readFixture('lab-small.nmap'));
    const ours = hosts.map(toLegacyShape);
    const theirs = (
      JSON.parse(readFixture('lab-small.text.expected.json')) as Array<Record<string, unknown>>
    )
      // Deliberate deviation: "Host is down." entries are skipped, as the XML parser skips down hosts.
      .filter((h) => h.ip !== '10.20.4.99');
    const byIp = (a: { ip: string }, b: { ip: string }): number => (a.ip < b.ip ? -1 : 1);
    expect(ours.sort(byIp)).toEqual(theirs.sort(byIp as never));
    expect(meta).toMatchObject({
      fmt: 'text',
      version: '7.98',
      start: 'Mon Jul 14 13:02:41 2026',
      args: 'nmap -sS -sV -O --traceroute -T4 -oN lab-small.nmap 10.20.0.0/16',
      end: 'Mon Jul 14 13:07:41 2026',
      hostsTotal: 65536,
      hostsUp: 5,
      elapsed: '300.12',
    });
  });

  it('can include down hosts and unfiltered ports', () => {
    const { hosts } = parseNmapText(readFixture('lab-small.nmap'), {
      includeDown: true,
      openOnly: false,
    });
    expect(hosts.find((h) => h.ip === '10.20.4.99')?.state).toBe('down');
    expect(hosts.find((h) => h.ip === '10.20.4.31')?.ports.map((p) => p.state)).toEqual([
      'open',
      'open',
      'open',
      'closed',
    ]);
  });

  it('rejects text that is not nmap output', () => {
    expect(() => parseNmapText('hello\nworld')).toThrow(/Not nmap/);
  });
});
