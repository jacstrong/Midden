/**
 * One CaseRuntime per open case: the in-memory state, its sequence number, who last touched
 * each field (for overwrite notices), and the sockets in the room. `appendOp` is the single
 * write path: validate → inverse → seq → insert op → project → commit → broadcast.
 */
import {
  apply,
  applyAll,
  emptyState,
  inverse,
  opSize,
  parseOp,
  touchedFields,
  MAX_BATCH,
  type Actor,
  type Broadcast,
  type CaseState,
  type Op,
  type Overwrite,
  type RejectCode,
} from '@midden/core';
import type { Db } from '../db/db.js';
import { nowIso } from '../lib/ids.js';
import { projectOp } from './projection.js';

export const SNAPSHOT_EVERY = 500;

export interface Touch {
  seq: number;
  actor: Actor;
}

export type AppendResult =
  | { ok: true; seq: number; broadcast: Broadcast; overwrote: Overwrite[]; duplicate: boolean }
  | { ok: false; code: RejectCode; message: string };

export interface RoomClient {
  id: string;
  user: Actor;
  send(msg: unknown): void;
}

export class CaseRuntime {
  state: CaseState;
  seq: number;
  readonly lastTouch = new Map<string, Touch>();
  readonly clients = new Map<string, RoomClient>();
  lastUsed = Date.now();

  constructor(
    readonly db: Db,
    readonly caseId: string,
  ) {
    const loaded = loadState(db, caseId);
    this.state = loaded.state;
    this.seq = loaded.seq;
    this.rebuildTouches();
  }

  /** Rebuild the per-field last-writer map from the full log (thousands of ops: milliseconds). */
  private rebuildTouches(): void {
    const rows = this.db.all<{ seq: number; actor_id: string; payload: string }>(
      'SELECT seq, actor_id, payload FROM ops WHERE case_id = ? ORDER BY seq',
      this.caseId,
    );
    const names = new Map<string, string>();
    for (const r of this.db.all<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM users',
    ))
      names.set(r.id, r.display_name);
    for (const r of rows) {
      const op = JSON.parse(r.payload) as Op;
      const actor = { id: r.actor_id, name: names.get(r.actor_id) ?? r.actor_id };
      for (const f of touchedFields(op)) this.lastTouch.set(f, { seq: Number(r.seq), actor });
    }
  }

  private touch(op: Op, seq: number, actor: Actor): void {
    for (const f of touchedFields(op)) this.lastTouch.set(f, { seq, actor });
  }

  /** Fields in `op` that someone else wrote after `baseSeq`. */
  overwrites(op: Op, baseSeq: number, actor: Actor): Overwrite[] {
    const out: Overwrite[] = [];
    for (const f of touchedFields(op)) {
      if (!f.includes('/') || f.endsWith('/*')) continue;
      const t = this.lastTouch.get(f);
      if (t && t.seq > baseSeq && t.actor.id !== actor.id)
        out.push({ field: f, bySeq: t.seq, byActor: t.actor });
    }
    return out;
  }

  appendOp(
    actor: Actor,
    rawOp: unknown,
    opts: { clientOpId?: string | undefined; baseSeq?: number | undefined; canEdit: boolean },
  ): AppendResult {
    this.lastUsed = Date.now();
    if (!opts.canEdit)
      return { ok: false, code: 'readonly', message: 'You do not have edit access to this case' };
    let op: Op;
    try {
      op = parseOp(rawOp);
    } catch (err) {
      return {
        ok: false,
        code: 'schema',
        message: err instanceof Error ? err.message.slice(0, 300) : 'invalid op',
      };
    }
    if (opSize(op) > MAX_BATCH)
      return { ok: false, code: 'too_large', message: `Batch exceeds ${MAX_BATCH} operations` };

    if (opts.clientOpId) {
      const dup = this.db.get<{ seq: number; ts: string; payload: string }>(
        'SELECT seq, ts, payload FROM ops WHERE case_id = ? AND client_op_id = ?',
        this.caseId,
        opts.clientOpId,
      );
      if (dup) {
        const seq = Number(dup.seq);
        return {
          ok: true,
          seq,
          duplicate: true,
          overwrote: [],
          broadcast: {
            seq,
            op: JSON.parse(dup.payload) as Op,
            actor,
            ts: dup.ts,
            clientOpId: opts.clientOpId,
          },
        };
      }
    }
    const missing = missingTarget(this.state, op);
    if (missing) return { ok: false, code: 'notfound', message: missing };

    const baseSeq = opts.baseSeq ?? this.seq;
    const overwrote = this.overwrites(op, baseSeq, actor);
    const inv = inverse(this.state, op);
    const next = apply(this.state, op);
    const ts = nowIso();
    const seq = this.db.transaction(() => {
      const row = this.db.get<{ seq: number }>(
        'UPDATE cases SET seq = seq + 1 WHERE id = ? RETURNING seq',
        this.caseId,
      );
      const s = Number(row?.seq);
      this.db.run(
        'INSERT INTO ops (case_id, seq, actor_id, ts, client_op_id, base_seq, type, payload, inverse) VALUES (?,?,?,?,?,?,?,?,?)',
        this.caseId,
        s,
        actor.id,
        ts,
        opts.clientOpId ?? null,
        opts.baseSeq ?? null,
        op.type,
        JSON.stringify(op),
        JSON.stringify(inv),
      );
      projectOp(this.db, this.caseId, op, next, ts);
      if (s % SNAPSHOT_EVERY === 0) {
        this.db.run(
          'INSERT OR REPLACE INTO case_snapshots (case_id, seq, state, created_at) VALUES (?,?,?,?)',
          this.caseId,
          s,
          JSON.stringify(next),
          ts,
        );
      }
      return s;
    });
    this.state = next;
    this.seq = seq;
    this.touch(op, seq, actor);
    const broadcast: Broadcast = { seq, op, actor, ts, clientOpId: opts.clientOpId };
    return { ok: true, seq, broadcast, overwrote, duplicate: false };
  }

  broadcast(msg: unknown, except?: string): void {
    for (const c of this.clients.values()) if (c.id !== except) c.send(msg);
  }

  /** Ops after `afterSeq`, for catch-up. */
  opsAfter(afterSeq: number, limit = 10_000): Broadcast[] {
    const rows = this.db.all<{
      seq: number;
      actor_id: string;
      ts: string;
      client_op_id: string | null;
      payload: string;
    }>(
      'SELECT o.seq, o.actor_id, o.ts, o.client_op_id, o.payload FROM ops o WHERE o.case_id = ? AND o.seq > ? ORDER BY o.seq LIMIT ?',
      this.caseId,
      afterSeq,
      limit,
    );
    const names = new Map<string, string>();
    for (const r of this.db.all<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM users',
    ))
      names.set(r.id, r.display_name);
    return rows.map((r) => ({
      seq: Number(r.seq),
      op: JSON.parse(r.payload) as Op,
      actor: { id: r.actor_id, name: names.get(r.actor_id) ?? r.actor_id },
      ts: r.ts,
      clientOpId: r.client_op_id ?? undefined,
    }));
  }

  /** Persist a snapshot so the next load is fast (called on eviction). */
  snapshot(): void {
    this.db.run(
      'INSERT OR REPLACE INTO case_snapshots (case_id, seq, state, created_at) VALUES (?,?,?,?)',
      this.caseId,
      this.seq,
      JSON.stringify(this.state),
      nowIso(),
    );
  }
}

