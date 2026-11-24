/**
 * Who hears about a task change. Shared by the server (which stores and sends notifications)
 * and the web client (which shows the preferences grid and words each notification).
 *
 * An op is read as the difference between the state before and after it, so a batch, an
 * import or a revert notifies exactly as the same changes made one by one would, and one
 * person hears about a bulk change once.
 *
 * Some notifications are always sent because they ask something of the person: being
 * assigned, being @mentioned, being asked to approve. The rest follow a grid of what happened
 * × how the person is related to the task, which each person can change. Nobody is told about
 * their own changes.
 */
import { z } from 'zod';
import type { TaskOp } from './ops.js';
import { flattenTaskOp, MAX_TASK_BATCH, taskOpSize } from './ops.js';
import { mentionsIn } from './refs.js';
import type { Task, TaskState } from './types.js';

/** Always sent, whatever the person's preferences say. */
export const DIRECT_KINDS = ['assigned', 'mention', 'approval_requested'] as const;
/** Sent according to the preferences grid. */
export const GRID_KINDS = [
  'status',
  'comment',
  'edited',
  'approval_decided',
  'due_soon',
  'overdue',
] as const;
export type DirectKind = (typeof DIRECT_KINDS)[number];
export type GridKind = (typeof GRID_KINDS)[number];
/** `queued`: a task landed in the queue of a team the person is on, with nobody assigned. */
export type NotifyKind = DirectKind | GridKind | 'queued';
export const NOTIFY_KINDS: readonly NotifyKind[] = [...DIRECT_KINDS, ...GRID_KINDS, 'queued'];

export const NOTIFY_RELATIONS = ['assignee', 'follower', 'creator', 'approver'] as const;
export type NotifyRelation = (typeof NOTIFY_RELATIONS)[number];

/** Most important first: a notification is titled by the first of its kinds in this order. */
const KIND_RANK: readonly NotifyKind[] = [
  'mention',
  'approval_requested',
  'assigned',
  'overdue',
  'approval_decided',
  'due_soon',
  'comment',
  'status',
  'queued',
  'edited',
];
export const leadKind = (kinds: Iterable<NotifyKind>): NotifyKind => {
  const set = new Set(kinds);
  return KIND_RANK.find((k) => set.has(k)) ?? 'edited';
};

export interface NotifyPrefs {
  grid: Record<GridKind, Record<NotifyRelation, boolean>>;
  /** Tell me when a task lands in my team's queue. */
  queue: boolean;
  /** Start following a task when I… (each can be turned off). */
  autoFollow: { created: boolean; assigned: boolean; commented: boolean; approver: boolean };
}

const row = (assignee: boolean, follower: boolean, creator: boolean, approver: boolean) => ({
  assignee,
  follower,
  creator,
  approver,
});

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  grid: {
    status: row(true, true, true, true),
    comment: row(true, true, true, true),
    edited: row(true, true, false, false),
    approval_decided: row(true, true, true, false),
    due_soon: row(true, false, false, false),
    overdue: row(true, false, false, false),
  },
  queue: false,
  autoFollow: { created: true, assigned: true, commented: true, approver: true },
};

const RowSchema = z
  .object({
    assignee: z.boolean(),
    follower: z.boolean(),
    creator: z.boolean(),
    approver: z.boolean(),
  })
  .partial()
  .strict();

