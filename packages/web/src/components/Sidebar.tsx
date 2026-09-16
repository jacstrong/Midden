import { useEffect, useState } from 'react';
import { CONFIDENCE, distinctUsers, humanSpan, TACTICS, type TzMode } from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { useSortedEvents, useTotals } from '../lib/selectors';

export function Sidebar() {
  const hosts = useCaseStore((s) => s.state.hosts);
  const fileBased = useCaseStore((s) => s.capabilities.fileBased);
  const totals = useTotals();
  const sorted = useSortedEvents();
  const { filters, setFilters, clearFilters, toggleConf, toggleFlag, tz, setTz } = useUiStore();
  const [q, setQ] = useState(filters.q);
  const [seenQ, setSeenQ] = useState(filters.q);
  if (seenQ !== filters.q) {
    setSeenQ(filters.q);
    setQ(filters.q);
  }
  useEffect(() => {
    if (q === filters.q) return;
    const t = setTimeout(() => setFilters({ q }), 180);
    return () => clearTimeout(t);
  }, [q, filters.q, setFilters]);

  return (
    <aside className="sidebar" id="sidebar">
      <div>
        <div className="sbtitle">Case totals</div>
        <div className="stats">
          <div className="stat acc">
            <b data-testid="st-events">{totals.events}</b>
            <span>Events</span>
          </div>
          <div className="stat">
            <b data-testid="st-hosts">{totals.hosts}</b>
            <span>Hosts</span>
          </div>
          <div className="stat warn">
            <b>{totals.compromised}</b>
            <span>Compromised</span>
          </div>
          <div className="stat">
            <b>{totals.indicators}</b>
            <span>Indicators</span>
          </div>
        </div>
        <div className="stat" style={{ marginTop: 6 }}>
          <b style={{ fontSize: 12 }}>
            {totals.spanMs !== null
              ? humanSpan(totals.spanMs)
              : totals.events
                ? 'single event'
                : '—'}
          </b>
          <span>Dwell / span</span>
        </div>
      </div>

      <div>
        <div className="sbtitle">Filters</div>
        <div className="field">
          <label htmlFor="fSearch">Search</label>
          <input
            type="text"
            id="fSearch"
            placeholder="indicator, command, user…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="hint">
            Press <kbd>/</kbd> to jump here
          </div>
        </div>
        <div className="field">
          <label htmlFor="fHost">Host</label>
          <select
            id="fHost"
            value={filters.host}
            onChange={(e) => setFilters({ host: e.target.value })}
          >
            <option value="">All hosts</option>
            {Object.values(hosts).map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fUser">Account</label>
          <select
            id="fUser"
            value={filters.user}
            onChange={(e) => setFilters({ user: e.target.value })}
          >
            <option value="">All accounts</option>
            {distinctUsers(sorted).map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fTactic">Tactic</label>
          <select
            id="fTactic"
            value={filters.tactic}
            onChange={(e) => setFilters({ tactic: e.target.value })}
          >
            <option value="">All tactics</option>
            {TACTICS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Confidence</label>
          <div className="chiprow">
            {CONFIDENCE.map((c) => (
              <span
                key={c.id}
                className={'fchip' + (filters.conf.includes(c.id) ? ' on' : '')}
                style={{ '--c': c.color } as React.CSSProperties}
                onClick={() => toggleConf(c.id)}
              >
                {c.label}
              </span>
            ))}
          </div>
        </div>
        <div className="field">
          <label>Show only</label>
          <div className="chiprow">
            {(
              [
                ['key', 'Key events'],
                ['pivot', 'Host pivots'],
                ['linked', 'Has source link'],
              ] as const
            ).map(([flag, label]) => (
              <span
                key={flag}
                className={'fchip' + (filters.flags.includes(flag) ? ' on' : '')}
                onClick={() => toggleFlag(flag)}
              >
                {label}
              </span>
            ))}
          </div>
        </div>
        <div className="grid2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div className="field">
            <label htmlFor="fFrom">From</label>
            <input
              type="text"
              id="fFrom"
              placeholder="YYYY-MM-DD"
              value={filters.from}
              onChange={(e) => setFilters({ from: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="fTo">To</label>
            <input
              type="text"
              id="fTo"
              placeholder="YYYY-MM-DD"
              value={filters.to}
              onChange={(e) => setFilters({ to: e.target.value })}
            />
          </div>
        </div>
        <button
          className="btn ghost"
          style={{ width: '100%' }}
          onClick={clearFilters}
          data-testid="clear-filters"
        >
          Clear filters
        </button>
      </div>

      <div>
        <div className="sbtitle">Display</div>
        <div className="field">
          <label htmlFor="fTz">Timestamps shown in</label>
          <select id="fTz" value={tz} onChange={(e) => setTz(e.target.value as TzMode)}>
            <option value="utc">UTC</option>
            <option value="local">Local (this browser)</option>
            <option value="source">Source timezone</option>
          </select>
        </div>
      </div>

      <div
        style={{
          marginTop: 'auto',
          color: 'var(--dimmer)',
          fontSize: 9.5,
          lineHeight: 1.8,
          letterSpacing: '.05em',
        }}
      >
        {fileBased
          ? 'Runs entirely in this file — nothing leaves the browser.'
          : 'Live case — changes are shared as you make them.'}
        <br />
        <kbd>N</kbd> event · <kbd>H</kbd> host · <kbd>/</kbd> search · <kbd>Esc</kbd> close
      </div>
    </aside>
  );
}
