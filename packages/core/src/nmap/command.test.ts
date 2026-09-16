import { describe, expect, it } from 'vitest';
import {
  defaultPlan,
  inferPhase,
  presetFullTcp,
  presetHostDiscovery,
  presetQuick,
  presetServiceScan,
  presetTopUdp,
  renderArgv,
  renderCommand,
  shellQuote,
  targetsFile,
  validatePlan,
} from './command.js';

describe('presets render the hunt workflow', () => {
  it('phase 1: host discovery', () => {
    const p = presetHostDiscovery(['10.20.0.0/16', '172.16.0.0/24']);
    expect(renderArgv(p)).toEqual([
      'nmap',
      '-sn',
      '-T4',
      '-n',
      '-oX',
      'discovery.xml',
      '-oN',
      'discovery.nmap',
      '10.20.0.0/16',
      '172.16.0.0/24',
    ]);
    expect(renderCommand(p)).toBe(
      'sudo nmap -sn -T4 -n -oX discovery.xml -oN discovery.nmap 10.20.0.0/16 172.16.0.0/24',
    );
    expect(validatePlan(p)).toEqual([]);
  });
  it('phase 2: service scan of alive hosts', () => {
    const p = presetServiceScan('alive.txt');
    expect(renderArgv(p)).toEqual([
      'nmap',
      '-Pn',
      '-sS',
      '-sV',
      '-O',
      '-sC',
      '--traceroute',
      '-T4',
      '-oX',
      'services.xml',
      '-oN',
      'services.nmap',
      '-iL',
      'alive.txt',
    ]);
    expect(validatePlan(p)).toEqual([]);
  });
  it('other presets', () => {
    expect(renderArgv(presetFullTcp(['10.0.0.1']))).toContain('-p');
    expect(renderArgv(presetFullTcp(['10.0.0.1']))).toContain('-');
    expect(renderArgv(presetTopUdp(['10.0.0.1']))).toEqual(
      expect.arrayContaining(['-sU', '--top-ports', '100']),
    );
    expect(renderArgv(presetQuick(['10.0.0.1']))).toEqual([
      'nmap',
      '-sS',
      '--top-ports',
      '100',
      '-T4',
      '-oX',
      'quick.xml',
      '10.0.0.1',
    ]);
  });
});

describe('option rendering', () => {
  it('covers discovery and scan types', () => {
    const base = {
      ...defaultPlan(),
      targets: ['10.0.0.1'],
      timing: undefined,
      outputFormats: ['all' as const],
    };
    expect(renderArgv({ ...base, discovery: 'skip', scan: 'connect' })).toEqual([
      'nmap',
      '-Pn',
      '-sT',
      '-oA',
      'scan',
      '10.0.0.1',
    ]);
    expect(
      renderArgv({ ...base, discovery: 'tcp-syn', discoveryPorts: '22,443', scan: 'syn+udp' }),
    ).toEqual(['nmap', '-PS22,443', '-sS', '-sU', '-oA', 'scan', '10.0.0.1']);
    expect(renderArgv({ ...base, discovery: 'arp', scan: 'ack', ipv6: true })).toEqual([
      'nmap',
      '-6',
      '-PR',
      '-sA',
      '-oA',
      'scan',
      '10.0.0.1',
    ]);
    expect(
      renderArgv({
        ...base,
        scripts: ['smb-os-discovery', 'http-title'],
        reason: true,
        openOnly: true,
        minRate: 500,
        maxRetries: 2,
        hostTimeout: '5m',
        // Both set on purpose: the file wins and --exclude is dropped, see "exclusions" below.
        excludes: ['10.0.0.9'],
        excludeFile: 'ex.txt',
        extra: ['--defeat-rst-ratelimit'],
      }),
    ).toEqual([
      'nmap',
      '-sS',
      '--script',
      'smb-os-discovery,http-title',
      '--open',
      '--reason',
      '--min-rate',
      '500',
      '--max-retries',
      '2',
      '--host-timeout',
      '5m',
      '--excludefile',
      'ex.txt',
      '-oA',
      'scan',
      '--defeat-rst-ratelimit',
      '10.0.0.1',
    ]);
    expect(
      renderArgv({
        ...base,
        versionIntensity: 9,
        serviceDetection: true,
        outputFormats: ['grepable'],
      }),
    ).toEqual(['nmap', '-sS', '-sV', '--version-intensity', '9', '-oG', 'scan.gnmap', '10.0.0.1']);
  });
  it('ping-only suppresses port options', () => {
    const p = {
      ...defaultPlan(),
      targets: ['10.0.0.0/24'],
      discovery: 'ping-only' as const,
      serviceDetection: true,
      ports: '80',
    };
    expect(renderArgv(p)).toEqual(['nmap', '-sn', '-T4', '-oX', 'scan.xml', '10.0.0.0/24']);
    expect(validatePlan(p).some((i) => i.level === 'warning')).toBe(true);
  });
  it('quotes shell-unsafe tokens and drops sudo when unprivileged', () => {
    expect(shellQuote('plain-token_1.2:3')).toBe('plain-token_1.2:3');
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('a b')).toBe(`'a b'`);
    const p = {
      ...defaultPlan(),
      targets: ['10.0.0.1'],
      scan: 'connect' as const,
      privileged: false,
      outputBase: 'my scan',
    };
    expect(renderCommand(p)).toBe(`nmap -sT -T4 -oX 'my scan.xml' 10.0.0.1`);
  });
});