/** What a client may send: any part of the preferences; the rest keeps its current value. */
export const NotifyPrefsPatchSchema = z
  .object({
    grid: z
      .object(
        Object.fromEntries(GRID_KINDS.map((k) => [k, RowSchema])) as Record<
          GridKind,
          typeof RowSchema
        >,
      )
      .partial()
      .strict(),
    queue: z.boolean(),
    autoFollow: z
      .object({
        created: z.boolean(),
        assigned: z.boolean(),
        commented: z.boolean(),
        approver: z.boolean(),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();
export type NotifyPrefsPatch = z.infer<typeof NotifyPrefsPatchSchema>;

/**
 * Stored preferences laid over the defaults. Unknown or malformed parts are ignored, so a
 * newer default (a kind added later) applies to people who saved preferences before it existed.
 */
export function mergeNotifyPrefs(base: NotifyPrefs, patch: unknown): NotifyPrefs {
  const p = NotifyPrefsPatchSchema.safeParse(patch);
  if (!p.success) return base;
  const grid = { ...base.grid };
  for (const k of GRID_KINDS) grid[k] = { ...base.grid[k], ...defined(p.data.grid?.[k]) };
  return {
    grid,
    queue: p.data.queue ?? base.queue,
    autoFollow: { ...base.autoFollow, ...defined(p.data.autoFollow) },
  };
}

function defined<T extends object>(
  o: T | undefined,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/** How each person is related to a task. */
export function relationsTo(task: Task): Map<string, Set<NotifyRelation>> {
  const out = new Map<string, Set<NotifyRelation>>();
  const add = (u: string, r: NotifyRelation): void => {
    if (!u) return;
    let s = out.get(u);
    if (!s) out.set(u, (s = new Set()));
    s.add(r);
  };
  for (const u of task.assignees) add(u, 'assignee');
  for (const u of task.followers) add(u, 'follower');
  add(task.createdBy, 'creator');
  if (task.approval) add(task.approval.approverId, 'approver');
  return out;
}

/** Something that happened to one task that someone may want to hear about. */
export interface TaskHappening {
  taskId: string;
  kind: NotifyKind;
  /** For direct kinds: exactly who it is for. */
  users?: string[] | undefined;
  commentId?: string | undefined;
}

/** Fields whose change counts as `edited`. Status, approval and followers have their own. */
const EDIT_FIELDS = [
  'title',
  'description',
  'priority',
  'runId',
  'labels',
  'dueAt',
  'caseId',
  'hostId',
  'eventId',
  'archived',
  'teamId',
] as const satisfies readonly (keyof Task)[];

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * What an op did, task by task. `userByName` resolves @mentions (lower-cased usernames).
 * Tasks the op removed (an undone create) produce nothing.
 */
export function taskHappenings(
  prev: TaskState,
  next: TaskState,
  userByName: ReadonlyMap<string, string>,
): TaskHappening[] {
  const out: TaskHappening[] = [];
  const mentioned = (before: string, after: string): string[] => {
    const had = new Set(mentionsIn(before));
    return mentionsIn(after)
      .filter((n) => !had.has(n))
      .map((n) => userByName.get(n))
      .filter((u): u is string => !!u);
  };

  for (const [id, n] of Object.entries(next.tasks)) {
    const p = prev.tasks[id];
    if (p === n) continue;
    if (!p) {
      if (n.assignees.length) out.push({ taskId: id, kind: 'assigned', users: n.assignees });
      else if (n.teamId) out.push({ taskId: id, kind: 'queued' });
      const m = mentioned('', n.description);
      if (m.length) out.push({ taskId: id, kind: 'mention', users: m });
      if (n.approval?.state === 'pending')
        out.push({ taskId: id, kind: 'approval_requested', users: [n.approval.approverId] });
      continue;
    }
    const added = n.assignees.filter((u) => !p.assignees.includes(u));
    if (added.length) out.push({ taskId: id, kind: 'assigned', users: added });
    if (!n.assignees.length && n.teamId && (n.teamId !== p.teamId || p.assignees.length))
      out.push({ taskId: id, kind: 'queued' });
    if (n.statusId !== p.statusId) out.push({ taskId: id, kind: 'status' });
    const m = mentioned(p.description, n.description);
    if (m.length) out.push({ taskId: id, kind: 'mention', users: m });
    const a = n.approval;
    if (a && a.state === 'pending' && a.requestedAt !== p.approval?.requestedAt)
      out.push({ taskId: id, kind: 'approval_requested', users: [a.approverId] });
    if (a && a.decidedAt && a.decidedAt !== p.approval?.decidedAt)
      out.push({ taskId: id, kind: 'approval_decided' });
    const edited =
      EDIT_FIELDS.some((f) => !same(p[f], n[f])) ||
      p.assignees.some((u) => !n.assignees.includes(u)) ||
      !same(p.checklist, n.checklist) ||
      !same(p.blockedBy, n.blockedBy) ||
      (!!p.approval && !a);
    if (edited) out.push({ taskId: id, kind: 'edited' });
  }

  for (const [cid, c] of Object.entries(next.comments)) {
    const before = prev.comments[cid];
    // A deleted comment brought back by an undo was already announced once.
    if (before === c || before?.deletedAt || !next.tasks[c.taskId] || c.deletedAt) continue;
    if (!before) out.push({ taskId: c.taskId, kind: 'comment', commentId: cid });
    const m = mentioned(before?.body ?? '', c.body);
    if (m.length) out.push({ taskId: c.taskId, kind: 'mention', users: m, commentId: cid });
  }
  return out;
}

export interface Recipient {
  userId: string;
  taskIds: string[];
  kinds: NotifyKind[];
  commentIds: string[];
}

/**
 * Who hears about the happenings, one entry per person. `actorId` is never told; `prefsOf`
 * gives each person's preferences; `teamMembers` lists a team's members for queue notices;
 * `canNotify` is the last word on whether a person may hear about a task at all (they can see
 * it, they're not disabled).
 */
export function notifyRecipients(
  state: TaskState,
  happenings: readonly TaskHappening[],
  o: {
    actorId: string;
    prefsOf: (userId: string) => NotifyPrefs;
    teamMembers: (teamId: string) => readonly string[];
    canNotify: (userId: string, task: Task) => boolean;
  },
): Recipient[] {
  const by = new Map<
    string,
    { tasks: Set<string>; kinds: Set<NotifyKind>; comments: Set<string> }
  >();
  const give = (u: string, task: Task, h: TaskHappening): void => {
    if (!u || u === o.actorId || !o.canNotify(u, task)) return;
    let r = by.get(u);
    if (!r) by.set(u, (r = { tasks: new Set(), kinds: new Set(), comments: new Set() }));
    r.tasks.add(task.id);
    r.kinds.add(h.kind);
    if (h.commentId) r.comments.add(h.commentId);
  };
  for (const h of happenings) {
    const task = state.tasks[h.taskId];
    if (!task) continue;
    if (h.users) {
      for (const u of h.users) give(u, task, h);
    } else if (h.kind === 'queued') {
      for (const u of o.teamMembers(task.teamId)) if (o.prefsOf(u).queue) give(u, task, h);
    } else {
      const kind = h.kind as GridKind;
      for (const [u, rels] of relationsTo(task)) {
        const want = o.prefsOf(u).grid[kind];
        if ([...rels].some((r) => want[r])) give(u, task, h);
      }
    }
  }
  return [...by].map(([userId, r]) => ({
    userId,
    taskIds: [...r.tasks],
    kinds: KIND_RANK.filter((k) => r.kinds.has(k)),
    commentIds: [...r.comments],
  }));
}

/**
 * Follow ops to log with an op, from people's auto-follow preferences: the actor follows what
 * they create, comment on or decide; new assignees and approvers follow what they're given.
 * They're logged as part of the op, so the followers list stays the one place that says who
 * follows what, and anyone can unfollow.
 */
export function autoFollowOps(
  prev: TaskState,
  next: TaskState,
  op: TaskOp,
  actorId: string,
  prefsOf: (userId: string) => NotifyPrefs,
): TaskOp[] {
  const want = new Map<string, Set<string>>();
  const follow = (taskId: string, u: string, why: keyof NotifyPrefs['autoFollow']): void => {
    const t = next.tasks[taskId];
    if (!u || !t || t.followers.includes(u) || !prefsOf(u).autoFollow[why]) return;
    let s = want.get(taskId);
    if (!s) want.set(taskId, (s = new Set()));
    s.add(u);
  };
  for (const [id, n] of Object.entries(next.tasks)) {
    const p = prev.tasks[id];
    if (p === n) continue;
    if (!p && n.createdBy === actorId) follow(id, actorId, 'created');
    for (const u of n.assignees) if (!p?.assignees.includes(u)) follow(id, u, 'assigned');
    const a = n.approval;
    if (a && a.approverId !== p?.approval?.approverId) follow(id, a.approverId, 'approver');
    if (a && a.decidedAt && a.decidedAt !== p?.approval?.decidedAt)
      follow(id, a.decidedBy, 'approver');
  }
  for (const l of flattenTaskOp(op))
    if (l.type === 'comment.add') follow(l.comment.taskId, actorId, 'commented');
  const ops: TaskOp[] = [];
  for (const [id, users] of want)
    for (const u of [...users].sort()) ops.push({ type: 'task.follow', id, userId: u, on: true });
  // A batch already at the size limit stays as it is.
  return taskOpSize(op) + ops.length > MAX_TASK_BATCH ? [] : ops;
}

/** A notification as the inbox shows it. Only tasks the person can still see are listed. */
export interface NotificationView {
  id: string;
  kind: NotifyKind;
  kinds: NotifyKind[];
  tasks: { id: string; num: number; title: string }[];
  /** Who made the changes; empty for reminders. */
  actors: { id: string; name: string }[];
  /** Comments it is about, newest last, cut short. */
  comments: { id: string; taskId: string; excerpt: string }[];
  /** How many changes were folded into it. */
  count: number;
  createdAt: string;
  updatedAt: string;
  read: boolean;
}

/** What a webhook can be told about. */
export const WEBHOOK_EVENTS = [
  'created',
  'assigned',
  'status',
  'done',
  'comment',
  'approval_requested',
  'approval_decided',
  'overdue',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  created: 'Task created',
  assigned: 'Task assigned',
  status: 'Status changed',
  done: 'Task finished (done or cancelled)',
  comment: 'New comment',
  approval_requested: 'Approval requested',
  approval_decided: 'Approval decided',
  overdue: 'Task overdue',
};

export const NOTIFY_KIND_LABELS: Record<NotifyKind, string> = {
  assigned: 'Assigned to me',
  mention: 'Mentioned me',
  approval_requested: 'Asked me to approve',
  status: 'Status changes',
  comment: 'Comments',
  edited: 'Other edits',
  approval_decided: 'Approval decisions',
  due_soon: 'Due within a day',
  overdue: 'Overdue',
  queued: 'New in my team’s queue',
};

export const NOTIFY_RELATION_LABELS: Record<NotifyRelation, string> = {
  assignee: 'Assigned to me',
  follower: 'I follow',
  creator: 'I created',
  approver: 'I approve',
};
