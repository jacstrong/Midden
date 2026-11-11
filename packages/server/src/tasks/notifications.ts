/**
 * Turns committed ops into notices for the people on a task, stores them, and pushes them to
 * any socket those people have open. `taskNotices` in core decides who is owed what; this adds
 * the two things only the server knows: who follows a task, and who may still read the case.
 * Someone who has lost access to a case is not told about it, even if they still follow a task.
 */
import {
  taskNotices,
  type Actor,
  type CaseState,
  type Op,
  type TaskNotification,
} from '@midden/core';
import type { Db } from '../db/db.js';
import { caseAccess, type CaseRow } from '../auth/permissions.js';
import { findUserById } from '../auth/sessions.js';
import { newId } from '../lib/ids.js';

type Send = (msg: unknown) => void;

/** Every open socket per user, whichever case room it is in, for pushing notices. */
export class UserChannels {
  private readonly byUser = new Map<string, Map<string, Send>>();

  add(userId: string, socketId: string, send: Send): void {
    let m = this.byUser.get(userId);
    if (!m) {
      m = new Map();
      this.byUser.set(userId, m);
    }
    m.set(socketId, send);
  }

  remove(userId: string, socketId: string): void {
    const m = this.byUser.get(userId);
    if (!m) return;
    m.delete(socketId);
    if (!m.size) this.byUser.delete(userId);
  }

  send(userId: string, msg: unknown): void {
    for (const send of this.byUser.get(userId)?.values() ?? []) send(msg);
  }
}

export interface CommitEvent {
  caseId: string;
  seq: number;
  ts: string;
  actor: Actor;
  prev: CaseState;
  op: Op;
  next: CaseState;
}

export interface NotificationRow {
  id: string;
  case_id: string;
  case_name: string;
  task_id: string | null;
  seq: number;
  kind: string;
  actor_id: string;
  actor_name: string;
  text: string;
  created_at: string;
  read_at: string | null;
}

export const toNotification = (r: NotificationRow): TaskNotification => ({
  id: r.id,
  caseId: r.case_id,
  caseName: r.case_name,
  taskId: r.task_id,
  seq: Number(r.seq),
  kind: r.kind,
  actor: { id: r.actor_id, name: r.actor_name },
  text: r.text,
  createdAt: r.created_at,
  readAt: r.read_at,
});

/** Cheap enough to run on every op: most ops touch no task and return before any query. */
export function notifyTaskChanges(db: Db, channels: UserChannels, e: CommitEvent): number {
  if (!touchesTasks(e.op)) return 0;
  const follows = new Map<string, string[]>();
  for (const r of db.all<{ task_id: string; user_id: string }>(
    'SELECT task_id, user_id FROM task_follows WHERE case_id = ?',
    e.caseId,
  )) {
    const list = follows.get(r.task_id) ?? [];
    list.push(r.user_id);
    follows.set(r.task_id, list);
  }
  const notices = taskNotices({
    prev: e.prev,
    op: e.op,
    next: e.next,
    actorId: e.actor.id,
    followers: (id) => follows.get(id) ?? [],
  });
  if (!notices.length) return 0;

  const row = db.get<CaseRow & { name: string }>(
    'SELECT id, name, restricted, archived_at FROM cases WHERE id = ?',
    e.caseId,
  );
  if (!row) return 0;
  const allowed = new Map<string, boolean>();
  const mayRead = (userId: string): boolean => {
    let ok = allowed.get(userId);
    if (ok === undefined) {
      const user = findUserById(db, userId);
      ok = !!user && !user.disabled && caseAccess(db, user, row).read;
      allowed.set(userId, ok);
    }
    return ok;
  };

  const out: Array<{ recipient: string; item: TaskNotification }> = [];
  db.transaction(() => {
    for (const n of notices) {
      if (!mayRead(n.recipient)) continue;
      const item: TaskNotification = {
        id: newId('ntf'),
        caseId: e.caseId,
        caseName: row.name,
        taskId: n.kind === 'summary' ? null : n.taskId,
        seq: e.seq,
        kind: n.kind,
        actor: e.actor,
        text: n.text,
        createdAt: e.ts,
        readAt: null,
      };
      db.run(
        'INSERT INTO notifications (id, user_id, case_id, task_id, seq, kind, actor_id, actor_name, text, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        item.id,
        n.recipient,
        item.caseId,
        item.taskId,
        item.seq,
        item.kind,
        item.actor.id,
        item.actor.name,
        item.text,
        item.createdAt,
      );
      out.push({ recipient: n.recipient, item });
    }
    for (const userId of new Set(notices.map((n) => n.recipient)))
      if (allowed.get(userId)) pruneNotifications(db, userId);
  });
  // Pushed only once the rows are committed, so a client that fetches on a push finds them.
  for (const { recipient, item } of out)
    channels.send(recipient, { t: 'notify', notification: item });
  return out.length;
}

function touchesTasks(op: Op): boolean {
  switch (op.type) {
    case 'task.add':
    case 'task.set':
    case 'task.remove':
    case 'comment.add':
      return true;
    case 'batch':
      return op.ops.some(touchesTasks);
    case 'op.revert':
      return touchesTasks(op.inverse);
    default:
      return false;
  }
}

/** Keep each person's notices bounded: the newest are what matter on a hunt. */
export const NOTIFICATIONS_KEPT = 500;

export function pruneNotifications(db: Db, userId: string): void {
  db.run(
    `DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
       SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
    userId,
    userId,
    NOTIFICATIONS_KEPT,
  );
}
