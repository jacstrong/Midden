import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyAll, emptyState, type Event, type Host, type Op } from '@midden/core';
import { openDatabase, type Db } from '../db/db.js';
import { migrate } from '../db/migrate.js';
import { CaseRuntime, loadState, RuntimeRegistry, SNAPSHOT_EVERY } from './runtime.js';
import { projectionRows, rebuildCase } from './projection.js';
import { createUser } from '../auth/sessions.js';

function fixture(): {
  db: Db;
  caseId: string;
  alice: { id: string; name: string };
  bob: { id: string; name: string };
} {
  const db = openDatabase(':memory:');
  migrate(db);
  const a = createUser(db, { username: 'alice', displayName: 'Alice', role: 'analyst' });
  const b = createUser(db, { username: 'bob', displayName: 'Bob', role: 'analyst' });
  db.run(
    "INSERT INTO cases (id, name, created_at, modified_at, seq) VALUES ('case_1', 'Test', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0)",
  );
  return {
    db,
    caseId: 'case_1',
    alice: { id: a.id, name: 'Alice' },
    bob: { id: b.id, name: 'Bob' },
  };
}

const host = (id: string, extra: Partial<Host> = {}): Host => ({
  id,
  name: id,
  ip: '',
  os: '',
  role: '',
  zone: '',
  crit: 'moderate',
  status: 'unknown',
  owner: '',
  tags: [],
  notes: '',
  ...extra,
});
const event = (id: string, extra: Partial<Event> = {}): Event => ({
  id,
  ts: '2026-07-14T13:00:00.000Z',
  off: 0,
  hostId: '',
  srcHostId: '',
  user: '',
  priv: '',
  indicator: '',
  itype: '',
  activity: '',
  cmd: '',
  tactic: '',
  technique: '',
  source: '',
  link: '',
  conf: 'medium',
  sev: 'medium',
  key: false,
  tags: [],
  evidence: '',
  notes: '',
  ...extra,
});

