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
  TRACE_ROW,
  traceBranches,
  traceFanouts,
  type NetAggregate,
  type TerrainHostSummary,
  type TerrainTraceHost,
} from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { useTerrain } from '../store/useTerrain';
import { promoteHosts } from '../lib/terrainActions';
import { toast } from '../store/useToasts';
import { EmptyState } from './EmptyState';
import { useMapMotion, type Frame, type Point, type View } from './mapMotion';
import {
  labelHeightPx,
  labelTier,
  MapBadges,
  MapLabels,
  maxZoom,
  onScreen,
  pxPerUnit,
  type MapBadge,
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
  const [traceHosts, setTraceHosts] = useState<TerrainTraceHost[] | null>(null);
  /** Folded trace nodes; null until the analyst changes them, meaning "big fan-outs folded". */
  const [traceFold, setTraceFold] = useState<ReadonlySet<string> | null>(null);
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
        setTraceHosts(hosts);
        setTraceFold(null);
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
  const fold = useMemo(
    () => traceFold ?? (traceHosts ? traceFanouts(traceHosts) : new Set<string>()),
    [traceFold, traceHosts],
  );
  const trace = useMemo(
    () => (traceHosts && traceHosts.length ? layoutTrace(traceHosts, fold) : null),
    [traceHosts, fold],
  );
  const toggleTrace = useCallback(
    (id: string): void => {
      const next = new Set(fold);
      if (!next.delete(id)) next.add(id);
      setTraceFold(next);
    },
    [fold],
  );
  const foldedCount = trace ? trace.nodes.filter((n) => n.collapsed).length : 0;

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
        {layout === 'trace' && trace && (
          <>
            <button
              className="btn ghost"
              onClick={() => {
                const n = traceHosts?.length ?? 0;
                if (n > MAP_NODE_BUDGET) {
                  toast(
                    `${n} traced hosts is past the ${MAP_NODE_BUDGET}-node drawing budget — expand routers one at a time`,
                    'warn',
                  );
                  return;
                }
                setTraceFold(new Set());
              }}
              data-testid="trace-expand-all"
            >
              Expand all
            </button>
            <button
              className="btn ghost"
              onClick={() => setTraceFold(traceBranches(traceHosts ?? []))}
              data-testid="trace-collapse-all"
            >
              Collapse all
            </button>
          </>
        )}
        <span className="sp" />
        <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: '.14em' }}>
          {loading
            ? 'LOADING…'
            : layout === 'trace' && traceHosts
              ? `${traceHosts.length} TRACED HOSTS${foldedCount ? ` · ${foldedCount} FOLDED` : ''}`
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
          <TraceMap
            trace={trace}
            hosts={traceHosts ?? []}
            scope={traceHosts}
            linked={linked}
            onToggle={toggleTrace}
            onSelect={setSelected}
            selectedIp={selected?.ip ?? null}
          />
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

/**
 * Room a label may use between rows, in map units: the row spacing less the largest node above
 * and below it, and an allowance for status and selection rings and a folded node's stack.
 */
const TRACE_RING_ROOM = 12;
/** Clear space a label keeps above the next node down, so rows never look cramped. */
const TRACE_LABEL_BREATH_PX = 6;
const TRACE_LABEL_PX = [
  labelHeightPx(1) + TRACE_LABEL_BREATH_PX,
  labelHeightPx(2) + TRACE_LABEL_BREATH_PX,
] as const;

function TraceMap({
  trace,
  hosts,
  scope,
  linked,
  onToggle,
  onSelect,
  selectedIp,
}: {
  trace: TraceLayout;
  hosts: TerrainTraceHost[];
  /** The loaded trace data; a new one means a different tree, which jumps instead of moving. */
  scope: unknown;
  linked: Map<string, string>;
  onToggle: (id: string) => void;
  onSelect: (h: TerrainHostSummary | null) => void;
  selectedIp: string | null;
}) {
  const { ref, view, size, transform, reset, getView, handlers } = usePanZoom();
  const target = useMemo((): Frame => {
    const xs = trace.nodes.map((n) => n.x);
    const ys = trace.nodes.map((n) => n.y);
    const pad = 120;
    const x = Math.min(...xs) - pad;
    const y = Math.min(...ys) - pad;
    // extra room on the right for the folded-count pills
    const bounds = { x, y, w: Math.max(...xs) - x + pad + 60, h: Math.max(...ys) - y + pad };
    return { pos: new Map(trace.nodes.map((n) => [n.id, { x: n.x, y: n.y }])), bounds, scope };
  }, [trace, scope]);
  const parentOf = useMemo(() => new Map(trace.edges.map((e) => [e.b, e.a])), [trace]);
  const frame = useMapMotion(target, parentOf, { getView, onRefit: reset });
  const { bounds } = frame;
  const ppu = size.w ? pxPerUnit(bounds, size, view) : 0;
  // The scanner sits alone in the first column, so only the other nodes ever share a column.
  const maxR = useMemo(
    () => Math.max(0, ...trace.nodes.filter((n) => n.kind !== 'root').map((n) => n.r)),
    [trace],
  );
  const tier = labelTier((TRACE_ROW - 2 * maxR - TRACE_RING_ROOM) * ppu, TRACE_LABEL_PX);
  const labels: MapLabel[] = [];
  const badges: MapBadge[] = [];
  for (const n of trace.nodes) {
    const p = frame.pos.get(n.id) ?? n;
    const ip = n.host >= 0 ? hosts[n.host]?.ip : undefined;
    const ring = selectedIp && ip === selectedIp ? 8.5 : ip && linked.has(ip) ? 5.5 : 0.75;
    if (tier > 0)
      labels.push({
        id: n.id,
        x: p.x,
        y: p.y,
        // a folded node's stack rises up and right, so it never pushes the label down
        r: n.r + ring,
        name: n.label,
        detail: tier === 2 ? n.sub || undefined : undefined,
      });
    if (n.collapsed && tier > 0)
      badges.push({
        id: n.id,
        x: p.x,
        y: p.y,
        r: n.r + STACK_OFFSET * 2,
        text: `+${n.below ?? 0} host${n.below === 1 ? '' : 's'}`,
      });
  }
  const visible = onScreen(bounds, size, view);
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
          <TraceScene
            trace={trace}
            frame={frame}
            hosts={hosts}
            linked={linked}
            onToggle={onToggle}
            onSelect={onSelect}
            selectedIp={selectedIp}
          />
          <MapLabels labels={labels} ppu={ppu} view={visible} />
          <MapBadges badges={badges} ppu={ppu} view={visible} />
        </g>
      </svg>
    </>
  );
}

