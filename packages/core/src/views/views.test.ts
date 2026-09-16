import { describe, expect, it } from 'vitest';
import { demoCaseState } from '../demo/demoCase.js';
import {
  attackHits,
  caseTotals,
  defaultFilters,
  filterEvents,
  hostAgg,
  iocList,
  laneList,
  laneMeta,
  distinctUsers,
} from './derive.js';
import { fmtTs, isoInput } from './display.js';
import { layoutBranchGraph, layoutY } from './graph.js';
import {
  buildIocCsv,
  buildMarkdown,
  buildTimelineCsv,
  reportModel,
  slug,
} from '../report/report.js';
import { sortedEvents } from '../codec/casefile.js';
import { TACTIC_BY_ID } from '../domain/reference.js';

const state = demoCaseState();
const events = sortedEvents(state);

describe('derive', () => {
  it('filters by host, user, tactic, flags, dates and text', () => {
    const f = defaultFilters();
    expect(filterEvents(state, f)).toHaveLength(14);
    expect(filterEvents(state, { ...f, host: 'h_wks' })).toHaveLength(8); // 6 on wks + 2 pivots from wks
    expect(filterEvents(state, { ...f, user: 'CORP\\svc_backup' })).toHaveLength(8);
    expect(filterEvents(state, { ...f, tactic: 'TA0006' })).toHaveLength(3);
    expect(filterEvents(state, { ...f, flags: ['pivot'] })).toHaveLength(5);
    expect(filterEvents(state, { ...f, flags: ['key'] })).toHaveLength(10);
    expect(filterEvents(state, { ...f, conf: ['high'] })).toHaveLength(1);
    expect(filterEvents(state, { ...f, from: '2026-07-14 15:00', to: '2026-07-14' })).toHaveLength(
      5,
    );
    expect(filterEvents(state, { ...f, q: 'dcsync' })).toHaveLength(1);
    expect(filterEvents(state, { ...f, q: 'srv-file-02' }).length).toBeGreaterThan(0);
  });
  it('indexes indicators and aggregates hosts', () => {
    const list = iocList(events);
    expect(list).toHaveLength(11);
    expect(list[0]![1].value).toBe('185.243.115.44');
    const a = hostAgg(state, 'h_wks');
    expect(a.count).toBe(6);
    expect(a.outbound).toBe(2);
    expect(a.users).toEqual(['CORP\\j.reyes']);
    expect(a.tactics).toHaveLength(6);
    expect(caseTotals(state)).toMatchObject({
      events: 14,
      hosts: 5,
      compromised: 4,
      indicators: 11,
    });
    expect(distinctUsers(events)).toEqual(['CORP\\j.reyes', 'CORP\\svc_backup']);
    expect(attackHits(events).tactics.TA0006).toBe(3);
  });
  it('orders lanes by first appearance with pivot sources first', () => {
    expect(laneList(events, state.hosts, false)).toEqual(['h_wks', 'h_file', 'h_dc', 'h_bkp']);
    expect(laneList(events, state.hosts, true)).toEqual([
      'h_wks',
      'h_file',
      'h_dc',
      'h_bkp',
      'h_vpn',
    ]);
    expect(laneMeta(state, 'nope').name).toBe('(deleted host)');
    expect(laneMeta(state, '__none').name).toBe('(unassigned)');
  });
});

describe('display', () => {
  it('formats under each tz mode', () => {
    const e = { ts: '2026-07-14T13:02:11.000Z', off: -300 };
    expect(fmtTs(e, 'utc', true)).toBe('2026-07-14 13:02:11 UTC');
    expect(fmtTs(e, 'source', true)).toBe('2026-07-14 08:02:11 UTC−05:00');
    expect(isoInput(e)).toBe('2026-07-14 08:02:11');
  });
});

describe('graph', () => {
  it('lays rows out in sequence and time modes with day breaks', () => {
    const seq = layoutY(events, 'seq', 'utc');
    expect(seq.ys[0]).toBe(48);
    expect(seq.ys[1]).toBe(100);
    expect(seq.breaks).toEqual([{ y: 22, label: '2026-07-14' }]);
    const time = layoutY(events, 'time', 'utc');
    expect(time.ys[0]).toBe(48);
    for (let i = 1; i < time.ys.length; i++)
      expect(time.ys[i]! - time.ys[i - 1]!).toBeGreaterThanOrEqual(38);
    const l = layoutBranchGraph(
      state,
      events,
      { mode: 'seq', tz: 'utc', laneAll: false, selectedId: 'ev_demo_03' },
      (e) => TACTIC_BY_ID[e.tactic]?.color ?? null,
    );
    expect(l.lanes.map((x) => x.key)).toEqual(['h_wks', 'h_file', 'h_dc', 'h_bkp']);
    expect(l.nodes).toHaveLength(14);
    expect(l.nodes.filter((n) => n.selected)).toHaveLength(1);
    expect(l.pivots).toHaveLength(5);
    expect(l.pivots[0]).toMatchObject({ eventId: 'ev_demo_07', from: { x: 32 }, to: { x: 78 } });
    expect(l.width).toBe(32 + 4 * 46 + 10);
    expect(l.height).toBe(l.rowsY[13]! + 70);
  });
  it('handles an empty event list', () => {
    const l = layoutBranchGraph(state, [], { mode: 'seq', tz: 'utc', laneAll: false }, () => null);
    expect(l.nodes).toEqual([]);
    expect(l.height).toBe(520);
  });
});

describe('report', () => {
  it('builds the model, markdown and csv', () => {
    const m = reportModel(state);
    expect(m.keyEvents).toHaveLength(10);
    expect(m.compromised).toHaveLength(4);
    const md = buildMarkdown(state, 'utc', '2026-07-15T10:00:00.000Z');
    expect(md).toContain('# Operation Glasshouse (IR-2026-0142)');
    expect(md).toContain('## Key events');
    expect(md).toContain('| DC-CORP-01 | 10.20.1.5 | Domain controller | Compromised | 3 |');
    expect(md).toContain(
      '- **Credential Access** — T1003.001 LSASS Memory; T1003.006 DCSync; T1558.003 Kerberoasting',
    );
    expect(md).toContain('SRV-FILE-02 ← WKS-FIN-014');
    const csv = buildTimelineCsv(state);
    expect(csv.split('\r\n')).toHaveLength(15);
    expect(csv.split('\r\n')[1]).toContain('"CORP\\j.reyes"'.replace(/"/g, ''));
    const ioc = buildIocCsv(state);
    expect(ioc.split('\r\n')).toHaveLength(12);
    expect(slug('IR-2026/0142 Glasshouse')).toBe('ir-2026-0142-glasshouse');
    expect(slug('')).toBe('case');
  });
});
