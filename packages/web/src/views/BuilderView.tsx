import { useMemo, useState } from 'react';
import {
  defaultPlan,
  parseTargets,
  presetFullTcp,
  presetHostDiscovery,
  presetQuick,
  presetServiceScan,
  presetTopUdp,
  renderCommand,
  targetSize,
  validatePlan,
  type Discovery,
  type NmapPlan,
  type OutputFormat,
  type ScanType,
  type Timing,
} from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { useTerrain } from '../store/useTerrain';
import { downloadTargets } from '../lib/terrainActions';
import { copyText } from '../lib/clipboard';
import { toast } from '../store/useToasts';
import { Field, Fieldset } from '../components/fields';

type PresetId = 'host-discovery' | 'service-scan' | 'full-tcp' | 'udp-top' | 'quick' | 'custom';

const TARGETS_FILE = 'alive.txt';

export function BuilderView() {
  const scans = Object.values(useCaseStore((s) => s.state.scans)).filter(
    (s) => s.status === 'ready',
  );
  const setView = useUiStore((s) => s.setView);
  const setScanId = useUiStore((s) => s.setScanId);
  const terrainVersion = useTerrain((s) => s.version);

  const discoveryScans = scans.filter((s) => s.phase === 'discovery' || s.args.includes('-sn'));
  const [preset, setPreset] = useState<PresetId>('host-discovery');
  const [targetText, setTargetText] = useState('10.0.0.0/24');
  const [excludeText, setExcludeText] = useState('');
  const [sourceScanId, setSourceScanId] = useState<string>('');
  const [plan, setPlan] = useState<NmapPlan>(() => presetHostDiscovery([]));

  const parsed = useMemo(() => parseTargets(targetText), [targetText]);
  const excluded = useMemo(() => parseTargets(excludeText), [excludeText]);
  const addresses = useMemo(
    () =>
      parsed.targets.reduce<number | null>((sum, t) => {
        const n = targetSize(t);
        return sum === null || n === null ? null : sum + n;
      }, 0),
    [parsed.targets],
  );

  const sourceScan = scans.find((s) => s.id === sourceScanId) ?? discoveryScans[0] ?? null;
  const usingTargetFile = preset === 'service-scan';

  /** The plan actually rendered: presets set the flags, the targets boxes drive the rest. */
  const effective: NmapPlan = {
    ...plan,
    targets: usingTargetFile ? [] : parsed.targets,
    targetFile: usingTargetFile ? TARGETS_FILE : undefined,
    excludes: excluded.targets.length ? excluded.targets : undefined,
  };
  const command = renderCommand(effective);
  const issues = validatePlan(effective);

  const applyPreset = (id: PresetId): void => {
    setPreset(id);
    const t = parsed.targets;
    switch (id) {
      case 'host-discovery':
        setPlan(presetHostDiscovery(t));
        break;
      case 'service-scan':
        setPlan(presetServiceScan(TARGETS_FILE));
        break;
      case 'full-tcp':
        setPlan(presetFullTcp(t));
        break;
      case 'udp-top':
        setPlan(presetTopUdp(t));
        break;
      case 'quick':
        setPlan(presetQuick(t));
        break;
      case 'custom':
        setPlan({ ...defaultPlan(), targets: t });
        break;
    }
  };

  const set = <K extends keyof NmapPlan>(k: K, v: NmapPlan[K]): void => {
    setPlan((p) => ({ ...p, [k]: v }));
    setPreset('custom');
  };

  return (
    <>
      <div className="toolbar">
        <div className="seg">
          {(
            [
              ['host-discovery', '1 · Find live hosts'],
              ['service-scan', '2 · Scan those hosts'],
            ] as Array<[PresetId, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              className={preset === id ? 'on' : ''}
              onClick={() => applyPreset(id)}
              data-testid={`phase-${id}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="seg">
          {(
            [
              ['full-tcp', 'All TCP ports'],
              ['udp-top', 'Top UDP'],
              ['quick', 'Quick'],
              ['custom', 'Custom'],
            ] as Array<[PresetId, string]>
          ).map(([id, label]) => (
            <button key={id} className={preset === id ? 'on' : ''} onClick={() => applyPreset(id)}>
              {label}
            </button>
          ))}
        </div>
        <span className="sp" />
        <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: '.14em' }}>
          {usingTargetFile
            ? 'TARGETS FROM A PREVIOUS SCAN'
            : addresses === null
              ? `${parsed.targets.length} TARGETS`
              : `${addresses.toLocaleString()} ADDRESSES`}
        </span>
      </div>

      <div className="grid2">
        <div>
          <Fieldset legend={usingTargetFile ? 'Targets from phase 1' : 'Targets'} cols={2}>
            {usingTargetFile ? (
              <div className="field span2">
                <label htmlFor="bSource">Live hosts found by</label>
                {discoveryScans.length ? (
                  <>
                    <select
                      id="bSource"
                      value={sourceScan?.id ?? ''}
                      onChange={(e) => setSourceScanId(e.target.value)}
                      data-testid="builder-source-scan"
                    >
                      {discoveryScans.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {s.hostsUp} up
                        </option>
                      ))}
                    </select>
                    <div className="hint">
                      Download the list, keep it next to the command, and nmap reads it with{' '}
                      <code>-iL {TARGETS_FILE}</code>.
                    </div>
                    <button
                      className="btn"
                      style={{ marginTop: 8 }}
                      onClick={() =>
                        sourceScan &&
                        void downloadTargets(sourceScan.id, TARGETS_FILE.replace('.txt', ''))
                      }
                      data-testid="builder-download-targets"
                      key={terrainVersion}
                    >
                      Download {TARGETS_FILE} ({sourceScan?.hostsUp ?? 0} hosts)
                    </button>
                  </>
                ) : (
                  <div className="hint" data-testid="builder-no-discovery">
                    No discovery scan uploaded yet. Run phase 1, upload the result on the Scans tab,
                    then come back here.
                    <br />
                    <button
                      className="btn sm"
                      style={{ marginTop: 8 }}
                      onClick={() => setView('scans')}
                    >
                      Go to scans
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="field span2">
                  <label htmlFor="bTargets">Subnets, ranges or hosts</label>
                  <textarea
                    id="bTargets"
                    value={targetText}
                    onChange={(e) => setTargetText(e.target.value)}
                    placeholder={'10.20.0.0/16\n192.168.1.1-50\ncorp.example.com'}
                    style={{ minHeight: 84 }}
                    data-testid="builder-targets"
                  />
                  <div className="hint">
                    One per line, or comma separated. CIDR, octet ranges and hostnames all work.
                  </div>
                  {parsed.invalid.length > 0 && (
                    <div className="err">Not valid nmap targets: {parsed.invalid.join(', ')}</div>
                  )}
                </div>
                <div className="field span2">
                  <label htmlFor="bExclude">Exclude</label>
                  <input
                    id="bExclude"
                    type="text"
                    value={excludeText}
                    onChange={(e) => setExcludeText(e.target.value)}
                    placeholder="10.20.4.1, 10.20.9.0/24"
                  />
                  <div className="hint">
                    Addresses you must not touch: gateways, safety-of-life systems, out-of-scope
                    ranges.
                  </div>
                </div>
              </>
            )}
          </Fieldset>

          <Fieldset legend="Output" cols={2}>
            <Field label="File name (no extension)" htmlFor="bOut">
              <input
                id="bOut"
                type="text"
                value={plan.outputBase}
                onChange={(e) => set('outputBase', e.target.value)}
              />
            </Field>
            <Field
              label="Formats"
              htmlFor="bFmt"
              hint="Midden imports XML; normal output is handy to read on the box."
            >
              <select
                id="bFmt"
                value={plan.outputFormats.join(',')}
                onChange={(e) => set('outputFormats', e.target.value.split(',') as OutputFormat[])}
              >
                <option value="xml">XML only</option>
                <option value="xml,normal">XML + normal</option>
                <option value="all">All formats (-oA)</option>
              </select>
            </Field>
          </Fieldset>
        </div>

        <div>
          <Fieldset legend="How to scan" cols={2}>
            <Field label="Host discovery" htmlFor="bDisc">
              <select
                id="bDisc"
                value={plan.discovery}
                onChange={(e) => set('discovery', e.target.value as Discovery)}
              >
                <option value="default">Default probes</option>
                <option value="ping-only">Ping only, no ports (-sn)</option>
                <option value="skip">Skip discovery, treat all as up (-Pn)</option>
                <option value="arp">ARP (-PR, same subnet)</option>
                <option value="icmp">ICMP echo (-PE)</option>
                <option value="tcp-syn">TCP SYN probes (-PS)</option>
                <option value="tcp-ack">TCP ACK probes (-PA)</option>
              </select>
            </Field>
            <Field label="Port scan" htmlFor="bScan">
              <select
                id="bScan"
                value={plan.scan}
                onChange={(e) => set('scan', e.target.value as ScanType)}
              >
                <option value="syn">SYN (-sS, needs root)</option>
                <option value="connect">Connect (-sT)</option>
                <option value="udp">UDP (-sU)</option>
                <option value="syn+udp">SYN + UDP</option>
                <option value="ack">ACK (-sA)</option>
                <option value="none">No port scan</option>
              </select>
            </Field>
            <Field label="Ports" htmlFor="bPorts" hint="e.g. 22,80,443 · 1-1024 · - for all 65535">
              <input
                id="bPorts"
                type="text"
                value={plan.ports ?? ''}
                onChange={(e) => set('ports', e.target.value || undefined)}
              />
            </Field>
            <Field label="or top N ports" htmlFor="bTop">
              <input
                id="bTop"
                type="number"
                min={1}
                max={65535}
                value={plan.topPorts ?? ''}
                onChange={(e) =>
                  set('topPorts', e.target.value ? Number(e.target.value) : undefined)
                }
              />
            </Field>
            <Field
              label="Timing"
              htmlFor="bTiming"
              hint="T4 is the usual choice on a LAN; drop to T2 on fragile networks."
            >
              <select
                id="bTiming"
                value={String(plan.timing ?? 4)}
                onChange={(e) => set('timing', Number(e.target.value) as Timing)}
              >
                {[0, 1, 2, 3, 4, 5].map((t) => (
                  <option key={t} value={t}>
                    T{t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Running as" htmlFor="bPriv">
              <select
                id="bPriv"
                value={plan.privileged ? 'root' : 'user'}
                onChange={(e) => set('privileged', e.target.value === 'root')}
              >
                <option value="root">root (sudo)</option>
                <option value="user">unprivileged user</option>
              </select>
            </Field>
            <div className="field span2">
              {(
                [
                  ['serviceDetection', 'Service and version detection (-sV)'],
                  ['osDetection', 'OS detection (-O)'],
                  ['traceroute', 'Traceroute (--traceroute)'],
                  ['noDns', 'Skip reverse DNS (-n)'],
                  ['openOnly', 'Only show open ports (--open)'],
                  ['reason', 'Explain why a port is in its state (--reason)'],
                  ['ipv6', 'IPv6 (-6)'],
                ] as Array<[keyof NmapPlan, string]>
              ).map(([k, label]) => (
                <label className="ck" key={String(k)} style={{ marginBottom: 4 }}>
                  <input
                    type="checkbox"
                    checked={!!plan[k]}
                    onChange={(e) => set(k, e.target.checked as never)}
                  />{' '}
                  {label}
                </label>
              ))}
              <label className="ck" style={{ marginBottom: 4 }}>
                <input
                  type="checkbox"
                  checked={plan.scripts === true}
                  onChange={(e) => set('scripts', e.target.checked)}
                />{' '}
                Default NSE scripts (-sC)
              </label>
            </div>
          </Fieldset>
        </div>
      </div>

      <Fieldset legend="Command" cols={2}>
        <div className="field span2">
          <code
            className="cmd"
            style={{ maxHeight: 'none', fontSize: 12.5 }}
            data-testid="builder-command"
          >
            {command}
          </code>
          <div className="hint" style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              className="btn pri"
              onClick={() =>
                void copyText(command).then((ok) =>
                  toast(
                    ok ? 'Command copied' : 'Could not copy — select the text instead',
                    ok ? 'info' : 'warn',
                  ),
                )
              }
              data-testid="builder-copy"
            >
              Copy command
            </button>
            <button
              className="btn"
              onClick={() => {
                setScanId(null);
                setView('scans');
              }}
            >
              Upload the results
            </button>
          </div>
          {issues.map((i) => (
            <div
              key={i.message}
              className={i.level === 'error' ? 'err' : 'changed-note'}
              data-testid={`builder-${i.level}`}
            >
              {i.message}
            </div>
          ))}
          {!issues.length && (
            <div className="hint" style={{ color: 'var(--gr)' }}>
              Ready to run. Afterwards, upload <code>{plan.outputBase}.xml</code> on the Scans tab.
            </div>
          )}
        </div>
      </Fieldset>
    </>
  );
}