function missingTarget(state: CaseState, op: Op): string | null {
  switch (op.type) {
    case 'host.set':
    case 'host.remove':
      return state.hosts[op.id] ? null : `Host ${op.id} does not exist`;
    case 'event.set':
    case 'event.remove':
      return state.events[op.id] ? null : `Event ${op.id} does not exist`;
    case 'scan.set':
    case 'scan.remove':
      return state.scans[op.id] ? null : `Scan ${op.id} does not exist`;
    case 'attachment.remove':
      return state.attachments[op.id] ? null : `Attachment ${op.id} does not exist`;
    case 'batch': {
      let s = state;
      for (const o of op.ops) {
        const m = missingTarget(s, o);
        if (m) return m;
        s = apply(s, o);
      }
      return null;
    }
    default:
      return null;
  }
}

export function loadState(db: Db, caseId: string): { state: CaseState; seq: number } {
  const c = db.get<{ seq: number; created_at: string }>(
    'SELECT seq, created_at FROM cases WHERE id = ?',
    caseId,
  );
  if (!c) throw new Error(`case ${caseId} not found`);
  const snap = db.get<{ seq: number; state: string }>(
    'SELECT seq, state FROM case_snapshots WHERE case_id = ? ORDER BY seq DESC LIMIT 1',
    caseId,
  );
  let state = snap ? (JSON.parse(snap.state) as CaseState) : emptyState(c.created_at);
  const from = snap ? Number(snap.seq) : 0;
  const rows = db.all<{ payload: string }>(
    'SELECT payload FROM ops WHERE case_id = ? AND seq > ? ORDER BY seq',
    caseId,
    from,
  );
  state = applyAll(
    state,
    rows.map((r) => JSON.parse(r.payload) as Op),
  );
  return { state, seq: Number(c.seq) };
}

/** Registry of open runtimes with idle eviction. */
export class RuntimeRegistry {
  private readonly runtimes = new Map<string, CaseRuntime>();
  constructor(
    private readonly db: Db,
    private readonly idleMs = 10 * 60_000,
  ) {}

  get(caseId: string): CaseRuntime {
    let rt = this.runtimes.get(caseId);
    if (!rt) {
      rt = new CaseRuntime(this.db, caseId);
      this.runtimes.set(caseId, rt);
    }
    rt.lastUsed = Date.now();
    return rt;
  }

  peek(caseId: string): CaseRuntime | undefined {
    return this.runtimes.get(caseId);
  }

  drop(caseId: string): void {
    const rt = this.runtimes.get(caseId);
    if (rt) rt.snapshot();
    this.runtimes.delete(caseId);
  }

  evictIdle(now = Date.now()): string[] {
    const evicted: string[] = [];
    for (const [id, rt] of this.runtimes) {
      if (rt.clients.size === 0 && now - rt.lastUsed > this.idleMs) {
        rt.snapshot();
        this.runtimes.delete(id);
        evicted.push(id);
      }
    }
    return evicted;
  }

  closeAll(): void {
    for (const rt of this.runtimes.values()) rt.snapshot();
    this.runtimes.clear();
  }
}
