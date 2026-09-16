/** Report model plus Markdown and CSV builders, ported from the prototype. */
import type { CaseState, Event } from '../domain/types.js';
import {
  CONFIDENCE,
  HOST_STATUS,
  SEVERITY,
  TACTICS,
  TACTIC_BY_ID,
  TECHNIQUE_NAME,
  byId,
} from '../domain/reference.js';
import { fmtParts, humanSpan, offsetLabel, toEpoch } from '../time/time.js';
import { sortedEvents } from '../codec/casefile.js';
import { hostAgg, hostName, iocIndex, type IocGroup } from '../views/derive.js';
import { fmtTs, type TzMode } from '../views/display.js';

const CONF_BY_ID = byId(CONFIDENCE);
const SEV_BY_ID = byId(SEVERITY);
const HS_BY_ID = byId(HOST_STATUS);

export interface ReportModel {
  events: Event[];
  first: Event | undefined;
  last: Event | undefined;
  compromised: string[];
  techniques: Record<string, number>;
  keyEvents: Event[];
  iocs: Record<string, IocGroup>;
  spanMs: number | null;
}

export function reportModel(state: CaseState): ReportModel {
  const events = sortedEvents(state);
  const first = events[0];
  const last = events[events.length - 1];
  const techniques: Record<string, number> = {};
  for (const e of events)
    if (e.technique) techniques[e.technique] = (techniques[e.technique] ?? 0) + 1;
  return {
    events,
    first,
    last,
    compromised: Object.values(state.hosts)
      .filter((h) => h.status === 'compromised')
      .map((h) => h.name),
    techniques,
    keyEvents: events.filter((e) => e.key),
    iocs: iocIndex(events),
    spanMs: first && last ? toEpoch(last.ts) - toEpoch(first.ts) : null,
  };
}

const utc = (ep: number): string => {
  const p = fmtParts(ep, 0);
  return p.date + ' ' + p.time;
};

export function buildMarkdown(
  state: CaseState,
  tz: TzMode = 'utc',
  now: string = new Date().toISOString(),
): string {
  const c = state.case;
  const m = reportModel(state);
  const L: string[] = [];
  L.push('# ' + (c.name || 'Untitled investigation') + (c.number ? ' (' + c.number + ')' : ''));
  L.push(
    '',
    [c.classification, c.analyst ? 'Lead analyst: ' + c.analyst : '', 'Generated ' + now]
      .filter(Boolean)
      .join(' · '),
    '',
  );
  L.push('## Summary', '');
  if (c.summary) L.push(c.summary, '');
  L.push('- ' + m.events.length + ' events across ' + Object.keys(state.hosts).length + ' hosts');
  if (m.first)
    L.push(
      '- First observed activity: `' +
        fmtTs(m.first, tz, true) +
        '` on **' +
        hostName(state, m.first.hostId) +
        '**' +
        (m.first.activity ? ' — ' + m.first.activity : ''),
    );
  if (m.last && m.spanMs !== null)
    L.push(
      '- Last observed activity: `' +
        fmtTs(m.last, tz, true) +
        '` (span ' +
        humanSpan(m.spanMs) +
        ')',
    );
  if (m.compromised.length) L.push('- Confirmed compromised: ' + m.compromised.join(', '));
  L.push(
    '- ' +
      Object.keys(m.techniques).length +
      ' distinct ATT&CK techniques, ' +
      Object.keys(m.iocs).length +
      ' unique indicators',
    '',
  );
  if (m.keyEvents.length) {
    L.push('## Key events', '');
    for (const e of m.keyEvents)
      L.push(
        '- `' +
          fmtTs(e, tz) +
          '` **' +
          hostName(state, e.hostId) +
          '** — ' +
          (e.activity || e.indicator || '') +
          (e.technique ? ' (' + e.technique + ')' : ''),
      );
    L.push('');
  }
  const hosts = Object.values(state.hosts);
  if (hosts.length) {
    L.push(
      '## Affected systems',
      '',
      '| Host | Address | Function | Status | Events | First seen | Last seen |',
      '|---|---|---|---|---|---|---|',
    );
    for (const h of hosts) {
      const a = hostAgg(state, h.id, m.events);
      L.push(
        '| ' +
          h.name +
          ' | ' +
          (h.ip || '—') +
          ' | ' +
          (h.role || '—') +
          ' | ' +
          (HS_BY_ID[h.status]?.label ?? '—') +
          ' | ' +
          a.count +
          ' | ' +
          (a.first !== null ? utc(a.first) : '—') +
          ' | ' +
          (a.last !== null ? utc(a.last) : '—') +
          ' |',
      );
    }
    L.push('');
  }
  L.push(
    '## Timeline',
    '',
    '| Time | Host | Account | Technique | Activity | Confidence |',
    '|---|---|---|---|---|---|',
  );
  for (const e of m.events) {
    const act =
      (e.activity || '—') +
      (e.cmd ? '<br>`' + e.cmd.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 180) + '`' : '');
    L.push(
      '| ' +
        fmtTs(e, tz) +
        ' | ' +
        hostName(state, e.hostId) +
        (e.srcHostId ? ' ← ' + hostName(state, e.srcHostId) : '') +
        ' | ' +
        (e.user || '—') +
        (e.priv ? ' (' + e.priv + ')' : '') +
        ' | ' +
        (e.technique || '—') +
        ' | ' +
        act.replace(/\|/g, '\\|') +
        ' | ' +
        (CONF_BY_ID[e.conf]?.label ?? '—') +
        ' |',
    );
  }
  L.push('');
  const ik = Object.keys(m.iocs);
  if (ik.length) {
    L.push(
      '## Indicators of compromise',
      '',
      '| Type | Indicator | Sightings | Hosts |',
      '|---|---|---|---|',
    );
    for (const k of ik) {
      const g = m.iocs[k]!;
      const hs = [...new Set(g.events.map((e) => e.hostId).filter(Boolean))].map((id) =>
        hostName(state, id),
      );
      L.push(
        '| ' +
          (g.type || '—') +
          ' | `' +
          g.value +
          '` | ' +
          g.events.length +
          ' | ' +
          hs.join(', ') +
          ' |',
      );
    }
    L.push('');
  }
  if (Object.keys(m.techniques).length) {
    L.push('## ATT&CK coverage', '');
    for (const t of TACTICS) {
      const hit = t.tech.filter((p) => m.techniques[p[0]]);
      if (hit.length)
        L.push('- **' + t.name + '** — ' + hit.map((p) => p[0] + ' ' + p[1]).join('; '));
    }
    L.push('');
  }
  return L.join('\n');
}

