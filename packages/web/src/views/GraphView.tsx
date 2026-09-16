import { useMemo } from 'react';
import {
  byId,
  CONFIDENCE,
  hostLabel,
  hostName,
  layoutBranchGraph,
  SEVERITY,
  TACTIC_BY_ID,
  techLabel,
  fmtTime,
  fmtTs,
  tzLabel,
} from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { useFilteredEvents, useSelectedEvent } from '../lib/selectors';
import { loadDemo } from '../lib/caseActions';
import { trunc } from '../lib/format';
import { EmptyState } from './EmptyState';
import { Tag } from '../components/cells';

const CONF = byId(CONFIDENCE);
const SEV = byId(SEVERITY);

export function GraphView() {
  const state = useCaseStore((s) => s.state);
  const events = useFilteredEvents();
  const { tz, gmode, setGmode, laneAll, setLaneAll, sel, select, openModal, clearFilters } =
    useUiStore();
  const total = Object.keys(state.events).length;
  const layout = useMemo(
    () =>
      layoutBranchGraph(
        state,
        events,
        { mode: gmode, tz, laneAll, selectedId: sel },
        (e) => TACTIC_BY_ID[e.tactic]?.color ?? null,
      ),
    [state, events, gmode, tz, laneAll, sel],
  );

  const bar = (
    <div className="toolbar" style={{ padding: '12px 14px 0', marginBottom: 8 }}>
      <button className="btn pri" onClick={() => openModal({ kind: 'event', id: null })}>
        + Add event
      </button>
      <div className="seg">
        <button className={gmode === 'seq' ? 'on' : ''} onClick={() => setGmode('seq')}>
          Sequence
        </button>
        <button className={gmode === 'time' ? 'on' : ''} onClick={() => setGmode('time')}>
          Time-scaled
        </button>
      </div>
      <label className="ck" style={{ marginLeft: 4 }}>
        <input type="checkbox" checked={laneAll} onChange={(e) => setLaneAll(e.target.checked)} />{' '}
        Show every host lane
      </label>
      <span className="sp" />
      <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: '.14em' }}>
        {events.length} EVENTS · {tzLabel(tz)}
      </span>
    </div>
  );

  if (!events.length) {
    return (
      <>
        {bar}
        {total ? (
          <EmptyState
            title="Nothing matches these filters"
            body={`All ${total} events are filtered out. Widen the filters to bring the graph back.`}
          >
            <button className="btn pri" onClick={clearFilters}>
              Clear filters
            </button>
          </EmptyState>
        ) : (
          <div className="empty" style={{ minHeight: '62vh' }}>
            <b>No investigation loaded</b>
            <p>
              Events assemble here as one lane per host, ordered by when the attacker first reached
              each system, with a branch drawn wherever activity pivoted from one host to another.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button className="btn pri" onClick={() => openModal({ kind: 'event', id: null })}>
                Add first event
              </button>
              <button className="btn" onClick={() => openModal({ kind: 'host', id: null })}>
                Add a host
              </button>
              <button className="btn ghost" onClick={loadDemo} data-testid="load-demo">
                Load example case
              </button>
            </div>
            <p style={{ color: 'var(--dimmer)' }}>
              The example walks a phishing-to-ransomware intrusion across five hosts — a quick way
              to see how the graph, indicators and report fit together.
            </p>
          </div>
        )}
      </>
    );
  }

  const used = new Set(events.map((e) => e.tactic).filter(Boolean));
  const { lanes, nodes, pivots, breaks, rowsY, width, height } = layout;

  return (
    <>
      {bar}
      <div style={{ minWidth: width + 560 }}>
        <div className="lanehead" style={{ height: 120 }}>
          {lanes.map((l) => (
            <div key={l.key}>
              <div
                className="lanelbl"
                title={l.meta.name + (l.meta.ip ? ' · ' + l.meta.ip : '')}
                style={{ left: l.x + 4, color: l.meta.color }}
              >
                <b>{trunc(l.meta.name, 20)}</b>
                {l.meta.ip && <s>{l.meta.ip}</s>}
              </div>
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: l.x - 3,
                  width: 6,
                  height: 6,
                  background: l.meta.color,
                }}
              />
            </div>
          ))}
        </div>
        <div className="gbody" style={{ height }}>
          <div className="seps">
            {breaks.map((b) => (
              <div key={b.label}>
                <div className="daysep" style={{ top: b.y }} />
                <div className="daylbl" style={{ top: b.y - 7, left: width + 10 }}>
                  {b.label}
                </div>
              </div>
            ))}
          </div>
          <svg className="gsvg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
            <defs>
              <marker
                id="mArrow"
                viewBox="0 0 8 8"
                refX="6"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto"
              >
                <path d="M0,0 L8,4 L0,8 z" fill="#ff2e88" />
              </marker>
            </defs>
            {lanes.map((l) => (
              <line
                key={'g' + l.key}
                x1={l.x}
                y1={0}
                x2={l.x}
                y2={height}
                stroke={l.meta.color}
                strokeOpacity={0.09}
                strokeWidth={1}
              />
            ))}
            {lanes.map(
              (l) =>
                l.spine && (
                  <g key={'s' + l.key}>
                    <line
                      x1={l.x}
                      y1={l.spine[0]}
                      x2={l.x}
                      y2={l.spine[1]}
                      stroke={l.meta.color}
                      strokeOpacity={0.18}
                      strokeWidth={7}
                      strokeLinecap="round"
                    />
                    <line
                      x1={l.x}
                      y1={l.spine[0]}
                      x2={l.x}
                      y2={l.spine[1]}
                      stroke={l.meta.color}
                      strokeOpacity={0.85}
                      strokeWidth={1.6}
                    />
                    <circle
                      cx={l.x}
                      cy={l.spine[0] - 14}
                      r={2.5}
                      fill={l.meta.color}
                      fillOpacity={0.8}
                    />
                    <line
                      x1={l.x - 4}
                      y1={l.spine[1] + 13}
                      x2={l.x + 4}
                      y2={l.spine[1] + 13}
                      stroke={l.meta.color}
                      strokeOpacity={0.6}
                      strokeWidth={1.6}
                    />
                  </g>
                ),
            )}
            {pivots.map((p) => (
              <g key={'p' + p.eventId}>
                <path
                  d={`M${p.from.x},${p.from.y} C${p.c1.x},${p.c1.y} ${p.c2.x},${p.c2.y} ${p.to.x},${p.to.y}`}
                  fill="none"
                  stroke="#ff2e88"
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  strokeOpacity={0.9}
                  markerEnd="url(#mArrow)"
                />
                <circle cx={p.from.x} cy={p.from.y} r={3} fill="#ff2e88" />
              </g>
            ))}
            {nodes.map((n) => (
              <g key={n.event.id} data-testid="graph-node">
                {n.selected && (
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={n.r + 7}
                    fill="none"
                    stroke="#22e8ff"
                    strokeWidth={1.2}
                    strokeOpacity={0.9}
                  />
                )}
                {n.event.key && (
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={n.r + 4}
                    fill="none"
                    stroke="#ffb020"
                    strokeWidth={1.2}
                    strokeDasharray="2 3"
                  />
                )}
                <circle cx={n.x} cy={n.y} r={n.r + 3} fill={n.fill} fillOpacity={0.22} />
                <circle cx={n.x} cy={n.y} r={n.r} fill={n.fill} stroke={n.stroke} strokeWidth={2} />
                <circle
                  className="hit"
                  cx={n.x}
                  cy={n.y}
                  r={15}
                  fill="transparent"
                  onClick={() => select(n.event.id)}
                >
                  <title>{`${fmtTs(n.event, tz, true)}\n${hostName(state, n.event.hostId)}${n.event.user ? '  ·  ' + n.event.user : ''}\n${n.event.activity || n.event.indicator || ''}`}</title>
                </circle>
              </g>
            ))}
          </svg>
          <div className="rows" style={{ marginLeft: width, height, minWidth: 520 }}>
            {events.map((e, i) => {
              const t = TACTIC_BY_ID[e.tactic];
              return (
                <div
                  key={e.id}
                  className={'grow' + (sel === e.id ? ' sel' : '')}
                  style={{ top: rowsY[i]! - 17 }}
                  onClick={() => select(e.id)}
                  onDoubleClick={() => openModal({ kind: 'event', id: e.id })}
                  data-testid="graph-row"
                >
                  <span className="gt">{fmtTime(e, tz)}</span>
                  {t && (
                    <span className="badge" style={{ color: t.color, fontSize: 9 }}>
                      {t.short}
                    </span>
                  )}
                  <span className="ga">{e.activity || e.indicator || '(no description)'}</span>
                  {e.user && <span className="gu">{trunc(e.user, 26)}</span>}
                  {e.indicator && e.activity && <span className="gi">{e.indicator}</span>}
                  {e.link && (
                    <a
                      className="src"
                      href={e.link}
                      target="_blank"
                      rel="noopener"
                      title="Open source record"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      ↗
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <Inspector />
      <div className="legend">
        {[...used].map((id) => (
          <span key={id} className="li">
            <i
              style={{
                width: 9,
                height: 9,
                background: TACTIC_BY_ID[id]?.color,
                display: 'block',
                transform: 'rotate(45deg)',
              }}
            />
            {TACTIC_BY_ID[id]?.name}
          </span>
        ))}
        <span className="li" style={{ color: 'var(--mg)' }}>
          <svg width="26" height="8">
            <line
              x1="0"
              y1="4"
              x2="26"
              y2="4"
              stroke="#ff2e88"
              strokeWidth="1.5"
              strokeDasharray="5 3"
            />
          </svg>
          Pivot between hosts
        </span>
        <span className="li" style={{ color: 'var(--am)' }}>
          ◌ Key event
        </span>
      </div>
    </>
  );
}

function Inspector() {
  const e = useSelectedEvent();
  const state = useCaseStore((s) => s.state);
  const { tz, select, openModal } = useUiStore();
  if (!e) return null;
  const t = TACTIC_BY_ID[e.tactic];
  const c = CONF[e.conf];
  const s = SEV[e.sev];
  return (
    <div className="inspector" data-testid="inspector">
      <div className="ihead">
        {t && (
          <span className="tac" style={{ color: t.color }}>
            <i style={{ background: t.color }} />
            {t.short}
          </span>
        )}
        <b>{e.activity || e.indicator || 'Event'}</b>
        <span className="sp" />
        <span style={{ color: c?.color ?? 'var(--dim)', fontSize: 10, letterSpacing: '.1em' }}>
          {c?.label ?? ''}
        </span>
        <button className="btn sm" onClick={() => openModal({ kind: 'event', id: e.id })}>
          Edit
        </button>
        <button className="btn sm ghost" onClick={() => select(e.id)}>
          ✕
        </button>
      </div>
      <dl className="kv">
        <dt>Time</dt>
        <dd>{fmtTs(e, tz, true)}</dd>
        <dt>Host</dt>
        <dd>
          {hostLabel(state, e.hostId)}
          {e.srcHostId && (
            <span style={{ color: 'var(--mg)' }}> ← pivot from {hostName(state, e.srcHostId)}</span>
          )}
        </dd>
        {e.user && (
          <>
            <dt>Account</dt>
            <dd>
              <span className="usr">{e.user}</span>
              {e.priv && <span className="prv"> · {e.priv}</span>}
            </dd>
          </>
        )}
        {e.technique && (
          <>
            <dt>Technique</dt>
            <dd>{techLabel(e)}</dd>
          </>
        )}
        {e.indicator && (
          <>
            <dt>Indicator</dt>
            <dd className="ind">
              {e.itype && <span className="t">{e.itype}</span>}
              {e.indicator}
            </dd>
          </>
        )}
        {e.cmd && (
          <>
            <dt>Command</dt>
            <dd>
              <code className="cmd">{e.cmd}</code>
            </dd>
          </>
        )}
        {e.notes && (
          <>
            <dt>Notes</dt>
            <dd className="wrap">{e.notes}</dd>
          </>
        )}
        {(e.source || e.link) && (
          <>
            <dt>Source</dt>
            <dd>
              {e.source}
              {e.link && (
                <>
                  {' '}
                  <a className="src" href={e.link} target="_blank" rel="noopener">
                    open record ↗
                  </a>
                </>
              )}
            </dd>
          </>
        )}
        {e.evidence && (
          <>
            <dt>Evidence</dt>
            <dd>{e.evidence}</dd>
          </>
        )}
        {s && (
          <>
            <dt>Severity</dt>
            <dd style={{ color: s.color }}>{s.label}</dd>
          </>
        )}
        {e.tags.length > 0 && (
          <>
            <dt>Tags</dt>
            <dd>
              {e.tags.map((x) => (
                <Tag key={x}>{x}</Tag>
              ))}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