/** How far each disc of a folded node's stack sits from the one in front, in map units. */
const STACK_OFFSET = 4;

function traceTitle(n: TraceLayout['nodes'][number], isHost: boolean): string {
  const head = `${n.label}${n.sub ? `  ${n.sub}` : ''}`;
  const hosts = `${n.below ?? 0} host${n.below === 1 ? '' : 's'}`;
  const inspect = isHost ? ' · opens the inspector' : '';
  if (!n.kids) return isHost ? `${head}\nclick to inspect` : head;
  return n.collapsed
    ? `${head}\n${hosts} folded below\nclick to expand${inspect}`
    : `${head}\n${hosts} below\nclick to collapse${inspect}`;
}

/** The traceroute map's shapes. Memoised so that panning and zooming only redraw the labels. */
const TraceScene = memo(function TraceScene({
  trace,
  frame,
  hosts,
  linked,
  onToggle,
  onSelect,
  selectedIp,
}: {
  trace: TraceLayout;
  frame: Frame;
  hosts: TerrainTraceHost[];
  linked: Map<string, string>;
  onToggle: (id: string) => void;
  onSelect: (h: TerrainHostSummary | null) => void;
  selectedIp: string | null;
}) {
  const state = useCaseStore((s) => s.state);
  const at = (id: string, fallback: Point): Point => frame.pos.get(id) ?? fallback;
  const byId2 = new Map(trace.nodes.map((n) => [n.id, n]));
  return (
    <>
      {trace.edges.map((e) => {
        const na = byId2.get(e.a);
        const nb = byId2.get(e.b);
        if (!na || !nb) return null;
        const a = at(e.a, na);
        const b = at(e.b, nb);
        return (
          <line
            key={`${e.a}>${e.b}`}
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
        const p = at(n.id, n);
        const host = n.host >= 0 ? hosts[n.host] : undefined;
        const id = host ? linked.get(host.ip) : undefined;
        const status = id ? (HS[state.hosts[id]?.status ?? 'unknown'] ?? HS.unknown).color : null;
        const kids = n.kids ?? 0;
        const arm = n.r * 0.5;
        const glyph = {
          stroke: '#0b1017',
          strokeWidth: Math.max(2, n.r * 0.17),
          strokeLinecap: 'round' as const,
        };
        return (
          <g
            key={n.id}
            className={kids ? 'mapnode branch' : 'mapnode'}
            onClick={(e) => {
              e.stopPropagation();
              if (kids && n.kind !== 'root') onToggle(n.id);
              if (host) onSelect(host);
            }}
            data-testid="trace-node"
            data-kind={n.kind}
            data-kids={kids}
            data-collapsed={n.collapsed ? 'true' : 'false'}
          >
            <title>{traceTitle(n, !!host)}</title>
            {n.collapsed &&
              [2, 1].map((d) => (
                <circle
                  key={d}
                  cx={p.x + STACK_OFFSET * d}
                  cy={p.y - STACK_OFFSET * d}
                  r={n.r}
                  fill={n.color}
                  fillOpacity={0.45}
                  stroke="#0b1017"
                  strokeWidth={1.5}
                />
              ))}
            {selectedIp && host?.ip === selectedIp && (
              <circle
                cx={p.x}
                cy={p.y}
                r={n.r + 7}
                fill="none"
                stroke="#22e8ff"
                strokeWidth={1.5}
              />
            )}
            {status && (
              <circle cx={p.x} cy={p.y} r={n.r + 4} fill="none" stroke={status} strokeWidth={2.5} />
            )}
            <circle cx={p.x} cy={p.y} r={n.r} fill={n.color} stroke="#0b1017" strokeWidth={1.5} />
            {n.collapsed ? (
              <g pointerEvents="none" {...glyph} data-testid="fold-plus">
                <line x1={p.x - arm} y1={p.y} x2={p.x + arm} y2={p.y} />
                <line x1={p.x} y1={p.y - arm} x2={p.x} y2={p.y + arm} />
              </g>
            ) : (
              kids > 0 &&
              n.kind !== 'root' && (
                <g pointerEvents="none" className="foldhint" {...glyph}>
                  <line x1={p.x - arm} y1={p.y} x2={p.x + arm} y2={p.y} />
                </g>
              )
            )}
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
