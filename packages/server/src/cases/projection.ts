/**
 * Materialize case state into queryable tables. The op log is the source of truth; these
 * rows exist for listing, search, and the terrain overlay. `projectOp` updates only the
 * entities an op touches; `rebuildCase` replays everything from scratch and is the oracle.
 */
import { applyAll, emptyState, hostIps, type CaseState, type Op } from '@midden/core';
import type { Db } from '../db/db.js';
import { nowIso } from '../lib/ids.js';

interface Touched {
  hosts: Set<string>;
  events: Set<string>;
  /** Attachment rows are written by the upload route; only the editable fields project here. */
  attachments: Set<string>;
  links: boolean;
  caseMeta: boolean;
}

export function touchedEntities(
  op: Op,
  t: Touched = {
    hosts: new Set(),
    events: new Set(),
    attachments: new Set(),
    links: false,
    caseMeta: false,
  },
): Touched {
  switch (op.type) {
    case 'case.set':
      t.caseMeta = true;
      break;
    case 'host.add':
      t.hosts.add(op.host.id);
      t.links = true;
      break;
    case 'host.set':
      t.hosts.add(op.id);
      if (op.patch.ip !== undefined) t.links = true;
      break;
    case 'host.remove':
      t.hosts.add(op.id);
      t.links = true;
      break;
    case 'event.add':
      t.events.add(op.event.id);
      break;
    case 'event.set':
    case 'event.remove':
      t.events.add(op.id);
      break;
    case 'link.set':
    case 'link.remove':
      t.links = true;
      break;
    case 'attachment.set':
      t.attachments.add(op.id);
      break;
    case 'batch':
      for (const o of op.ops) touchedEntities(o, t);
      break;
    case 'op.revert':
      touchedEntities(op.inverse, t);
      break;
    default:
      break;
  }
  return t;
}

export function projectOp(
  db: Db,
  caseId: string,
  op: Op,
  next: CaseState,
  ts: string = nowIso(),
): void {
  const t = touchedEntities(op);
  if (t.caseMeta) upsertCaseMeta(db, caseId, next, ts);
  for (const id of t.hosts) upsertHost(db, caseId, id, next, ts);
  for (const id of t.events) upsertEvent(db, caseId, id, next, ts);
  for (const id of t.attachments) {
    const a = next.attachments[id];
    if (a)
      db.run('UPDATE attachments SET note = ? WHERE id = ? AND case_id = ?', a.note, id, caseId);
  }
  if (t.links) rebuildHostIps(db, caseId, next);
  db.run('UPDATE cases SET modified_at = ? WHERE id = ?', ts, caseId);
}

function upsertCaseMeta(db: Db, caseId: string, s: CaseState, ts: string): void {
  db.run(
    'UPDATE cases SET name = ?, number = ?, analyst = ?, classification = ?, summary = ?, modified_at = ? WHERE id = ?',
    s.case.name,
    s.case.number,
    s.case.analyst,
    s.case.classification,
    s.case.summary,
    ts,
    caseId,
  );
}

function upsertHost(db: Db, caseId: string, id: string, s: CaseState, ts: string): void {
  const h = s.hosts[id];
  if (!h) {
    db.run('UPDATE hosts SET deleted_at = ? WHERE id = ? AND case_id = ?', ts, id, caseId);
    return;
  }
  db.run(
    `INSERT INTO hosts (id, case_id, name, ip, status, data, deleted_at) VALUES (?,?,?,?,?,?,NULL)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, ip = excluded.ip, status = excluded.status, data = excluded.data, deleted_at = NULL`,
    h.id,
    caseId,
    h.name,
    h.ip,
    h.status,
    JSON.stringify(h),
  );
}

function upsertEvent(db: Db, caseId: string, id: string, s: CaseState, ts: string): void {
  const e = s.events[id];
  if (!e) {
    db.run('UPDATE events SET deleted_at = ? WHERE id = ? AND case_id = ?', ts, id, caseId);
    return;
  }
  db.run(
    `INSERT INTO events (id, case_id, ts, host_id, indicator, data, deleted_at) VALUES (?,?,?,?,?,?,NULL)
     ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, host_id = excluded.host_id, indicator = excluded.indicator, data = excluded.data, deleted_at = NULL`,
    e.id,
    caseId,
    e.ts,
    e.hostId,
    e.indicator,
    JSON.stringify(e),
  );
}

/** Derived (from each host's ip field) plus manual links. Small table; rebuilt whole. */
export function rebuildHostIps(db: Db, caseId: string, s: CaseState): void {
  db.run('DELETE FROM case_host_ips WHERE case_id = ?', caseId);
  for (const h of Object.values(s.hosts)) {
    for (const ip of hostIps(h.ip))
      db.run(
        'INSERT OR IGNORE INTO case_host_ips (case_id, host_id, ip, manual) VALUES (?,?,?,0)',
        caseId,
        h.id,
        ip,
      );
  }
  for (const l of Object.values(s.links)) {
    db.run(
      'INSERT INTO case_host_ips (case_id, host_id, ip, manual) VALUES (?,?,?,1) ON CONFLICT DO UPDATE SET manual = 1',
      caseId,
      l.hostId,
      l.ip,
    );
  }
}

/** Replay the whole op log into fresh rows. Returns the rebuilt state. */
export function rebuildCase(db: Db, caseId: string): CaseState {
  const rows = db.all<{ payload: string }>(
    'SELECT payload FROM ops WHERE case_id = ? ORDER BY seq',
    caseId,
  );
  const meta = db.get<{ created_at: string }>('SELECT created_at FROM cases WHERE id = ?', caseId);
  const state = applyAll(
    emptyState(meta?.created_at ?? nowIso()),
    rows.map((r) => JSON.parse(r.payload) as Op),
  );
  const ts = nowIso();
  db.transaction(() => {
    db.run('DELETE FROM hosts WHERE case_id = ?', caseId);
    db.run('DELETE FROM events WHERE case_id = ?', caseId);
    for (const id of Object.keys(state.hosts)) upsertHost(db, caseId, id, state, ts);
    for (const id of Object.keys(state.events)) upsertEvent(db, caseId, id, state, ts);
    rebuildHostIps(db, caseId, state);
    upsertCaseMeta(db, caseId, state, ts);
    db.run('DELETE FROM case_snapshots WHERE case_id = ?', caseId);
  });
  return state;
}

/** Snapshot of the live projection, for tests comparing incremental vs rebuilt. */
export function projectionRows(
  db: Db,
  caseId: string,
): { hosts: string[]; events: string[]; ips: string[] } {
  return {
    hosts: db
      .all<{ data: string }>(
        'SELECT data FROM hosts WHERE case_id = ? AND deleted_at IS NULL ORDER BY id',
        caseId,
      )
      .map((r) => r.data),
    events: db
      .all<{ data: string }>(
        'SELECT data FROM events WHERE case_id = ? AND deleted_at IS NULL ORDER BY id',
        caseId,
      )
      .map((r) => r.data),
    ips: db
      .all<{ host_id: string; ip: string; manual: number }>(
        'SELECT host_id, ip, manual FROM case_host_ips WHERE case_id = ? ORDER BY host_id, ip',
        caseId,
      )
      .map((r) => `${r.host_id}|${r.ip}|${r.manual}`),
  };
}
