import {
  browserOffset,
  byId,
  fmtParts,
  HOST_STATUS,
  hostAgg,
  humanSpan,
  laneColor,
  TACTIC_BY_ID,
} from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { useSortedEvents } from '../lib/selectors';
import { trunc } from '../lib/format';
import { Tag } from '../components/cells';
import { EmptyState } from './EmptyState';

const HS = byId(HOST_STATUS);

export function HostsView() {
  const state = useCaseStore((s) => s.state);
  const sorted = useSortedEvents();
  const { tz, openModal } = useUiStore();
  const hosts = Object.values(state.hosts);
  if (!hosts.length) {
    return (
      <EmptyState
        title="No hosts recorded"
        body="Add the systems involved in the intrusion. Every event you log can be attached to a host, and each host gets its own lane in the branch graph."
      >
        <button className="btn pri" onClick={() => openModal({ kind: 'host', id: null })}>
          Add host
        </button>
      </EmptyState>
    );
  }
  const off = (ep: number): number => (tz === 'local' ? browserOffset(ep) : 0);
  return (
    <>
      <div className="toolbar">
        <button className="btn pri" onClick={() => openModal({ kind: 'host', id: null })}>
          + Add host
        </button>
        <span className="sp" />
        <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: '.14em' }}>
          CLICK A CARD TO EDIT
        </span>
      </div>
      <div className="hostgrid">
        {hosts.map((h) => {
          const a = hostAgg(state, h.id, sorted);
          const st = HS[h.status] ?? HS.unknown;
          const lc = laneColor(state, h.id);
          return (
            <div
              key={h.id}
              className="hcard"
              style={{ borderLeft: `2px solid ${lc}` }}
              onClick={() => openModal({ kind: 'host', id: h.id })}
              data-testid="host-card"
            >
              <div className="statusflag" style={{ background: st.color }}>
                {st.label}
              </div>
              <h4>{h.name}</h4>
              <div className="ipl">{h.ip || 'no address recorded'}</div>
              <div className="meta">
                {[h.os, h.role, h.zone].filter(Boolean).join(' · ') || '—'}
              </div>
              <div className="bar">
                {a.tactics.length ? (
                  a.tactics.map((t) => (
                    <i key={t} style={{ background: TACTIC_BY_ID[t]?.color, flex: 1 }} />
                  ))
                ) : (
                  <i style={{ background: '#111b2c', flex: 1 }} />
                )}
              </div>
              <div className="hstats">
                <div>
                  <b>{a.count}</b>
                  <span>Events</span>
                </div>
                <div>
                  <b>{a.users.length}</b>
                  <span>Accounts</span>
                </div>
                <div>
                  <b>{a.iocs}</b>
                  <span>Indicators</span>
                </div>
              </div>
              <div className="meta" style={{ marginTop: 9 }}>
                {a.first !== null
                  ? `First activity ${fmtParts(a.first, off(a.first)).date} ${fmtParts(a.first, off(a.first)).time}`
                  : 'No activity logged'}
                {a.first !== null && a.last !== null && a.last !== a.first && (
                  <>
                    <br />
                    Active for {humanSpan(a.last - a.first)}
                  </>
                )}
                {a.outbound > 0 && (
                  <>
                    <br />
                    <span style={{ color: 'var(--mg)' }}>{a.outbound} outbound pivot(s)</span>
                  </>
                )}
              </div>
              {a.users.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {a.users.slice(0, 4).map((u) => (
                    <span
                      key={u}
                      className="tag"
                      style={{ color: 'var(--gr)', borderColor: 'rgba(77,255,154,.35)' }}
                    >
                      {u}
                    </span>
                  ))}
                  {a.users.length > 4 && <span className="tag">+{a.users.length - 4}</span>}
                </div>
              )}
              {h.tags.length > 0 && (
                <div style={{ marginTop: 5 }}>
                  {h.tags.map((t) => (
                    <Tag key={t}>{t}</Tag>
                  ))}
                </div>
              )}
              {h.notes && (
                <div className="meta" style={{ marginTop: 8, color: 'var(--dimmer)' }}>
                  {trunc(h.notes, 150)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
