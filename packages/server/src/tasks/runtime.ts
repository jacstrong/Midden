/**
 * The task runtime: one global, in-memory TaskState over the task op log. It mirrors
 * `CaseRuntime` (cases/runtime.ts): `appendOp` is the single write path, in this order:
 * parse → client-safety → size → duplicate → permission → data check → inverse → seq → insert
 * → project → commit → notify listeners.
 */
import {
  applyAllTaskOps,
  applyTaskOp,
  autoFollowOps,
  checkTaskOp,
  emptyTaskState,
  inverseTaskOp,
  isClientSafeTaskOp,
  parseTaskOp,
  stampTaskNums,
  taskOpSize,
  taskTouchedFields,
  MAX_TASK_BATCH,
  type Actor,
  type Overwrite,
  type RejectCode,
  type TaskBroadcast,
  type TaskOp,
  type TaskState,
} from '@midden/core';
import type { Db } from '../db/db.js';
import type { User } from '../auth/sessions.js';
import { nowIso } from '../lib/ids.js';
import { actorName, type OpActor, type Touch } from '../cases/runtime.js';
import { NotifyPrefsStore } from '../notify/prefs.js';
import { checkTaskPermission } from './permissions.js';
import { opTaskIds, projectTaskOp } from './projection.js';

export const TASK_SNAPSHOT_EVERY = 500;

export interface TaskCommit {
  seq: number;
  op: TaskOp;
  actor: Actor;
  via: string | undefined;
  ts: string;
  clientOpId: string | undefined;
  prev: TaskState;
  next: TaskState;
}

export type TaskAppendResult =
  | { ok: true; seq: number; broadcast: TaskBroadcast; overwrote: Overwrite[]; duplicate: boolean }
  | { ok: false; code: RejectCode; message: string };

export interface TaskAppendOptions {
  /** Who is acting, for permission checks. */
  user: User;
  clientOpId?: string | undefined;
  baseSeq?: number | undefined;
  /** The request authenticated with an API token. */
  viaToken: boolean;
  /** Server-built ops (reverts): skip the client-safety check, not the permission check. */
  internal?: boolean | undefined;
  /** Run every check, then stop: nothing is logged or applied (an import's preview). */
  dryRun?: boolean | undefined;
}

export class TaskRuntime {
  state: TaskState;
  seq: number;
  readonly lastTouch = new Map<string, Touch>();
  /** Notification preferences, which also say who auto-follows what. */
  readonly prefs: NotifyPrefsStore;
  private readonly commitListeners = new Set<(c: TaskCommit) => void>();
  private readonly directoryListeners = new Set<() => void>();

  constructor(readonly db: Db) {
    this.prefs = new NotifyPrefsStore(db);
    const loaded = loadTaskState(db);
    this.state = loaded.state;
    this.seq = loaded.seq;
    this.rebuildTouches();
  }

