import { useState } from 'react';
import {
  browserOffset,
  byId,
  CONFIDENCE,
  fmtParts,
  fmtTs,
  HOST_STATUS,
  hostAgg,
  hostName,
  humanSpan,
  offsetLabel,
  reportModel,
  TACTIC_BY_ID,
} from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { exportCsv, exportMd } from '../lib/caseActions';
import { trunc } from '../lib/format';
import { EmptyState } from './EmptyState';

const CONF = byId(CONFIDENCE);
const HS = byId(HOST_STATUS);

export function ReportView() {
  const state = useCaseStore((s) => s.state);
  const { tz, openModal } = useUiStore();
  const [now] = useState(() => Date.now());
  const c = state.case;
  const m = reportModel(state);
  const hosts = Object.values(state.hosts);
  if (!m.events.length && !hosts.length) {
    return (
      <EmptyState
        title="Nothing to report yet"
        body="The report assembles itself from the hosts and events you record. Add something to the timeline first."
      >
        <button className="btn pri" onClick={() => openModal({ kind: 'event', id: null })}>
          Add event
        </button>
      </EmptyState>
    );
  }
  const genOff = tz === 'local' ? browserOffset() : 0;
  const gen = fmtParts(now, genOff);
  const utc = (ep: number): string => {
    const p = fmtParts(ep, 0);
    return p.date + ' ' + p.time;
  };
  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={() => openModal({ kind: 'case' })}>
          Edit case details
        </button>
        <span className="sp" />
        <button className="btn ghost" onClick={exportMd}>
          Download .md
        </button>
        <button className="btn ghost" onClick={exportCsv}>
          Download .csv
        </button>
        <button className="btn ghost" onClick={() => window.print()}>
          Print
        </button>
      </div>
      <div className="report" data-testid="report">
        <h1>
          {c.name || 'Untitled investigation'}
          {c.number ? ` · ${c.number}` : ''}
        </h1>
        <p
          style={{
            color: 'var(--dim)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '.08em',
          }}
        >
          {[
            c.classification,
            c.analyst ? `Lead: ${c.analyst}` : '',
            `Generated ${gen.date} ${gen.time} ${tz === 'local' ? offsetLabel(genOff) : 'UTC'}`,
          ]
            .filter(Boolean)
            .join('  ·  ')}
        </p>
        <h2>Summary</h2>
        {c.summary ? (
          <p style={{ whiteSpace: 'pre-line' }}>{c.summary}</p>
        ) : (
          <p style={{ color: 'var(--dim)' }}>
            <i>No summary written yet — use “Edit case details”.</i>
          </p>
        )}
        <ul>
          <li>
            <b>{m.events.length}</b> events recorded across <b>{hosts.length}</b> hosts.
          </li>
          {m.first && (
            <li>
              Earliest observed activity <code>{fmtTs(m.first, tz, true)}</code> on{' '}
              <b>{hostName(state, m.first.hostId)}</b>
              {m.first.activity ? ` — ${m.first.activity}` : ''}.
            </li>
          )}
          {m.last && m.spanMs !== null && (
            <li>
              Latest observed activity <code>{fmtTs(m.last, tz, true)}</code>, an observed span of{' '}
              <b>{humanSpan(m.spanMs)}</b>.
            </li>
          )}
          {m.compromised.length > 0 && (
            <li>
              Confirmed compromised:{' '}
              {m.compromised.map((n, i) => (
                <span key={n}>
                  {i > 0 && ', '}
                  <b>{n}</b>
                </span>
              ))}
              .
            </li>
          )}
          <li>
            <b>{Object.keys(m.techniques).length}</b> distinct ATT&CK techniques and{' '}
            <b>{Object.keys(m.iocs).length}</b> unique indicators.
          </li>
        </ul>
        {m.keyEvents.length > 0 && (
          <>
            <h2>Key events</h2>
            <ul>
              {m.keyEvents.map((e) => (
                <li key={e.id}>
                  <code>{fmtTs(e, tz)}</code> — <b>{hostName(state, e.hostId)}</b> ·{' '}
                  {e.activity || e.indicator || ''}
                  {e.technique && <span style={{ color: 'var(--dim)' }}> ({e.technique})</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        {hosts.length > 0 && (
          <>
            <h2>Affected systems</h2>
            <table>
              <thead>
                <tr>
                  <th>Host</th>
                  <th>Address</th>
                  <th>Function</th>
                  <th>Status</th>
                  <th>Events</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {hosts.map((h) => {
                  const a = hostAgg(state, h.id, m.events);
                  const st = HS[h.status] ?? HS.unknown;
                  return (
                    <tr key={h.id}>
                      <td>
                        <b>{h.name}</b>
                      </td>
                      <td>{h.ip || '—'}</td>
                      <td>{h.role || '—'}</td>
                      <td style={{ color: st.color }}>{st.label}</td>
                      <td>{a.count}</td>
                      <td>{a.first !== null ? utc(a.first) : '—'}</td>
                      <td>{a.last !== null ? utc(a.last) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
        <h2>Timeline</h2>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Host</th>
              <th>Account</th>
              <th>Technique</th>
              <th>Activity</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {m.events.map((e) => (
              <tr key={e.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtTs(e, tz)}</td>
                <td>
                  {hostName(state, e.hostId)}
                  {e.srcHostId && (
                    <>
                      <br />
                      <span style={{ color: 'var(--mg)' }}>← {hostName(state, e.srcHostId)}</span>
                    </>
                  )}
                </td>
                <td>
                  {e.user || '—'}
                  {e.priv && (
                    <>
                      <br />
                      <span style={{ color: 'var(--rd)' }}>{e.priv}</span>
                    </>
                  )}
                </td>
                <td>
                  {e.technique || '—'}
                  {e.tactic && TACTIC_BY_ID[e.tactic] && (
                    <>
                      <br />
                      <span style={{ color: TACTIC_BY_ID[e.tactic]!.color }}>
                        {TACTIC_BY_ID[e.tactic]!.name}
                      </span>
                    </>
                  )}
                </td>
                <td>
                  {e.activity || '—'}
                  {e.cmd && (
                    <>
                      <br />
                      <code>{trunc(e.cmd.replace(/\s+/g, ' '), 120)}</code>
                    </>
                  )}
                </td>
                <td>{CONF[e.conf]?.label ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {Object.keys(m.iocs).length > 0 && (
          <>
            <h2>Indicators of compromise</h2>
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Indicator</th>
                  <th>Sightings</th>
                  <th>Hosts</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(m.iocs)
                  .sort((a, b) => m.iocs[b]!.events.length - m.iocs[a]!.events.length)
                  .map((k) => {
                    const g = m.iocs[k]!;
                    const hs = [...new Set(g.events.map((e) => e.hostId).filter(Boolean))];
                    return (
                      <tr key={k}>
                        <td>{g.type || '—'}</td>
                        <td>{g.value}</td>
                        <td>{g.events.length}</td>
                        <td>{hs.map((id) => hostName(state, id)).join(', ')}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </>
  );
}
