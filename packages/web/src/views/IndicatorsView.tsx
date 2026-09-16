import { fmtDate, fmtTime, fmtTs, hostName, laneColor } from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { useFilteredEvents, useIocList } from '../lib/selectors';
import { exportIocs } from '../lib/caseActions';
import { HostCell, Tag } from '../components/cells';
import { EmptyState } from './EmptyState';

export function IndicatorsView() {
  const state = useCaseStore((s) => s.state);
  const events = useFilteredEvents();
  const list = useIocList(events);
  const { tz, expanded, toggleExpanded, openModal } = useUiStore();
  if (!list.length) {
    return (
      <EmptyState
        title="No indicators yet"
        body="Indicators you attach to events are collected here, deduplicated, with every place each one was observed."
      >
        <button className="btn pri" onClick={() => openModal({ kind: 'event', id: null })}>
          Add event
        </button>
      </EmptyState>
    );
  }
  return (
    <>
      <div className="toolbar">
        <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: '.14em' }}>
          {list.length} UNIQUE INDICATORS · CLICK TO SEE EVERY SIGHTING
        </span>
        <span className="sp" />
        <button className="btn ghost" onClick={exportIocs}>
          Export indicator list
        </button>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Indicator</th>
            <th>Type</th>
            <th>Hits</th>
            <th>Seen on</th>
            <th>Accounts</th>
            <th>First seen</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {list.map(([k, g]) => {
            const evs = g.events;
            const hostIds = [...new Set(evs.map((e) => e.hostId).filter(Boolean))];
            const users = [...new Set(evs.map((e) => e.user).filter(Boolean))];
            const open = !!expanded['ioc:' + k];
            const first = evs[0]!;
            const last = evs[evs.length - 1]!;
            return (
              <FragmentRow key={k}>
                <tr onClick={() => toggleExpanded('ioc:' + k)} data-testid="ioc-row">
                  <td className="tw">
                    <span className="ind">{g.value}</span>
                  </td>
                  <td>
                    <span className="badge" style={{ color: 'var(--vi)' }}>
                      {g.type || 'unclassified'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'center', color: 'var(--cy)' }}>{evs.length}</td>
                  <td>
                    {hostIds.length
                      ? hostIds.map((id) => (
                          <Tag key={id} color={laneColor(state, id)}>
                            {hostName(state, id)}
                          </Tag>
                        ))
                      : '—'}
                  </td>
                  <td>{users.join(', ') || '—'}</td>
                  <td className="ts">
                    {fmtTime(first, tz)}
                    <small>{fmtDate(first, tz)}</small>
                  </td>
                  <td className="ts">
                    {fmtTime(last, tz)}
                    <small>{fmtDate(last, tz)}</small>
                  </td>
                </tr>
                {open && (
                  <tr className="expand">
                    <td colSpan={7}>
                      {evs.map((e) => (
                        <div
                          key={e.id}
                          style={{
                            display: 'flex',
                            gap: 12,
                            padding: '4px 0',
                            borderBottom: '1px solid rgba(120,200,255,.07)',
                          }}
                        >
                          <span className="ts" style={{ flex: '0 0 150px' }}>
                            {fmtTs(e, tz)}
                          </span>
                          <span style={{ flex: '0 0 130px' }}>
                            <HostCell e={e} state={state} />
                          </span>
                          <span style={{ flex: 1 }}>{e.activity || '—'}</span>
                          {e.link && (
                            <a className="src" href={e.link} target="_blank" rel="noopener">
                              ↗
                            </a>
                          )}
                        </div>
                      ))}
                    </td>
                  </tr>
                )}
              </FragmentRow>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
