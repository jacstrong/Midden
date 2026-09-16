import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { byId, fmtDate, fmtTime, fmtTs, hostLabel, offsetLabel, SEVERITY } from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { useFilteredEvents } from '../lib/selectors';
import { exportCsv } from '../lib/caseActions';
import { trunc } from '../lib/format';
import { ConfDot, HostCell, IndCell, TacticCell, Tag } from '../components/cells';
import { EmptyState } from './EmptyState';

const SEV = byId(SEVERITY);
const HEAD = ['', 'Time', 'Host', 'Account', 'Tactic', 'Activity', 'Indicator', 'Confidence', ''];

export function TimelineView({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const state = useCaseStore((s) => s.state);
  const events = useFilteredEvents();
  const { tz, sel, select, expanded, toggleExpanded, setExpandedAll, openModal } = useUiStore();
  const total = Object.keys(state.events).length;
  const anyExpanded = Object.keys(expanded).length > 0;
  const listRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (expanded[events[i]!.id] ? 220 : 58),
    overscan: 12,
    scrollMargin: listRef.current?.offsetTop ?? 0,
    getItemKey: (i) => events[i]!.id,
  });

  return (
    <>
      <div className="toolbar">
        <button className="btn pri" onClick={() => openModal({ kind: 'event', id: null })}>
          + Add event
        </button>
        <div className="seg">
          <button
            className={anyExpanded ? 'on' : ''}
            onClick={() => setExpandedAll(events.map((e) => e.id))}
          >
            Expand all
          </button>
          <button className={anyExpanded ? '' : 'on'} onClick={() => setExpandedAll(null)}>
            Collapse
          </button>
        </div>
        <span className="sp" />
        <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: '.14em' }}>
          {events.length} OF {total} EVENTS
        </span>
        <button className="btn ghost" onClick={exportCsv}>
          Export .csv
        </button>
      </div>
      {!events.length ? (
        <EmptyState
          title="No events match"
          body="Adjust the filters, or add the first observation to start building the timeline."
        >
          <button className="btn pri" onClick={() => openModal({ kind: 'event', id: null })}>
            Add event
          </button>
        </EmptyState>
      ) : (
        <div ref={listRef}>
          <div className="vhead tl-cols">
            {HEAD.map((h, i) => (
              <div key={i}>{h}</div>
            ))}
          </div>
          <div
            className="vlist"
            style={{ height: virtualizer.getTotalSize() }}
            data-testid="timeline-list"
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const e = events[vi.index]!;
              const open = !!expanded[e.id];
              return (
                <div
                  key={vi.key}
                  ref={virtualizer.measureElement}
                  data-index={vi.index}
                  className={'vrow tl-cols' + (sel === e.id ? ' sel' : '') + (e.key ? ' key' : '')}
                  style={{
                    transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
                  }}
                  onClick={(ev) => {
                    if ((ev.target as HTMLElement).closest('a,button')) return;
                    toggleExpanded(e.id);
                    if (sel !== e.id) select(e.id);
                  }}
                  onDoubleClick={(ev) => {
                    if ((ev.target as HTMLElement).closest('a,button')) return;
                    openModal({ kind: 'event', id: e.id });
                  }}
                  data-testid="timeline-row"
                >
                  <div className="num">{vi.index + 1}</div>
                  <div className="ts">
                    {fmtTime(e, tz)}
                    <small>
                      {fmtDate(e, tz)}
                      {tz === 'source' ? ' ' + offsetLabel(+e.off || 0) : ''}
                    </small>
                  </div>
                  <div>
                    <HostCell e={e} state={state} />
                  </div>
                  <div>
                    <span className="usr">{e.user || '—'}</span>
                    {e.priv && <div className="prv">{e.priv}</div>}
                  </div>
                  <div>
                    <TacticCell e={e} />
                  </div>
                  <div className="tw">
                    <div className="wrap">{e.activity || '—'}</div>
                    {e.cmd && !open && (
                      <div className="tid" style={{ color: 'var(--vi)' }}>
                        {trunc(e.cmd.replace(/\s+/g, ' '), 64)}
                      </div>
                    )}
                  </div>
                  <div className="tw">
                    <IndCell e={e} />
                  </div>
                  <div>
                    <ConfDot e={e} />
                  </div>
                  <div style={{ whiteSpace: 'nowrap' }}>
                    {e.link && (
                      <a
                        className="src"
                        href={e.link}
                        target="_blank"
                        rel="noopener"
                        title="Open source record"
                      >
                        ↗{' '}
                      </a>
                    )}
                    <button
                      className="btn sm ghost"
                      onClick={() => openModal({ kind: 'event', id: e.id })}
                    >
                      Edit
                    </button>
                  </div>
                  {open && (
                    <div className="expandbody" onClick={(ev) => ev.stopPropagation()}>
                      <dl className="kv">
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
                        <dt>Timestamp</dt>
                        <dd>
                          {fmtTs(e, tz, true)} · raw <code>{e.ts}</code>
                        </dd>
                        {e.source && (
                          <>
                            <dt>Source</dt>
                            <dd>{e.source}</dd>
                          </>
                        )}
                        {e.link && (
                          <>
                            <dt>Link</dt>
                            <dd>
                              <a className="src" href={e.link} target="_blank" rel="noopener">
                                {trunc(e.link, 110)}
                              </a>
                            </dd>
                          </>
                        )}
                        {e.evidence && (
                          <>
                            <dt>Evidence</dt>
                            <dd>{e.evidence}</dd>
                          </>
                        )}
                        {e.srcHostId && (
                          <>
                            <dt>Pivot</dt>
                            <dd style={{ color: 'var(--mg)' }}>
                              {hostLabel(state, e.srcHostId)} → {hostLabel(state, e.hostId)}
                            </dd>
                          </>
                        )}
                        <dt>Severity</dt>
                        <dd style={{ color: SEV[e.sev]?.color ?? 'var(--dim)' }}>
                          {SEV[e.sev]?.label ?? '—'}
                        </dd>
                        {e.tags.length > 0 && (
                          <>
                            <dt>Tags</dt>
                            <dd>
                              {e.tags.map((t) => (
                                <Tag key={t}>{t}</Tag>
                              ))}
                            </dd>
                          </>
                        )}
                      </dl>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