export function csvEscape(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export const TIMELINE_CSV_COLUMNS = [
  '#',
  'timestamp_utc',
  'timestamp_source',
  'source_tz',
  'host',
  'host_ip',
  'pivot_from',
  'account',
  'privilege',
  'tactic',
  'technique',
  'technique_name',
  'activity',
  'command',
  'indicator_type',
  'indicator',
  'confidence',
  'severity',
  'key_event',
  'data_source',
  'link',
  'evidence',
  'tags',
  'notes',
] as const;

export function buildTimelineCsv(state: CaseState, events: Event[] = sortedEvents(state)): string {
  const rows = [TIMELINE_CSV_COLUMNS.join(',')];
  events.forEach((e, i) => {
    const h = state.hosts[e.hostId];
    const p = fmtParts(toEpoch(e.ts), +e.off || 0);
    rows.push(
      [
        i + 1,
        e.ts,
        p.date + ' ' + p.time,
        offsetLabel(+e.off || 0),
        hostName(state, e.hostId),
        h?.ip ?? '',
        e.srcHostId ? hostName(state, e.srcHostId) : '',
        e.user,
        e.priv,
        TACTIC_BY_ID[e.tactic]?.name ?? '',
        e.technique,
        TECHNIQUE_NAME[e.technique] ?? '',
        e.activity,
        e.cmd,
        e.itype,
        e.indicator,
        e.conf,
        e.sev,
        e.key ? 'yes' : '',
        e.source,
        e.link,
        e.evidence,
        e.tags.join('|'),
        e.notes,
      ]
        .map(csvEscape)
        .join(','),
    );
  });
  return rows.join('\r\n');
}

export function buildIocCsv(state: CaseState): string {
  const idx = iocIndex(sortedEvents(state));
  const rows = ['indicator,type,sightings,hosts,first_seen_utc,last_seen_utc'];
  for (const k of Object.keys(idx)) {
    const g = idx[k]!;
    const hs = [...new Set(g.events.map((e) => e.hostId).filter(Boolean))].map((id) =>
      hostName(state, id),
    );
    rows.push(
      [
        g.value,
        g.type || '',
        g.events.length,
        hs.join('|'),
        utc(toEpoch(g.events[0]!.ts)),
        utc(toEpoch(g.events[g.events.length - 1]!.ts)),
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  return rows.join('\r\n');
}

export function severityLabel(id: string): string {
  return SEV_BY_ID[id as keyof typeof SEV_BY_ID]?.label ?? '—';
}

/** Filename-safe slug for downloads. */
export function slug(s: string | null | undefined): string {
  return (
    (s || 'case')
      .toString()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'case'
  );
}