describe('CaseRuntime.appendOp', () => {
  it('assigns sequence numbers, stores inverses, projects rows, and reloads', () => {
    const { db, caseId, alice } = fixture();
    const rt = new CaseRuntime(db, caseId);
    const r1 = rt.appendOp(
      alice,
      { type: 'host.add', host: host('h1', { ip: '10.0.0.1, 10.0.0.2' }) },
      { canEdit: true, clientOpId: 'c1', baseSeq: 0 },
    );
    expect(r1.ok && r1.seq).toBe(1);
    const r2 = rt.appendOp(
      alice,
      { type: 'host.set', id: 'h1', patch: { status: 'compromised' } },
      { canEdit: true },
    );
    expect(r2.ok && r2.seq).toBe(2);
    expect(rt.state.hosts.h1?.status).toBe('compromised');
    const rows = db.all<{ seq: number; type: string; inverse: string }>(
      'SELECT seq, type, inverse FROM ops WHERE case_id = ? ORDER BY seq',
      caseId,
    );
    expect(rows.map((r) => r.type)).toEqual(['host.add', 'host.set']);
    expect(JSON.parse(rows[1]!.inverse)).toEqual({
      type: 'host.set',
      id: 'h1',
      patch: { status: 'unknown' },
    });
    expect(db.get<{ status: string }>('SELECT status FROM hosts WHERE id = ?', 'h1')?.status).toBe(
      'compromised',
    );
    expect(db.all('SELECT ip FROM case_host_ips WHERE case_id = ? ORDER BY ip', caseId)).toEqual([
      { ip: '10.0.0.1' },
      { ip: '10.0.0.2' },
    ]);
    const reloaded = loadState(db, caseId);
    expect(reloaded.seq).toBe(2);
    expect(reloaded.state).toEqual(rt.state);
  });

  it('is idempotent on clientOpId resend', () => {
    const { db, caseId, alice } = fixture();
    const rt = new CaseRuntime(db, caseId);
    const op: Op = { type: 'host.add', host: host('h1') };
    const a = rt.appendOp(alice, op, { canEdit: true, clientOpId: 'same' });
    const b = rt.appendOp(alice, op, { canEdit: true, clientOpId: 'same' });
    expect(a.ok && a.seq).toBe(1);
    expect(b.ok && b.duplicate).toBe(true);
    expect(b.ok && b.seq).toBe(1);
    expect(rt.seq).toBe(1);
  });

  it('rejects bad schema, missing targets, oversized batches, and read-only users', () => {
    const { db, caseId, alice } = fixture();
    const rt = new CaseRuntime(db, caseId);
    expect(rt.appendOp(alice, { type: 'nope' }, { canEdit: true })).toMatchObject({
      ok: false,
      code: 'schema',
    });
    expect(
      rt.appendOp(alice, { type: 'host.set', id: 'ghost', patch: {} }, { canEdit: true }),
    ).toMatchObject({ ok: false, code: 'notfound' });
    const big: Op = {
      type: 'batch',
      ops: Array.from({ length: 5001 }, () => ({ type: 'noop' as const })),
    };
    expect(rt.appendOp(alice, big, { canEdit: true })).toMatchObject({
      ok: false,
      code: 'too_large',
    });
    expect(rt.appendOp(alice, { type: 'noop' }, { canEdit: false })).toMatchObject({
      ok: false,
      code: 'readonly',
    });
    expect(rt.seq).toBe(0);
  });

  it('reports fields overwritten since the client baseSeq, by someone else', () => {
    const { db, caseId, alice, bob } = fixture();
    const rt = new CaseRuntime(db, caseId);
    rt.appendOp(alice, { type: 'event.add', event: event('e1') }, { canEdit: true }); // seq 1
    rt.appendOp(
      bob,
      { type: 'event.set', id: 'e1', patch: { user: 'bob-wrote', activity: 'x' } },
      { canEdit: true, baseSeq: 1 },
    ); // seq 2
    const r = rt.appendOp(
      alice,
      { type: 'event.set', id: 'e1', patch: { user: 'alice-wrote', notes: 'n' } },
      { canEdit: true, baseSeq: 1 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.overwrote).toEqual([{ field: 'e1/user', bySeq: 2, byActor: bob }]);
    expect(rt.state.events.e1).toMatchObject({ user: 'alice-wrote', activity: 'x', notes: 'n' });
    // own earlier write is not a conflict
    const r2 = rt.appendOp(
      alice,
      { type: 'event.set', id: 'e1', patch: { notes: 'again' } },
      { canEdit: true, baseSeq: 1 },
    );
    expect(r2.ok && r2.overwrote).toEqual([]);
    // the touch map survives a runtime reload
    const rt2 = new CaseRuntime(db, caseId);
    const r3 = rt2.appendOp(
      alice,
      { type: 'event.set', id: 'e1', patch: { activity: 'y' } },
      { canEdit: true, baseSeq: 1 },
    );
    expect(r3.ok && r3.overwrote.map((o) => o.field)).toEqual(['e1/activity']);
  });

  it('snapshots every N ops and loads from the latest snapshot plus the tail', () => {
    const { db, caseId, alice } = fixture();
    const rt = new CaseRuntime(db, caseId);
    for (let i = 0; i < SNAPSHOT_EVERY + 3; i++)
      rt.appendOp(alice, { type: 'host.add', host: host(`h${i}`) }, { canEdit: true });
    expect(db.all('SELECT seq FROM case_snapshots WHERE case_id = ?', caseId)).toEqual([
      { seq: SNAPSHOT_EVERY },
    ]);
    const loaded = loadState(db, caseId);
    expect(loaded.seq).toBe(SNAPSHOT_EVERY + 3);
    expect(Object.keys(loaded.state.hosts)).toHaveLength(SNAPSHOT_EVERY + 3);
    expect(rt.opsAfter(SNAPSHOT_EVERY)).toHaveLength(3);
  });

  it('registry evicts idle runtimes with a snapshot and reloads them identically', () => {
    const { db, caseId, alice } = fixture();
    const reg = new RuntimeRegistry(db, 1);
    const rt = reg.get(caseId);
    rt.appendOp(alice, { type: 'host.add', host: host('h1') }, { canEdit: true });
    rt.lastUsed = Date.now() - 10;
    expect(reg.evictIdle()).toEqual([caseId]);
    expect(db.all('SELECT seq FROM case_snapshots WHERE case_id = ?', caseId)).toEqual([
      { seq: 1 },
    ]);
    expect(reg.get(caseId).state).toEqual(rt.state);
  });
});

describe('projection ≡ rebuild', () => {
  const ids = ['a', 'b', 'c'];
  const arbId = fc.constantFrom(...ids);
  const arbStr = fc.string({ maxLength: 6 });
  const arbIp = fc.constantFrom('', '10.0.0.1', '10.0.0.1 10.0.0.2', '2001:db8::1');
  const arbOp: fc.Arbitrary<Op> = fc.oneof(
    fc
      .tuple(arbId, arbIp, arbStr)
      .map(([id, ip, name]): Op => ({ type: 'host.add', host: host(id, { ip, name }) })),
    fc
      .tuple(
        arbId,
        fc.record(
          { ip: arbIp, status: fc.constantFrom('unknown', 'compromised'), notes: arbStr },
          { requiredKeys: [] },
        ),
      )
      .map(([id, patch]): Op => ({ type: 'host.set', id, patch })),
    arbId.map((id): Op => ({ type: 'host.remove', id })),
    fc.tuple(arbId, arbId, arbStr).map(([id, hostId, indicator]): Op => ({
      type: 'event.add',
      event: event(id, { hostId, indicator }),
    })),
    fc
      .tuple(
        arbId,
        fc.record(
          {
            ts: fc.constantFrom('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
            user: arbStr,
          },
          { requiredKeys: [] },
        ),
      )
      .map(([id, patch]): Op => ({ type: 'event.set', id, patch })),
    arbId.map((id): Op => ({ type: 'event.remove', id })),
    fc
      .tuple(arbId, fc.constantFrom('10.9.9.9', '10.0.0.1'))
      .map(([hostId, ip]): Op => ({ type: 'link.set', hostId, ip })),
    fc
      .tuple(arbId, fc.constantFrom('10.9.9.9', '10.0.0.1'))
      .map(([hostId, ip]): Op => ({ type: 'link.remove', hostId, ip })),
    fc
      .record({ name: arbStr, summary: arbStr }, { requiredKeys: [] })
      .map((patch): Op => ({ type: 'case.set', patch })),
  );

  it('incremental projection matches a full replay for any op sequence', () => {
    fc.assert(
      fc.property(fc.array(arbOp, { minLength: 1, maxLength: 25 }), (ops) => {
        const { db, caseId, alice } = fixture();
        const rt = new CaseRuntime(db, caseId);
        const applied: Op[] = [];
        for (const op of ops) {
          const r = rt.appendOp(alice, op, { canEdit: true });
          if (r.ok) applied.push(op);
        }
        const incremental = projectionRows(db, caseId);
        const expectedState = applyAll(emptyState('2026-01-01T00:00:00.000Z'), applied);
        expect(rt.state).toEqual(expectedState);
        const rebuilt = rebuildCase(db, caseId);
        expect(rebuilt).toEqual(expectedState);
        expect(projectionRows(db, caseId)).toEqual(incremental);
        db.close();
      }),
      { numRuns: 150 },
    );
  });
});