  private userNames(): Map<string, string> {
    const names = new Map<string, string>();
    for (const r of this.db.all<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM users',
    ))
      names.set(r.id, r.display_name);
    return names;
  }

  private rebuildTouches(): void {
    const names = this.userNames();
    for (const r of this.db.all<{
      seq: number;
      actor_id: string;
      via: string | null;
      payload: string;
    }>('SELECT seq, actor_id, via, payload FROM task_ops ORDER BY seq')) {
      const actor = { id: r.actor_id, name: actorName(names.get(r.actor_id) ?? r.actor_id, r.via) };
      for (const f of taskTouchedFields(JSON.parse(r.payload) as TaskOp))
        this.lastTouch.set(f, { seq: Number(r.seq), actor });
    }
  }

  /** Called after every committed op, inside nothing: listeners may do I/O. */
  onCommit(fn: (c: TaskCommit) => void): () => void {
    this.commitListeners.add(fn);
    return () => this.commitListeners.delete(fn);
  }

  /** Teams, memberships, users or case access changed: who sees what may have changed. */
  onDirectoryChange(fn: () => void): () => void {
    this.directoryListeners.add(fn);
    return () => this.directoryListeners.delete(fn);
  }

  directoryChanged(): void {
    for (const fn of this.directoryListeners) fn();
  }

  overwrites(op: TaskOp, baseSeq: number, actor: Actor): Overwrite[] {
    const out: Overwrite[] = [];
    for (const f of taskTouchedFields(op)) {
      if (!f.includes('/') || f.endsWith('/*')) continue;
      const t = this.lastTouch.get(f);
      if (t && t.seq > baseSeq && t.actor.id !== actor.id)
        out.push({ field: f, bySeq: t.seq, byActor: t.actor });
    }
    return out;
  }

  appendOp({ via, ...actor }: OpActor, rawOp: unknown, opts: TaskAppendOptions): TaskAppendResult {
    let op: TaskOp;
    try {
      op = parseTaskOp(rawOp);
    } catch (err) {
      return {
        ok: false,
        code: 'schema',
        message: err instanceof Error ? err.message.slice(0, 300) : 'invalid op',
      };
    }
    if (!opts.internal && !isClientSafeTaskOp(op))
      return {
        ok: false,
        code: 'schema',
        message: 'That operation can only be made by the server',
      };
    if (taskOpSize(op) > MAX_TASK_BATCH)
      return {
        ok: false,
        code: 'too_large',
        message: `Batch exceeds ${MAX_TASK_BATCH} operations`,
      };

    if (opts.clientOpId) {
      const dup = this.db.get<{ seq: number; ts: string; payload: string }>(
        'SELECT seq, ts, payload FROM task_ops WHERE client_op_id = ?',
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
            op: JSON.parse(dup.payload) as TaskOp,
            actor,
            ts: dup.ts,
            clientOpId: opts.clientOpId,
          },
        };
      }
    }

    op = stampTaskNums(op, this.state.nextNum);
    const ts = nowIso();
    const ctx = { actorId: actor.id, ts };
    const refused = checkTaskPermission({
      db: this.db,
      user: opts.user,
      viaToken: opts.viaToken,
      state: this.state,
      op,
      ctx,
    });
    if (refused) return { ok: false, ...refused };
    const invalid = checkTaskOp(this.state, op, ctx);
    if (invalid)
      return {
        ok: false,
        code: /does not exist/.test(invalid) ? 'notfound' : 'conflict',
        message: invalid,
      };
    if (opts.dryRun)
      return {
        ok: true,
        seq: this.seq,
        duplicate: false,
        overwrote: [],
        broadcast: { seq: this.seq, op, actor, ts, clientOpId: opts.clientOpId },
      };

    const prev = this.state;
    const baseSeq = opts.baseSeq ?? this.seq;
    const overwrote = this.overwrites(op, baseSeq, actor);
    let next = applyTaskOp(prev, op, ctx);
    // Auto-follows are logged as part of the op, so they undo with it. Not for undos.
    if (!opts.internal && op.type !== 'op.revert') {
      const follows = autoFollowOps(prev, next, op, actor.id, (u) => this.prefs.get(u));
      if (follows.length) {
        next = applyTaskOp(next, { type: 'batch', ops: follows }, ctx);
        op = { type: 'batch', ops: [...(op.type === 'batch' ? op.ops : [op]), ...follows] };
      }
    }
    const inv = inverseTaskOp(prev, op);
    const seq = this.db.transaction(() => {
      const s = Number(
        this.db.get<{ seq: number }>('UPDATE task_log SET seq = seq + 1 WHERE id = 1 RETURNING seq')
          ?.seq,
      );
      this.db.run(
        'INSERT INTO task_ops (seq, actor_id, via, ts, client_op_id, base_seq, type, payload, inverse) VALUES (?,?,?,?,?,?,?,?,?)',
        s,
        actor.id,
        via ?? null,
        ts,
        opts.clientOpId ?? null,
        opts.baseSeq ?? null,
        op.type,
        JSON.stringify(op),
        JSON.stringify(inv),
      );
      for (const id of opTaskIds(op, prev, next))
        this.db.run('INSERT OR IGNORE INTO task_op_tasks (seq, task_id) VALUES (?,?)', s, id);
      projectTaskOp(this.db, op, prev, next, { seq: s, ts, actorId: actor.id });
      if (s % TASK_SNAPSHOT_EVERY === 0)
        this.db.run(
          'INSERT OR REPLACE INTO task_snapshots (seq, state, created_at) VALUES (?,?,?)',
          s,
          JSON.stringify(next),
          ts,
        );
      return s;
    });
    this.state = next;
    this.seq = seq;
    for (const f of taskTouchedFields(op)) this.lastTouch.set(f, { seq, actor });
    const broadcast: TaskBroadcast = { seq, op, actor, ts, clientOpId: opts.clientOpId };
    const commit: TaskCommit = { seq, op, actor, via, ts, clientOpId: opts.clientOpId, prev, next };
    for (const fn of this.commitListeners) fn(commit);
    return { ok: true, seq, broadcast, overwrote, duplicate: false };
  }

  /** Logged ops after `afterSeq`, oldest first, with actor names as they read now. */
  opsAfter(afterSeq: number, limit = 10_000): TaskBroadcast[] {
    const names = this.userNames();
    return this.db
      .all<{
        seq: number;
        actor_id: string;
        via: string | null;
        ts: string;
        client_op_id: string | null;
        payload: string;
      }>(
        'SELECT seq, actor_id, via, ts, client_op_id, payload FROM task_ops WHERE seq > ? ORDER BY seq LIMIT ?',
        afterSeq,
        limit,
      )
      .map((r) => ({
        seq: Number(r.seq),
        op: JSON.parse(r.payload) as TaskOp,
        actor: { id: r.actor_id, name: actorName(names.get(r.actor_id) ?? r.actor_id, r.via) },
        ts: r.ts,
        clientOpId: r.client_op_id ?? undefined,
      }));
  }

  snapshot(): void {
    this.db.run(
      'INSERT OR REPLACE INTO task_snapshots (seq, state, created_at) VALUES (?,?,?)',
      this.seq,
      JSON.stringify(this.state),
      nowIso(),
    );
  }
}

export function loadTaskState(db: Db): { state: TaskState; seq: number } {
  const seq = Number(db.get<{ seq: number }>('SELECT seq FROM task_log WHERE id = 1')?.seq ?? 0);
  const snap = db.get<{ seq: number; state: string }>(
    'SELECT seq, state FROM task_snapshots ORDER BY seq DESC LIMIT 1',
  );
  const base = snap ? (JSON.parse(snap.state) as TaskState) : emptyTaskState();
  const rows = db.all<{ actor_id: string; ts: string; payload: string }>(
    'SELECT actor_id, ts, payload FROM task_ops WHERE seq > ? ORDER BY seq',
    snap ? Number(snap.seq) : 0,
  );
  const state = applyAllTaskOps(
    base,
    rows.map((r) => ({
      op: JSON.parse(r.payload) as TaskOp,
      ctx: { actorId: r.actor_id, ts: r.ts },
    })),
  );
  return { state, seq };
}
