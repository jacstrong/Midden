import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { useMapMotion, type Box, type Frame, type Point, type View } from './mapMotion';
import {
  labelTier,
  MapLabels,
  maxZoom,
  onScreen,
  pxPerUnit,
  type MapLabel,
  type Size,
} from './mapLabels';

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
            scope={nets}
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

/** Pan and zoom around a static SVG scene, plus the screen size the scene is drawn at. */
function usePanZoom(): {
  ref: React.RefObject<SVGSVGElement | null>;
  view: View;
  size: Size;
  transform: string;
  reset: () => void;
  /** The pan and zoom as of the last commit, for code that runs between renders. */
  getView: () => View;
  handlers: React.SVGProps<SVGSVGElement>;
} {
  const ref = useRef<SVGSVGElement>(null);
  const [t, setT] = useState<View>({ k: 1, x: 0, y: 0 });
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  const view = useRef(t);
  useLayoutEffect(() => {
    view.current = t;
  }, [t]);
  useLayoutEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const measure = (): void => {
      const r = svg.getBoundingClientRect();
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  return {
    ref,
    view: t,
    size,
    transform: `translate(${t.x},${t.y}) scale(${t.k})`,
    reset: () => setT({ k: 1, x: 0, y: 0 }),
    getView: () => view.current,
    handlers: {
      onWheel: (e) => {
        const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        setT((cur) => {
          const svg = ref.current;
          if (!svg) return { ...cur, k: Math.min(9, Math.max(0.15, cur.k * f)) };
          const rect = svg.getBoundingClientRect();
          const vb = svg.viewBox.baseVal;
          const limit = maxZoom(
            { x: vb.x, y: vb.y, w: vb.width, h: vb.height },
            { w: rect.width, h: rect.height },
          );
          const k = Math.min(limit, Math.max(0.15, cur.k * f));
          const scale = k / cur.k;
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

type TerrainMap = ReturnType<typeof layoutTerrainMap>;

/** Where the layout puts every node, as a frame the map can move towards. */
function frameOf(map: TerrainMap, scope: unknown): Frame {
  const pos = new Map<string, Point>();
  if (map.root) pos.set('root', map.root);
  for (const n of map.hubs) pos.set(n.id, n);
  for (const n of map.hosts) pos.set(n.id, n);
  return { pos, bounds: map.bounds, scope };
}

/** Closest the layout puts hosts on a ring, which decides when their labels fit. */
const HOST_SPACING = 70;
/** Screen gap between hosts for an octet label, then for the full IP and hostname. */
const HOST_LABEL_PX = [40, 90] as const;
/** A subnet label needs about this much screen room to its nearest neighbour hub. */
const HUB_LABEL_PX = 100;

const lastOctet = (ip: string): string =>
  ip.includes('.') ? '.' + (ip.split('.').pop() ?? '') : ':' + (ip.split(':').pop() ?? '');
const shortName = (hostnames: string[]): string | undefined => hostnames[0]?.split('.')[0];

function SubnetMap({
  map,
  scope,
  linked,
  onToggle,
  onSelect,
  selectedIp,
}: {
  map: TerrainMap;
  /** The loaded subnet data; a new one means a different map, which jumps instead of moving. */
  scope: unknown;
  linked: Map<string, string>;
  onToggle: (netKey: string) => void;
  onSelect: (h: TerrainHostSummary | null) => void;
  selectedIp: string | null;
}) {
  const { ref, view, size, transform, reset, getView, handlers } = usePanZoom();
  const target = useMemo(() => frameOf(map, scope), [map, scope]);
  const parentOf = useMemo(() => new Map(map.edges.map((e) => [e.b, e.a])), [map]);
  const frame = useMapMotion(target, parentOf, { getView, onRefit: reset });
  const { bounds } = frame;

  // Room around each hub: the distance to its nearest neighbour hub.
  const hubRoom = useMemo(() => {
    const room = new Map<string, number>();
    for (const a of map.hubs) {
      let d = Infinity;
      for (const b of map.hubs) if (a !== b) d = Math.min(d, Math.hypot(a.x - b.x, a.y - b.y));
      room.set(a.id, d);
    }
    return room;
  }, [map]);

  const ppu = size.w ? pxPerUnit(bounds, size, view) : 0;
  const tier = labelTier(HOST_SPACING * ppu, HOST_LABEL_PX);
  const labels: MapLabel[] = [];
  for (const h of map.hubs) {
    if ((hubRoom.get(h.id) ?? 0) * ppu < HUB_LABEL_PX) continue;
    const p = frame.pos.get(h.id) ?? h;
    labels.push({
      id: h.id,
      x: p.x,
      y: p.y,
      r: h.r + 2,
      name: h.netKey,
      detail: `${h.hosts} hosts`,
    });
  }
  if (tier > 0)
    for (const h of map.hosts) {
      const p = frame.pos.get(h.id) ?? h;
      // Clear the outermost ring drawn around the host, which grows with the zoom.
      const r = h.r + (selectedIp === h.ip ? 8.5 : linked.has(h.ip) ? 5.5 : h.flagged ? 3 : 1);
      labels.push(
        tier === 2
          ? { id: h.id, x: p.x, y: p.y, r, name: h.ip, detail: shortName(h.host.hostnames) }
          : { id: h.id, x: p.x, y: p.y, r, name: lastOctet(h.ip) },
      );
    }

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
        data-label-tier={tier}
      >
        <g transform={transform}>
          <SubnetScene
            map={map}
            frame={frame}
            linked={linked}
            onToggle={onToggle}
            onSelect={onSelect}
            selectedIp={selectedIp}
          />
          <MapLabels labels={labels} ppu={ppu} view={onScreen(bounds, size, view)} />
        </g>
      </svg>
    </>
  );
}

/** The subnet map's shapes. Memoised so that panning and zooming only redraw the labels. */
const SubnetScene = memo(function SubnetScene({
  map,
  frame,
  linked,
  onToggle,
  onSelect,
  selectedIp,
}: {
  map: TerrainMap;
  frame: Frame;
  linked: Map<string, string>;
  onToggle: (netKey: string) => void;
  onSelect: (h: TerrainHostSummary | null) => void;
  selectedIp: string | null;
}) {
  const state = useCaseStore((s) => s.state);
  const at = (id: string, fallback: Point): Point => frame.pos.get(id) ?? fallback;
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
      {map.edges.map((e) => {
        const a = at(e.a, { x: e.x1, y: e.y1 });
        const b = at(e.b, { x: e.x2, y: e.y2 });
        return (
          <line
            key={`${e.a}>${e.b}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={e.trunk ? '#33465c' : '#243244'}
            strokeWidth={e.trunk ? 1.8 : 1}
          />
        );
      })}
      {map.root && (
        <circle
          cx={at('root', map.root).x}
          cy={at('root', map.root).y}
          r={map.root.r}
          fill="#e6edf6"
          stroke="#0b1017"
          strokeWidth={1.5}
        />
      )}
      {map.hubs.map((h) => {
        const overlay = hubOverlay(h.netKey);
        const p = at(h.id, h);
        return (
          <g
            key={h.id}
            className="mapnode"
            onClick={() => onToggle(h.netKey)}
            data-testid="map-hub"
          >
            <title>{`${h.netKey}\n${h.hosts} hosts · ${h.openPorts} open ports${h.flagged ? ` · ${h.flagged} flagged` : ''}${overlay ? `\n${overlay} in this case` : ''}\nclick to ${h.expanded ? 'collapse' : 'expand'}`}</title>
            <circle
              cx={p.x}
              cy={p.y}
              r={h.r}
              fill={h.expanded ? '#16324a' : '#9fb0c4'}
              stroke={overlay ? '#ff1f3d' : '#0b1017'}
              strokeWidth={overlay ? 2.5 : 1.5}
            />
          </g>
        );
      })}
      {map.hosts.map((h) => {
        const status = statusOf(h.ip);
        const p = at(h.id, h);
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
                cx={p.x}
                cy={p.y}
                r={h.r + 7}
                fill="none"
                stroke="#22e8ff"
                strokeWidth={1.5}
              />
            )}
            {status && (
              <circle cx={p.x} cy={p.y} r={h.r + 4} fill="none" stroke={status} strokeWidth={2.5} />
            )}
            {h.flagged && (
              <circle
                cx={p.x}
                cy={p.y}
                r={h.r + 2}
                fill="none"
                stroke="#ffb03a"
                strokeWidth={1.4}
                strokeDasharray="3 3"
              />
            )}
            <circle cx={p.x} cy={p.y} r={h.r} fill={h.color} stroke="#0b1017" strokeWidth={1.5} />
          </g>
        );
      })}
    </>
  );
});

type TraceLayout = NonNullable<ReturnType<typeof layoutTrace>>;

/** Rows of the traceroute tree are this far apart. */
const TRACE_ROW = 62;
/** Screen gap between rows for a node's address, then for its hostname or hop as well. */
const TRACE_LABEL_PX = [22, 36] as const;

function TraceMap({
  trace,
  hosts,
  linked,
}: {
  trace: TraceLayout;
  hosts: ScanHost[];
  linked: Map<string, string>;
}) {
  const { ref, view, size, transform, reset, handlers } = usePanZoom();
  const bounds = useMemo((): Box => {
    const xs = trace.nodes.map((n) => n.x);
    const ys = trace.nodes.map((n) => n.y);
    const pad = 120;
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    return { x, y, w: Math.max(...xs) - x + pad, h: Math.max(...ys) - y + pad };
  }, [trace]);
  const ppu = size.w ? pxPerUnit(bounds, size, view) : 0;
  const tier = labelTier(TRACE_ROW * ppu, TRACE_LABEL_PX);
  const labels: MapLabel[] =
    tier === 0
      ? []
      : trace.nodes.map((n) => ({
          id: n.id,
          x: n.x,
          y: n.y,
          r: n.r + (n.host >= 0 && linked.has(hosts[n.host]?.ip ?? '') ? 5.5 : 1),
          name: n.label,
          detail: tier === 2 ? n.sub || undefined : undefined,
        }));
  return (
    <>
      <button className="btn ghost mapreset" onClick={reset}>
        Reset view
      </button>
      <svg
        ref={ref}
        className="terrainsvg"
        viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`}
        preserveAspectRatio="xMidYMid meet"
        {...handlers}
        data-testid="terrain-trace"
        data-label-tier={tier}
      >
        <g transform={transform}>
          <TraceScene trace={trace} hosts={hosts} linked={linked} />
          <MapLabels labels={labels} ppu={ppu} view={onScreen(bounds, size, view)} />
        </g>
      </svg>
    </>
  );
}

/** The traceroute map's shapes. Memoised so that panning and zooming only redraw the labels. */
const TraceScene = memo(function TraceScene({
  trace,
  hosts,
  linked,
}: {
  trace: TraceLayout;
  hosts: ScanHost[];
  linked: Map<string, string>;
}) {
  const state = useCaseStore((s) => s.state);
  const byId2 = new Map(trace.nodes.map((n) => [n.id, n]));
  return (
    <>
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
        const status = id ? (HS[state.hosts[id]?.status ?? 'unknown'] ?? HS.unknown).color : null;
        return (
          <g key={n.id} className="mapnode">
            <title>{`${n.label}${n.sub ? `  ${n.sub}` : ''}`}</title>
            {status && (
              <circle cx={n.x} cy={n.y} r={n.r + 4} fill="none" stroke={status} strokeWidth={2.5} />
            )}
            <circle cx={n.x} cy={n.y} r={n.r} fill={n.color} stroke="#0b1017" strokeWidth={1.5} />
          </g>
        );
      })}
    </>
  );
});

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
