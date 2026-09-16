/** Derived views over case state, ported from the prototype: filtering, indicator index, host aggregates, lanes. */
import type { CaseState, Event, Host } from '../domain/types.js';
import { LANE_COLORS, TACTIC_BY_ID, TECHNIQUE_NAME } from '../domain/reference.js';
import { parseTimestamp, toEpoch } from '../time/time.js';
import { sortedEvents } from '../codec/casefile.js';

export interface Filters {
  q: string;
  host: string;
  user: string;
  tactic: string;
  conf: string[];
  flags: Array<'key' | 'pivot' | 'linked'>;
  from: string;
  to: string;
}

export function defaultFilters(): Filters {
  return { q: '', host: '', user: '', tactic: '', conf: [], flags: [], from: '', to: '' };
}

export function isFilterActive(f: Filters): boolean {
  return !!(
    f.q ||
    f.host ||
    f.user ||
    f.tactic ||
    f.conf.length ||
    f.flags.length ||
    f.from ||
    f.to
  );
}

export function hostName(state: CaseState, id: string): string {
  return state.hosts[id]?.name ?? (id ? '(deleted host)' : '—');
}

export function hostLabel(state: CaseState, id: string): string {
  const h = state.hosts[id];
  if (!h) return id ? '(deleted host)' : '—';
  return h.name + (h.ip ? ' · ' + h.ip : '');
}

/** Stable colour per host, by insertion order (as the prototype did by array index). */
export function laneColor(state: CaseState, id: string): string {
  const i = Object.keys(state.hosts).indexOf(id);
  return LANE_COLORS[(i < 0 ? 0 : i) % LANE_COLORS.length]!;
}

export function techLabel(ev: Pick<Event, 'technique'>): string {
  if (!ev.technique) return '';
  const n = TECHNIQUE_NAME[ev.technique];
  return ev.technique + (n ? ' ' + n : '');
}

export function isPivot(ev: Pick<Event, 'hostId' | 'srcHostId'>): boolean {
  return !!ev.srcHostId && ev.srcHostId !== ev.hostId;
}

