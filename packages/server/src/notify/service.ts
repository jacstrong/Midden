/**
 * In-app notifications. Every committed task op is read for what it did (`taskHappenings`),
 * who should hear about it (`notifyRecipients`, by preference and visibility), and stored as
 * one row per person. A person's open tabs get it over the socket at once.
 *
 * Rows hold ids, not text: titles and comment excerpts are read from the task state when a
 * notification is shown, and a task the person can no longer see drops out of it (a
 * notification left with no visible task isn't shown or counted at all).
 *
 * The reminder pass, run on a timer, sends "due within a day" and "overdue" once per task and
 * due date.
 */
import {
  isTaskOpen,
  leadKind,
  notifyRecipients,
  taskHappenings,
  type NotificationView,
  type NotifyKind,
  type Task,
  type TaskHappening,
  type TaskState,
} from '@midden/core';
import type { Db } from '../db/db.js';
import { listUsers, type User } from '../auth/sessions.js';
import { newId } from '../lib/ids.js';
import { membersOf } from '../teams/teams.js';
import type { TaskChannel } from '../tasks/channel.js';
import type { TaskCommit, TaskRuntime } from '../tasks/runtime.js';
import { canSeeTask, isLiveTask, viewerFor, type TaskViewer } from '../tasks/visibility.js';
import type { NotifyPrefsStore } from './prefs.js';

/** Changes to one task within this long fold into the same unread notification. */
export const MERGE_WINDOW_MS = 2 * 60_000;
export const DUE_SOON_MS = 24 * 3600_000;
const EXCERPT = 200;

interface Row {
  id: string;
  user_id: string;
  kind: NotifyKind;
  kinds: string;
  task_ids: string;
  actor_ids: string;
  comment_ids: string;
  group_key: string;
  count: number;
  created_at: string;
  updated_at: string;
  read_at: string | null;
}

export interface NotifyOptions {
  now?: () => Date;
  /** Told what each commit did, for webhooks. */
  onHappenings?: (c: TaskCommit, h: TaskHappening[]) => void;
  /** Told which tasks just became overdue, for webhooks. */
  onOverdue?: (state: TaskState, tasks: Task[]) => void;
  /** Told each time a notification is delivered (new or folded into one), for metrics. */
  onStored?: (kind: NotifyKind) => void;
  log?: (err: unknown) => void;
}

