import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  byId,
  caseHostByIp,
  HOST_STATUS,
  layoutTerrainMap,
  layoutTrace,
  MAP_NODE_BUDGET,
  netKey,
  OS_COLORS,
  type NetAggregate,
  type ScanHost,
  type TerrainHostSummary,
} from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { useTerrain } from '../store/useTerrain';
import { promoteHosts } from '../lib/terrainActions';
import { toast } from '../store/useToasts';
import { EmptyState } from './EmptyState';

const HS = byId(HOST_STATUS);

export function MapView() {
  const state = useCaseStore((s) => s.state);
  const access = useCaseStore((s) => s.access);
  const store = useTerrain((s) => s.store);
  const version = useTerrain((s) => s.version);
  const { scanId, setScanId, setView } = useUiStore();
  const scans = Object.values(state.scans).filter((s) => s.status === 'ready');
  const scan =
    (scanId && state.scans[scanId]?.status === 'ready' ? state.scans[scanId] : null) ??
    scans[0] ??
    null;

  const [bits, setBits] = useState(24);
  const [layout, setLayout] = useState<'subnet' | 'trace'>('subnet');
  const [nets, setNets] = useState<NetAggregate[]>([]);
  const [expanded, setExpanded] = useState<Record<string, TerrainHostSummary[]>>({});
  const [traceHosts, setTraceHosts] = useState<ScanHost[] | null>(null);
  const [selected, setSelected] = useState<TerrainHostSummary | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (scan && scan.id !== scanId) setScanId(scan.id);
  }, [scan, scanId, setScanId]);

  // A different scan or prefix length invalidates the expansion and selection.
  const mapKey = `${scan?.id ?? ''}|${scan?.status ?? ''}|${bits}|${version}`;
  const [seenMapKey, setSeenMapKey] = useState(mapKey);
  if (seenMapKey !== mapKey) {
    setSeenMapKey(mapKey);
    setLoading(true);
    setExpanded({});
    setSelected(null);
  }

  useEffect(() => {
    if (!scan) return;
    let alive = true;
    store
      .mapSummary(scan.id, bits)
      .then((n) => alive && setNets(n))
      .catch((err: unknown) =>
        toast(err instanceof Error ? err.message : 'Could not load the map', 'bad'),
      )
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, mapKey]);

  useEffect(() => {
    if (!scan || layout !== 'trace') return;
    let alive = true;
    store
      .traceHosts(scan.id)
      .then((hosts) => {
        if (!alive) return;
        // layoutTrace wants full ScanHost records; only ip/trace/openCount/bucket matter here
        setTraceHosts(hosts.map((h) => ({ ...h, ports: [], scripts: [] }) as unknown as ScanHost));
      })
      .catch(() => alive && setTraceHosts([]));
    return () => {
      alive = false;
    };
  }, [store, scan, layout, version]);

  /** Expanding a subnet fetches just that subnet's hosts. */
  const toggleNet = useCallback(
    async (key: string): Promise<void> => {
      if (expanded[key]) {
        setExpanded((e) => {
          const { [key]: _drop, ...rest } = e;
          return rest;
        });
        return;
      }
      if (!scan) return;
      const hosts = await store.hostsInNet(scan.id, key);
      setExpanded((e) => ({ ...e, [key]: hosts }));
    },
    [expanded, scan, store],
  );

  const linked = useMemo(() => caseHostByIp(state), [state]);
  const map = useMemo(() => layoutTerrainMap(nets, expanded), [nets, expanded]);
  const trace = useMemo(
    () => (traceHosts && traceHosts.length ? layoutTrace(traceHosts) : null),
    [traceHosts],
  );

  if (!scans.length) {
    return (
      <EmptyState
        title="No terrain to map"
        body="Upload an nmap scan first. The map draws one hub per subnet, expands into individual hosts, and marks any host that is also in your case."
      >
        <button className="btn pri" onClick={() => setView('scans')}>
          Go to scans
        </button>
      </EmptyState>
    );
  }

  return (
    <>
      <div className="toolbar">
        <select
          value={scan?.id ?? ''}
          onChange={(e) => setScanId(e.target.value)}
          style={{ maxWidth: 260 }}
          data-testid="map-scan-select"
        >
          {scans.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="seg">
          <button
            className={layout === 'subnet' ? 'on' : ''}
            onClick={() => setLayout('subnet')}
            data-testid="layout-subnet"
          >
            Subnets
          </button>
          <button
            className={layout === 'trace' ? 'on' : ''}
            onClick={() => setLayout('trace')}
            data-testid="layout-trace"
          >
            Traceroute
          </button>
        </div>
        {layout === 'subnet' && (
          <div className="seg">
            {[16, 24].map((b) => (
              <button key={b} className={bits === b ? 'on' : ''} onClick={() => setBits(b)}>
                /{b}
              </button>
            ))}
          </div>
        )}
        {layout === 'subnet' && (
          <button
            className="btn ghost"
            onClick={() => {
              if (!scan) return;
              const budget = nets.reduce((n, x) => n + x.hosts, 0);
              if (budget > MAP_NODE_BUDGET) {
                toast(
                  `${budget} hosts is past the ${MAP_NODE_BUDGET}-node drawing budget — expand subnets one at a time`,
                  'warn',
                );
                return;
              }
              void Promise.all(
                nets.map((n) =>
                  store.hostsInNet(scan.id, n.netKey).then((hosts) => [n.netKey, hosts] as const),
                ),
              ).then((pairs) => setExpanded(Object.fromEntries(pairs)));
            }}
            data-testid="expand-all"
          >
            Expand all
          </button>
        )}
        <span className="sp" />
        <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: '.14em' }}>
          {loading
            ? 'LOADING…'
            : `${nets.length} SUBNETS · ${nets.reduce((n, x) => n + x.hosts, 0)} HOSTS`}
        </span>
      </div>
      <div className="mapwrap">
        {layout === 'subnet' ? (
          <SubnetMap
            map={map}
            linked={linked}
            onToggle={(k) => void toggleNet(k)}
            onSelect={setSelected}
            selectedIp={selected?.ip ?? null}
          />
        ) : trace ? (
          <TraceMap trace={trace} hosts={traceHosts ?? []} linked={linked} />
        ) : (
          <EmptyState
            title="No traceroute data"
            body="Re-run the scan with --traceroute to build a hop-by-hop topology."
          />
        )}
        <Legend />
      </div>
      {selected && (
        <div className="inspector" data-testid="map-inspector">
          <div className="ihead">
            <b>{selected.ip}</b>
            {selected.hostnames[0] && (
              <span style={{ color: 'var(--dim)' }}>{selected.hostnames[0]}</span>
            )}
            <span className="sp" />
            {access.edit && scan && !linked.has(selected.ip) && (
              <button
                className="btn sm"
                onClick={() => void promoteHosts([selected], scan.id)}
                data-testid="map-promote"
              >
                Add to case
              </button>
            )}
            <button className="btn sm ghost" onClick={() => setSelected(null)}>
              ✕
            </button>
          </div>
          <dl className="kv">
            <dt>Class</dt>
            <dd>
              {selected.bucket}
              {selected.role && ` · ${selected.role}`}
            </dd>
            {selected.osName && (
              <>
                <dt>OS</dt>
                <dd>
                  {selected.osName}
                  {selected.osAccuracy && ` (${selected.osAccuracy}%)`}
                </dd>
              </>
            )}
            <dt>Open ports</dt>
            <dd>
              {selected.ports.map((p) => `${p.port}/${p.proto} ${p.name}`).join(', ') || 'none'}
            </dd>
            {selected.flags.length > 0 && (
              <>
                <dt>Worth reviewing</dt>
                <dd style={{ color: 'var(--am)' }}>{selected.flags.join(' · ')}</dd>
              </>
            )}
            {linked.get(selected.ip) && (
              <>
                <dt>Case host</dt>
                <dd
                  style={{
                    color: HS[state.hosts[linked.get(selected.ip)!]?.status ?? 'unknown']?.color,
                  }}
                >
                  {state.hosts[linked.get(selected.ip)!]?.name} ·{' '}
                  {state.hosts[linked.get(selected.ip)!]?.status}
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </>
  );
}

/** Pan and zoom around a static SVG scene. */
function usePanZoom(): {
  ref: React.RefObject<SVGSVGElement | null>;
  transform: string;
  reset: () => void;
  handlers: React.SVGProps<SVGSVGElement>;
} {
  const ref = useRef<SVGSVGElement>(null);
  const [t, setT] = useState({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  return {
    ref,
    transform: `translate(${t.x},${t.y}) scale(${t.k})`,
    reset: () => setT({ k: 1, x: 0, y: 0 }),
    handlers: {
      onWheel: (e) => {
        const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        setT((cur) => {
          const k = Math.min(9, Math.max(0.15, cur.k * f));
          const scale = k / cur.k;
          const svg = ref.current;
          if (!svg) return { ...cur, k };
          const rect = svg.getBoundingClientRect();
          const vb = svg.viewBox.baseVal;
          const s = Math.max(vb.width / rect.width, vb.height / rect.height);
          const mx = (e.clientX - rect.left - rect.width / 2) * s + vb.x + vb.width / 2;
          const my = (e.clientY - rect.top - rect.height / 2) * s + vb.y + vb.height / 2;
          return { k, x: mx - (mx - cur.x) * scale, y: my - (my - cur.y) * scale };
        });
      },
      onPointerDown: (e) => {
        drag.current = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y };
        (e.target as Element).setPointerCapture?.(e.pointerId);
      },
      onPointerMove: (e) => {
        const d = drag.current;
        if (!d) return;
        const svg = ref.current;
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const s = Math.max(vb.width / rect.width, vb.height / rect.height);
        setT((cur) => ({
          ...cur,
          x: d.tx + (e.clientX - d.x) * s,
          y: d.ty + (e.clientY - d.y) * s,
        }));
      },
      onPointerUp: () => {
        drag.current = null;
      },
      onPointerCancel: () => {
        drag.current = null;
      },
    },
  };
}

function SubnetMap({
  map,
  linked,
  onToggle,
  onSelect,
  selectedIp,
}: {
  map: ReturnType<typeof layoutTerrainMap>;
  linked: Map<string, string>;
  onToggle: (netKey: string) => void;
  onSelect: (h: TerrainHostSummary | null) => void;
  selectedIp: string | null;
}) {
  const state = useCaseStore((s) => s.state);
  const { ref, transform, reset, handlers } = usePanZoom();
  const { bounds } = map;
  const statusOf = (ip: string): string | null => {
    const id = linked.get(ip);
    const h = id ? state.hosts[id] : undefined;
    return h ? (HS[h.status] ?? HS.unknown).color : null;
  };
  const hubOverlay = (netKeyValue: string): number => {
    let n = 0;
    for (const [ip] of linked)
      if (netKey(ip, Number(netKeyValue.split('/')[1] ?? 24)) === netKeyValue) n++;
    return n;
  };
  return (
    <>
      <button className="btn ghost mapreset" onClick={reset} data-testid="map-reset">
        Reset view
      </button>
      <svg
        ref={ref}
        className="terrainsvg"
        viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`}
        preserveAspectRatio="xMidYMid meet"
        {...handlers}
        data-testid="terrain-map"
      >
        <g transform={transform}>
          {map.edges.map((e, i) => (
            <line
              key={i}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              stroke={e.trunk ? '#33465c' : '#243244'}
              strokeWidth={e.trunk ? 1.8 : 1}
            />
          ))}
          {map.root && (
            <circle
              cx={map.root.x}
              cy={map.root.y}
              r={map.root.r}
              fill="#e6edf6"
              stroke="#0b1017"
              strokeWidth={1.5}
            />
          )}
          {map.hubs.map((h) => {
            const overlay = hubOverlay(h.netKey);
            return (
              <g
                key={h.id}
                className="mapnode"
                onClick={() => onToggle(h.netKey)}
                data-testid="map-hub"
              >
                <title>{`${h.netKey}\n${h.hosts} hosts · ${h.openPorts} open ports${h.flagged ? ` · ${h.flagged} flagged` : ''}${overlay ? `\n${overlay} in this case` : ''}\nclick to ${h.expanded ? 'collapse' : 'expand'}`}</title>
                <circle
                  cx={h.x}
                  cy={h.y}
                  r={h.r}
                  fill={h.expanded ? '#16324a' : '#9fb0c4'}
                  stroke={overlay ? '#ff1f3d' : '#0b1017'}
                  strokeWidth={overlay ? 2.5 : 1.5}
                />
                <text x={h.x} y={h.y + h.r + 16} textAnchor="middle" fill="#cfdae8" fontSize={12}>
                  {h.netKey}
                </text>
                <text x={h.x} y={h.y + h.r + 28} textAnchor="middle" fill="#8593a5" fontSize={10}>
                  {h.hosts} hosts
                </text>
              </g>
            );
          })}
          {map.hosts.map((h) => {
            const status = statusOf(h.ip);
            return (
              <g
                key={h.id}
                className="mapnode"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(h.host);
                }}
                data-testid="map-host"
              >
                <title>{`${h.ip}${h.host.hostnames[0] ? `  ${h.host.hostnames[0]}` : ''}\n${h.host.bucket}${h.host.role ? ` | ${h.host.role}` : ''}\n${h.host.openCount} open ports`}</title>
                {selectedIp === h.ip && (
                  <circle
                    cx={h.x}
                    cy={h.y}
                    r={h.r + 7}
                    fill="none"
                    stroke="#22e8ff"
                    strokeWidth={1.5}
                  />
                )}
                {status && (
                  <circle
                    cx={h.x}
                    cy={h.y}
                    r={h.r + 4}
                    fill="none"
                    stroke={status}
                    strokeWidth={2.5}
                  />
                )}
                {h.flagged && (
                  <circle
                    cx={h.x}
                    cy={h.y}
                    r={h.r + 2}
                    fill="none"
                    stroke="#ffb03a"
                    strokeWidth={1.4}
                    strokeDasharray="3 3"
                  />
                )}
                <circle
                  cx={h.x}
                  cy={h.y}
                  r={h.r}
                  fill={h.color}
                  stroke="#0b1017"
                  strokeWidth={1.5}
                />
              </g>
            );
          })}
        </g>
      </svg>
    </>
  );
}

function TraceMap({
  trace,
  hosts,
  linked,
}: {
  trace: NonNullable<ReturnType<typeof layoutTrace>>;
  hosts: ScanHost[];
  linked: Map<string, string>;
}) {
  const state = useCaseStore((s) => s.state);
  const { ref, transform, reset, handlers } = usePanZoom();
  const xs = trace.nodes.map((n) => n.x);
  const ys = trace.nodes.map((n) => n.y);
  const pad = 120;
  const vb = `${Math.min(...xs) - pad} ${Math.min(...ys) - pad} ${Math.max(...xs) - Math.min(...xs) + 2 * pad} ${Math.max(...ys) - Math.min(...ys) + 2 * pad}`;
  const byId2 = new Map(trace.nodes.map((n) => [n.id, n]));
  return (
    <>
      <button className="btn ghost mapreset" onClick={reset}>
        Reset view
      </button>
      <svg
        ref={ref}
        className="terrainsvg"
        viewBox={vb}
        preserveAspectRatio="xMidYMid meet"
        {...handlers}
        data-testid="terrain-trace"
      >
        <g transform={transform}>
          {trace.edges.map((e, i) => {
            const a = byId2.get(e.a);
            const b = byId2.get(e.b);
            if (!a || !b) return null;
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={e.kind === 'trunk' ? '#33465c' : '#243244'}
                strokeWidth={e.kind === 'trunk' ? 1.8 : 1}
              />
            );
          })}
          {trace.nodes.map((n) => {
            const ip = n.host >= 0 ? hosts[n.host]?.ip : undefined;
            const id = ip ? linked.get(ip) : undefined;
            const status = id
              ? (HS[state.hosts[id]?.status ?? 'unknown'] ?? HS.unknown).color
              : null;
            return (
              <g key={n.id} className="mapnode">
                <title>{`${n.label}${n.sub ? `  ${n.sub}` : ''}`}</title>
                {status && (
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={n.r + 4}
                    fill="none"
                    stroke={status}
                    strokeWidth={2.5}
                  />
                )}
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.r}
                  fill={n.color}
                  stroke="#0b1017"
                  strokeWidth={1.5}
                />
                <text x={n.x} y={n.y + n.r + 15} textAnchor="middle" fill="#cfdae8" fontSize={11}>
                  {n.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </>
  );
}

function Legend() {
  return (
    <div className="legend">
      {OS_COLORS.map(([name, color]) => (
        <span key={name} className="li">
          <i
            style={{
              width: 9,
              height: 9,
              background: color,
              display: 'block',
              borderRadius: '50%',
            }}
          />
          {name}
        </span>
      ))}
      <span className="li" style={{ color: 'var(--am)' }}>
        ◌ cleartext / legacy / remote access
      </span>
      <span className="li" style={{ color: 'var(--rd)' }}>
        ◯ ring = host is in this case
      </span>
    </div>
  );
}