/** Events in timeline order that pass the filters. */
export function filterEvents(
  state: CaseState,
  f: Filters,
  events: Event[] = sortedEvents(state),
): Event[] {
  const q = f.q.trim().toLowerCase();
  const from = f.from ? toEpochOrNaN(parseTimestamp(f.from, 0)) : NaN;
  const to = f.to
    ? toEpochOrNaN(parseTimestamp(f.to.length <= 10 ? f.to + ' 23:59:59' : f.to, 0))
    : NaN;
  return events.filter((e) => {
    if (f.host && e.hostId !== f.host && e.srcHostId !== f.host) return false;
    if (f.user && (e.user || '') !== f.user) return false;
    if (f.tactic && e.tactic !== f.tactic) return false;
    if (f.conf.length && !f.conf.includes(e.conf || '')) return false;
    if (f.flags.includes('key') && !e.key) return false;
    if (f.flags.includes('pivot') && !isPivot(e)) return false;
    if (f.flags.includes('linked') && !e.link) return false;
    const ep = toEpoch(e.ts);
    if (!Number.isNaN(from) && ep < from) return false;
    if (!Number.isNaN(to) && ep > to) return false;
    if (q) {
      const hay = [
        e.indicator,
        e.itype,
        e.activity,
        e.cmd,
        e.user,
        e.priv,
        e.notes,
        e.source,
        e.evidence,
        e.technique,
        TECHNIQUE_NAME[e.technique],
        hostName(state, e.hostId),
        hostName(state, e.srcHostId),
        e.tags.join(' '),
        TACTIC_BY_ID[e.tactic]?.name,
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function toEpochOrNaN(iso: string | null): number {
  return iso ? Date.parse(iso) : NaN;
}

export interface IocGroup {
  value: string;
  type: string;
  events: Event[];
}

/** Indicators deduplicated case-insensitively, each with every event that observed it. */
export function iocIndex(events: Event[]): Record<string, IocGroup> {
  const m: Record<string, IocGroup> = {};
  for (const e of events) {
    if (!e.indicator) continue;
    const k = e.indicator.trim().toLowerCase();
    if (!k) continue;
    const g = (m[k] ??= { value: e.indicator, type: e.itype, events: [] });
    g.events.push(e);
    if (!g.type && e.itype) g.type = e.itype;
  }
  return m;
}

/** Indicator groups sorted by sightings desc then value. */
export function iocList(events: Event[]): Array<[string, IocGroup]> {
  const idx = iocIndex(events);
  return Object.keys(idx)
    .sort((a, b) => idx[b]!.events.length - idx[a]!.events.length || (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => [k, idx[k]!]);
}

export interface HostAggregate {
  events: Event[];
  count: number;
  outbound: number;
  first: number | null;
  last: number | null;
  users: string[];
  tactics: string[];
  iocs: number;
}

export function hostAgg(
  state: CaseState,
  id: string,
  events: Event[] = sortedEvents(state),
): HostAggregate {
  const evs = events.filter((e) => e.hostId === id);
  const outbound = events.filter((e) => e.srcHostId === id && e.hostId !== id).length;
  const users = new Set<string>();
  const tactics = new Set<string>();
  const iocs = new Set<string>();
  for (const e of evs) {
    if (e.user) users.add(e.user);
    if (e.tactic) tactics.add(e.tactic);
    if (e.indicator) iocs.add(e.indicator.trim().toLowerCase());
  }
  return {
    events: evs,
    count: evs.length,
    outbound,
    first: evs.length ? toEpoch(evs[0]!.ts) : null,
    last: evs.length ? toEpoch(evs[evs.length - 1]!.ts) : null,
    users: [...users],
    tactics: [...tactics],
    iocs: iocs.size,
  };
}

export interface CaseTotals {
  events: number;
  hosts: number;
  compromised: number;
  indicators: number;
  spanMs: number | null;
}

export function caseTotals(state: CaseState, events: Event[] = sortedEvents(state)): CaseTotals {
  return {
    events: events.length,
    hosts: Object.keys(state.hosts).length,
    compromised: Object.values(state.hosts).filter((h) => h.status === 'compromised').length,
    indicators: Object.keys(iocIndex(events)).length,
    spanMs:
      events.length > 1 ? toEpoch(events[events.length - 1]!.ts) - toEpoch(events[0]!.ts) : null,
  };
}

export const UNASSIGNED_LANE = '__none';

/** Lane keys in order of first appearance (pivot sources first), optionally every host. */
export function laneList(events: Event[], hosts: Record<string, Host>, laneAll: boolean): string[] {
  const seen: string[] = [];
  const push = (id: string): void => {
    const k = id || UNASSIGNED_LANE;
    if (!seen.includes(k)) seen.push(k);
  };
  for (const e of events) {
    if (e.srcHostId) push(e.srcHostId);
    push(e.hostId);
  }
  if (laneAll) for (const id of Object.keys(hosts)) push(id);
  return seen;
}

export interface LaneMeta {
  name: string;
  ip: string;
  color: string;
  status?: Host['status'] | undefined;
}

export function laneMeta(state: CaseState, key: string): LaneMeta {
  if (key === UNASSIGNED_LANE) return { name: '(unassigned)', ip: '', color: '#44576b' };
  const h = state.hosts[key];
  return h
    ? { name: h.name, ip: h.ip, color: laneColor(state, h.id), status: h.status }
    : { name: '(deleted host)', ip: '', color: '#44576b' };
}

/** Distinct values used to feed datalists and filter dropdowns. */
export function distinctUsers(events: Event[]): string[] {
  return [...new Set(events.map((e) => e.user).filter(Boolean))].sort();
}
export function distinctSources(events: Event[]): string[] {
  return [...new Set(events.map((e) => e.source).filter(Boolean))].sort();
}
export function distinctIocTypes(events: Event[]): string[] {
  return [...new Set(events.map((e) => e.itype).filter(Boolean))].sort();
}

/** Technique and tactic hit counts for the ATT&CK matrix. */
export function attackHits(events: Event[]): {
  techniques: Record<string, number>;
  tactics: Record<string, number>;
} {
  const techniques: Record<string, number> = {};
  const tactics: Record<string, number> = {};
  for (const e of events) {
    if (e.technique) techniques[e.technique] = (techniques[e.technique] ?? 0) + 1;
    if (e.tactic) tactics[e.tactic] = (tactics[e.tactic] ?? 0) + 1;
  }
  return { techniques, tactics };
}