export class NotifyService {
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    private readonly runtime: TaskRuntime,
    private readonly channel: TaskChannel,
    private readonly prefs: NotifyPrefsStore,
    private readonly opts: NotifyOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    runtime.onCommit((c) => {
      // A failure here must not fail the change that was just committed.
      try {
        this.onCommit(c);
      } catch (err) {
        opts.log?.(err);
      }
    });
  }

  private onCommit(c: TaskCommit): void {
    const users = listUsers(this.db);
    const byName = new Map(users.map((u) => [u.username.toLowerCase(), u.id]));
    const happenings = taskHappenings(c.prev, c.next, byName);
    this.opts.onHappenings?.(c, happenings);
    if (happenings.length) this.deliver(c.next, happenings, c.actor.id, `op:${c.seq}`, users);
  }

  /** Store and push notifications for happenings. `group` keys a change to several tasks. */
  private deliver(
    state: TaskState,
    happenings: TaskHappening[],
    actorId: string,
    group: string,
    users: User[] = listUsers(this.db),
  ): void {
    const byId = new Map(users.map((u) => [u.id, u]));
    const viewers = new Map<string, TaskViewer>();
    const viewer = (u: User): TaskViewer => {
      let v = viewers.get(u.id);
      if (!v) viewers.set(u.id, (v = viewerFor(this.db, u)));
      return v;
    };
    const teams = new Map<string, string[]>();
    const recipients = notifyRecipients(state, happenings, {
      actorId,
      prefsOf: (u) => this.prefs.get(u),
      teamMembers: (t) => {
        let m = teams.get(t);
        if (!m) teams.set(t, (m = [...membersOf(this.db, [t])]));
        return m;
      },
      canNotify: (u, task) => {
        const user = byId.get(u);
        return !!user && !user.disabled && canSeeTask(viewer(user), task);
      },
    });
    for (const r of recipients) {
      const key = r.taskIds.length === 1 ? `task:${r.taskIds[0]}` : group;
      const id = this.store(
        r.userId,
        key,
        r.kinds,
        r.taskIds,
        actorId ? [actorId] : [],
        r.commentIds,
      );
      const user = byId.get(r.userId)!;
      const row = this.db.get<Row>('SELECT * FROM notifications WHERE id = ?', id)!;
      const names = new Map(users.map((u) => [u.id, u.displayName]));
      const notification = this.view(row, viewer(user), names) ?? undefined;
      this.channel.sendToUser(r.userId, {
        t: 'notify',
        unread: this.unread(user),
        notification,
      });
    }
  }

  /** Insert a notification, or fold it into a recent unread one about the same task. */
  private store(
    userId: string,
    key: string,
    kinds: NotifyKind[],
    taskIds: string[],
    actorIds: string[],
    commentIds: string[],
  ): string {
    this.opts.onStored?.(leadKind(kinds));
    const now = this.now();
    const ts = now.toISOString();
    const recent =
      key.startsWith('task:') &&
      this.db.get<Row>(
        'SELECT * FROM notifications WHERE user_id = ? AND group_key = ? AND read_at IS NULL AND updated_at >= ? ORDER BY updated_at DESC LIMIT 1',
        userId,
        key,
        new Date(now.getTime() - MERGE_WINDOW_MS).toISOString(),
      );
    if (recent) {
      const union = <T>(a: string, b: T[]): T[] => [...new Set([...(JSON.parse(a) as T[]), ...b])];
      const allKinds = union<NotifyKind>(recent.kinds, kinds);
      // Latest actor last, so "Ann and Bob" reads in order.
      const actors = [
        ...(JSON.parse(recent.actor_ids) as string[]).filter((a) => !actorIds.includes(a)),
        ...actorIds,
      ];
      this.db.run(
        'UPDATE notifications SET kind = ?, kinds = ?, actor_ids = ?, comment_ids = ?, count = count + 1, updated_at = ? WHERE id = ?',
        leadKind(allKinds),
        JSON.stringify(allKinds),
        JSON.stringify(actors),
        JSON.stringify(union(recent.comment_ids, commentIds)),
        ts,
        recent.id,
      );
      return recent.id;
    }
    const id = newId('nt');
    this.db.run(
      'INSERT INTO notifications (id, user_id, kind, kinds, task_ids, actor_ids, comment_ids, group_key, count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)',
      id,
      userId,
      leadKind(kinds),
      JSON.stringify(kinds),
      JSON.stringify(taskIds),
      JSON.stringify(actorIds),
      JSON.stringify(commentIds),
      key,
      ts,
      ts,
    );
    return id;
  }

  /** A row as the person may see it, or null if none of its tasks are visible to them. */
  private view(row: Row, v: TaskViewer, names: Map<string, string>): NotificationView | null {
    const state = this.runtime.state;
    const tasks = (JSON.parse(row.task_ids) as string[])
      .map((id) => state.tasks[id])
      .filter((t): t is Task => !!t && canSeeTask(v, t));
    if (!tasks.length) return null;
    const visible = new Set(tasks.map((t) => t.id));
    const comments = (JSON.parse(row.comment_ids) as string[])
      .map((id) => state.comments[id])
      .filter((c) => !!c && !c.deletedAt && visible.has(c.taskId))
      .map((c) => ({
        id: c!.id,
        taskId: c!.taskId,
        excerpt: c!.body.length > EXCERPT ? `${c!.body.slice(0, EXCERPT - 1)}…` : c!.body,
      }));
    return {
      id: row.id,
      kind: row.kind,
      kinds: JSON.parse(row.kinds) as NotifyKind[],
      tasks: tasks.map((t) => ({ id: t.id, num: t.num, title: t.title })),
      actors: (JSON.parse(row.actor_ids) as string[]).map((id) => ({
        id,
        name: names.get(id) ?? 'Someone',
      })),
      comments,
      count: Number(row.count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      read: !!row.read_at,
    };
  }

  /** Newest first. `before` pages by `updatedAt`. */
  list(
    user: User,
    o: { unreadOnly?: boolean; limit?: number | undefined; before?: string | undefined } = {},
  ): { notifications: NotificationView[]; unread: number } {
    const v = viewerFor(this.db, user);
    const names = new Map(listUsers(this.db).map((u) => [u.id, u.displayName]));
    const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
    const out: NotificationView[] = [];
    let before = o.before ?? '￿';
    // Read in pages, since some rows may turn out to be about tasks no longer visible.
    for (let pass = 0; pass < 10 && out.length < limit; pass++) {
      const rows = this.db.all<Row>(
        `SELECT * FROM notifications WHERE user_id = ? AND updated_at < ? ${o.unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY updated_at DESC LIMIT ?`,
        user.id,
        before,
        limit,
      );
      for (const r of rows) {
        const n = this.view(r, v, names);
        if (n && out.length < limit) out.push(n);
      }
      if (rows.length < limit) break;
      before = rows[rows.length - 1]!.updated_at;
    }
    return { notifications: out, unread: this.unread(user, v) };
  }

  /** Unread notifications the person can still see something of. */
  unread(user: User, v: TaskViewer = viewerFor(this.db, user)): number {
    const state = this.runtime.state;
    let n = 0;
    for (const r of this.db.all<{ task_ids: string }>(
      'SELECT task_ids FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY updated_at DESC LIMIT 1000',
      user.id,
    )) {
      const ids = JSON.parse(r.task_ids) as string[];
      if (ids.some((id) => state.tasks[id] && canSeeTask(v, state.tasks[id]))) n++;
    }
    return n;
  }

  /** Mark some (or all) of a person's notifications read, and tell their other tabs. */
  markRead(user: User, ids: string[] | 'all'): number {
    const ts = this.now().toISOString();
    if (ids === 'all')
      this.db.run(
        'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL',
        ts,
        user.id,
      );
    else
      for (const id of ids)
        this.db.run(
          'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL',
          ts,
          id,
          user.id,
        );
    const unread = this.unread(user);
    this.channel.sendToUser(user.id, { t: 'notify', unread, read: ids });
    return unread;
  }

  /** Send due-soon and overdue reminders not yet sent. Returns how many tasks it reminded. */
  runReminders(): number {
    const now = this.now();
    const ts = now.toISOString();
    const state = this.runtime.state;
    const due: Record<'due_soon' | 'overdue', TaskHappening[]> = { due_soon: [], overdue: [] };
    const overdue: Task[] = [];
    for (const t of Object.values(state.tasks)) {
      if (!t.dueAt || !isLiveTask(state, t) || !isTaskOpen(state, t)) continue;
      const at = Date.parse(t.dueAt);
      if (Number.isNaN(at)) continue;
      const kind =
        at <= now.getTime() ? 'overdue' : at - now.getTime() <= DUE_SOON_MS ? 'due_soon' : null;
      if (!kind) continue;
      const sent = this.db.run(
        'INSERT OR IGNORE INTO task_reminders (task_id, kind, due_at, sent_at) VALUES (?,?,?,?)',
        t.id,
        kind,
        t.dueAt,
        ts,
      );
      if (!sent.changes) continue;
      due[kind].push({ taskId: t.id, kind });
      if (kind === 'overdue') overdue.push(t);
    }
    for (const kind of ['overdue', 'due_soon'] as const)
      if (due[kind].length) this.deliver(state, due[kind], '', `reminder:${kind}:${ts}`);
    if (overdue.length) this.opts.onOverdue?.(state, overdue);
    // Reminders for tasks long gone, and notifications nobody will page back to.
    const old = new Date(now.getTime() - 90 * 24 * 3600_000).toISOString();
    this.db.run('DELETE FROM task_reminders WHERE sent_at < ?', old);
    this.db.run('DELETE FROM notifications WHERE read_at IS NOT NULL AND updated_at < ?', old);
    return due.due_soon.length + due.overdue.length;
  }
}
