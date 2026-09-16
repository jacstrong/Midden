/**
 * Run every command the scan builder can produce through the real nmap binary to prove the
 * flags and target syntax parse. nmap is asked to do a list scan (-sL), which sends no packets.
 *
 * Removed before the check: the scan type (conflicts with -sL), the port selection (-p is only
 * legal with a port scan), and -O / --traceroute (both need root). What is still validated:
 * target and exclude syntax, -iL, discovery probes, -sV, -sC and --script, timing, rate and
 * retry limits, host timeouts, IPv6, and every output flag. Port specs and the root-only flags
 * are covered by the builder's unit tests instead.
 *
 *   node --no-warnings=ExperimentalWarning scripts/check-nmap-commands.ts
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  defaultPlan,
  presetFullTcp,
  presetHostDiscovery,
  presetQuick,
  presetServiceScan,
  presetTopUdp,
  renderArgv,
  type NmapPlan,
} from '@midden/core';

const run = promisify(execFile);
const dir = mkdtempSync(join(tmpdir(), 'midden-nmap-'));
const targetFile = join(dir, 'alive.txt');
writeFileSync(targetFile, '10.0.0.1\n10.0.0.2\n');
const excludeFile = join(dir, 'exclude.txt');
writeFileSync(excludeFile, '10.0.0.9\n');
const out = (name: string): string => join(dir, name);

const TARGETS = ['10.0.0.0/30', '10.0.1.1-5', '192.168.*.1', 'localhost'];

const plans: Array<[string, NmapPlan]> = [
  ['host-discovery', { ...presetHostDiscovery(TARGETS), outputBase: out('discovery') }],
  ['service-scan', { ...presetServiceScan(targetFile), outputBase: out('services') }],
  ['full-tcp', { ...presetFullTcp(TARGETS), outputBase: out('full') }],
  ['udp-top', { ...presetTopUdp(TARGETS), outputBase: out('udp') }],
  ['quick', { ...presetQuick(TARGETS), outputBase: out('quick') }],
  [
    'custom-everything',
    {
      ...defaultPlan(),
      targets: TARGETS,
      excludes: ['10.0.0.9'],
      excludeFile,
      discovery: 'tcp-syn',
      discoveryPorts: '22,443',
      scan: 'syn',
      topPorts: 200,
      serviceDetection: true,
      versionIntensity: 7,
      scripts: ['banner', 'http-title'],
      traceroute: true,
      timing: 3,
      noDns: true,
      reason: true,
      openOnly: true,
      minRate: 500,
      maxRetries: 2,
      hostTimeout: '5m',
      outputBase: out('custom'),
      outputFormats: ['all'],
    },
  ],
  [
    'ipv6',
    {
      ...defaultPlan(),
      targets: ['2001:db8::1'],
      ipv6: true,
      scan: 'connect',
      privileged: false,
      outputBase: out('v6'),
    },
  ],
];

/** Strip what a list scan cannot accept, keeping everything else nmap can still parse. */
function toListScan(argv: string[]): string[] {
  // Scan types conflict with -sL; -O and --traceroute need root, which this check does not have.
  const drop = new Set(['-sS', '-sT', '-sU', '-sA', '-sn', '-O', '--traceroute']);
  const args: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (drop.has(a)) continue;
    if (a === '-p') {
      i++;
      continue;
    }
    args.push(a);
  }
  // -n keeps the check offline: a list scan would otherwise do reverse DNS for every address.
  if (!args.includes('-n')) args.push('-n');
  return ['-sL', ...args];
}

async function main(): Promise<void> {
  try {
    const { stdout } = await run('nmap', ['--version']);
    console.log(stdout.split('\n')[0]);
  } catch {
    console.log('nmap is not installed — skipping command validation');
    return;
  }
  let failed = 0;
  for (const [name, plan] of plans) {
    const argv = renderArgv(plan);
    const check = toListScan(argv);
    try {
      await run('nmap', check, { timeout: 30_000 });
      console.log(`ok    ${name}: ${argv.join(' ')}`);
    } catch (err) {
      failed++;
      const e = err as { stdout?: string; stderr?: string; message: string };
      console.error(`FAIL  ${name}: ${argv.join(' ')}`);
      console.error(`      checked as: nmap ${check.join(' ')}`);
      console.error(
        `      ${(e.stdout || e.stderr || e.message).trim().split('\n').slice(-2).join(' | ')}`,
      );
    }
  }
  if (failed) {
    console.error(`${failed} generated command(s) were rejected by nmap`);
    process.exit(1);
  }
  console.log(`all ${plans.length} generated commands parse`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
