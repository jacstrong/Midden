import {
  byId,
  CONFIDENCE,
  hostName,
  laneColor,
  TACTIC_BY_ID,
  techLabel,
  type CaseState,
  type Event,
} from '@midden/core';
import { trunc } from '../lib/format';

const CONF = byId(CONFIDENCE);

export function TacticCell({ e }: { e: Event }) {
  const t = TACTIC_BY_ID[e.tactic];
  if (!t) return <span style={{ color: 'var(--dimmer)' }}>—</span>;
  return (
    <>
      <span className="tac" style={{ color: t.color }}>
        <i style={{ background: t.color }} />
        {t.name}
      </span>
      {e.technique && <div className="tid">{techLabel(e)}</div>}
    </>
  );
}

export function ConfDot({ e }: { e: Event }) {
  const c = CONF[e.conf] ?? CONF.medium;
  return (
    <>
      <span className="dot" style={{ background: c.color, boxShadow: `0 0 8px ${c.color}` }} />
      <span style={{ color: c.color, fontSize: 10, letterSpacing: '.08em' }}>{c.label}</span>
    </>
  );
}

export function IndCell({ e }: { e: Event }) {
  if (!e.indicator) return <span style={{ color: 'var(--dimmer)' }}>—</span>;
  return (
    <span className="ind">
      {e.itype && <span className="t">{e.itype}</span>}
      {trunc(e.indicator, 72)}
    </span>
  );
}

export function HostCell({ e, state }: { e: Event; state: CaseState }) {
  const h = state.hosts[e.hostId];
  if (!h)
    return (
      <span style={{ color: 'var(--dimmer)' }}>{e.hostId ? '(deleted host)' : 'unassigned'}</span>
    );
  return (
    <>
      {e.srcHostId && e.srcHostId !== e.hostId && (
        <span style={{ color: 'var(--mg)' }}>{hostName(state, e.srcHostId)} → </span>
      )}
      <span style={{ color: laneColor(state, h.id) }}>{h.name}</span>
    </>
  );
}

export function Tag({ children, color }: { children: string; color?: string | undefined }) {
  return (
    <span className="tag" style={color ? { color, borderColor: 'currentColor' } : undefined}>
      {children}
    </span>
  );
}