describe('validation', () => {
  it('flags missing targets, root requirements, and output choices', () => {
    const none = validatePlan({ ...defaultPlan(), targets: [] });
    expect(none.map((i) => i.level)).toContain('error');
    const unpriv = validatePlan({ ...defaultPlan(), targets: ['x'], privileged: false });
    expect(unpriv.find((i) => i.level === 'error')?.message).toMatch(/SYN/);
    const noXml = validatePlan({ ...defaultPlan(), targets: ['x'], outputFormats: ['normal'] });
    expect(noXml.find((i) => i.level === 'warning')?.message).toMatch(/XML/);
    expect(
      validatePlan({ ...defaultPlan(), targets: ['x'], outputFormats: [] }).some(
        (i) => i.level === 'error',
      ),
    ).toBe(true);
  });
});

describe('helpers', () => {
  it('infers phase from args', () => {
    expect(inferPhase('nmap -sn -oX d.xml 10.0.0.0/24')).toBe('discovery');
    expect(inferPhase('nmap -sS -sV -O --traceroute -oX s.xml -iL alive.txt')).toBe('service');
    expect(inferPhase('nmap -A 10.0.0.1')).toBe('service');
    expect(inferPhase('nmap --script=vuln 10.0.0.1')).toBe('service');
    expect(inferPhase('nmap -sS -p 1-65535 10.0.0.1')).toBe('other');
  });
  it('writes a de-duplicated targets file', () => {
    expect(targetsFile(['10.0.0.1', '10.0.0.2', '10.0.0.1'])).toBe('10.0.0.1\n10.0.0.2\n');
  });
});

describe('exclusions', () => {
  // nmap 7.94, the build in Ubuntu 24.04, allocates until the OOM killer stops it when it is
  // handed --exclude and --excludefile together. Nothing Midden generates may contain both.
  const both = {
    ...defaultPlan(),
    targets: ['10.0.0.0/24'],
    excludes: ['10.0.0.9'],
    excludeFile: '/tmp/exclude.txt',
  };

  it('never emits both exclude flags', () => {
    const argv = renderArgv(both);
    expect(argv).toContain('--excludefile');
    expect(argv).not.toContain('--exclude');
  });

  it('reports the combination as an error', () => {
    const errors = validatePlan(both).filter((i) => i.level === 'error');
    expect(errors.map((i) => i.message).join(' ')).toMatch(/exclude file/i);
  });

  it('still emits each one on its own', () => {
    expect(renderArgv({ ...both, excludeFile: undefined })).toContain('--exclude');
    expect(renderArgv({ ...both, excludes: undefined })).toContain('--excludefile');
  });
});
