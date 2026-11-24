/**
 * The task channel on the shared WebSocket. Every signed-in browser joins it; each gets a
 * snapshot of the live tasks it may see, then every committed op as it may see it.
 *
 * Fan-out is per client because visibility is per person. For each op, each task it touches is
 * one of: kept (visible to this client before and after), hidden (it just lost sight of it:
 * moved into a restricted case, archived, run closed), shown (it just gained sight of it) or
 * invisible. Leaves about anything but kept tasks are removed; shown tasks arrive whole and
 * hidden ones are named for the client to drop. Task numbers are stamped into the op by the
 * server, so a client that never sees some of a batch still numbers the rest correctly.
 */
import {
  flattenTaskOp,
  taskIdsOf,
  type ServerMessage,
  type Task,
  type TaskComment,
  type TaskDirectory,
  type TaskOp,
  type TaskState,
} from '@midden/core';
import type { Db } from '../db/db.js';
import { findUserById, listUsers, type User } from '../auth/sessions.js';
import { listTeams } from '../teams/teams.js';
import type { TaskCommit, TaskRuntime } from './runtime.js';
import {
  canSeeCase,
  canSeeTask,
  isLiveTask,
  viewerFor,
  visibleState,
  type TaskViewer,
} from './visibility.js';

export interface TaskClient {
  id: string;
  user: User;
  send(msg: ServerMessage): void;
  /** Close the socket (the user was disabled). */
  close(): void;
}

interface Joined extends TaskClient {
  viewer: TaskViewer;
}

const BROAD = new Set<TaskOp['type']>([
  'run.set',
  'run.put',
  'run.drop',
  'workflow.set',
  'workflow.default',
]);

export class TaskChannel {
  private readonly clients = new Map<string, Joined>();

  constructor(
    private readonly db: Db,
    private readonly runtime: TaskRuntime,
  ) {
    runtime.onCommit((c) => this.fanOut(c));
    runtime.onDirectoryChange(() => this.resyncAll());
  }

  get size(): number {
    return this.clients.size;
  }

  join(client: TaskClient): void {
    const joined: Joined = { ...client, viewer: viewerFor(this.db, client.user) };
    this.clients.set(client.id, joined);
    joined.send(this.snapshotFor(joined));
  }

  /** Send to every socket the person has open. */
  sendToUser(userId: string, msg: ServerMessage): void {
    for (const c of this.clients.values()) if (c.user.id === userId) c.send(msg);
  }

  leave(id: string): void {
    this.clients.delete(id);
  }

  has(id: string): boolean {
    return this.clients.has(id);
  }

  directoryFor(v: TaskViewer): TaskDirectory {
    const cases = this.db
      .all<{ id: string; name: string; number: string; restricted: number }>(
        'SELECT id, name, number, restricted FROM cases ORDER BY name COLLATE NOCASE',
      )
      .filter((c) => v.user.role === 'admin' || canSeeCase(v, c.id))
      .map((c) => ({ id: c.id, name: c.name, number: c.number, restricted: !!c.restricted }));
    return {
      users: listUsers(this.db).map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        disabled: u.disabled,
      })),
      teams: listTeams(this.db).map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        members: t.members.map((m) => ({ userId: m.userId, role: m.role })),
      })),
      cases,
    };
  }

  private snapshotFor(c: Joined): ServerMessage {
    return {
      t: 'tasks.snapshot',
      seq: this.runtime.seq,
      state: visibleState(this.runtime.state, c.viewer, { live: true }),
      directory: this.directoryFor(c.viewer),
    };
  }

  /** Teams, users or case access changed: re-read who each client is and resend everything. */
  resyncAll(): void {
    for (const c of [...this.clients.values()]) {
      const user = findUserById(this.db, c.user.id);
      if (!user || user.disabled) {
        this.clients.delete(c.id);
        c.close();
        continue;
      }
      c.user = user;
      c.viewer = viewerFor(this.db, user);
      c.send(this.snapshotFor(c));
    }
  }

  private fanOut(commit: TaskCommit): void {
    for (const c of this.clients.values()) c.send(filterCommit(commit, c.viewer));
  }
}

/** The message one viewer gets for a commit. Exported for tests. */
export function filterCommit(commit: TaskCommit, v: TaskViewer): ServerMessage {
  const { prev, next, op } = commit;
  const leaves = flattenTaskOp(op);
  const live = (s: TaskState, t: Task | undefined): boolean =>
    !!t && canSeeTask(v, t) && isLiveTask(s, t);
  const lookup = (cid: string): string | undefined =>
    next.comments[cid]?.taskId ?? prev.comments[cid]?.taskId;

  const created = new Set<string>();
  for (const l of leaves)
    if (l.type === 'task.add' && !prev.tasks[l.task.id]) created.add(l.task.id);
  const candidates = new Set(taskIdsOf(op, lookup));
  if (leaves.some((l) => BROAD.has(l.type)))
    for (const id of new Set([...Object.keys(prev.tasks), ...Object.keys(next.tasks)]))
      candidates.add(id);

  const kept = new Set<string>();
  const show: string[] = [];
  const hide: string[] = [];
  for (const id of candidates) {
    const before = live(prev, prev.tasks[id]);
    const after = live(next, next.tasks[id]);
    if ((before && after) || (created.has(id) && after)) kept.add(id);
    else if (before && !after) hide.push(id);
    else if (!before && after) show.push(id);
  }

  let changed = false;
  const out: TaskOp[] = [];
  for (const l of leaves) {
    if (l.type === 'task.assign') {
      const ids = l.ids.filter((id) => kept.has(id));
      if (ids.length !== l.ids.length) changed = true;
      if (ids.length) out.push(ids.length === l.ids.length ? l : { ...l, ids });
      continue;
    }
    const ids = taskIdsOf(l, lookup);
    if (ids.every((id) => kept.has(id))) out.push(l);
    else changed = true;
  }
  const visibleOp: TaskOp = !changed
    ? op
    : out.length === 0
      ? { type: 'noop' }
      : out.length === 1
        ? out[0]!
        : { type: 'batch', ops: out };

  const showTasks = show.map((id) => next.tasks[id]!);
  const showIds = new Set(show);
  const showComments: TaskComment[] = show.length
    ? Object.values(next.comments).filter((c) => showIds.has(c.taskId))
    : [];
  return {
    t: 'tasks.op',
    seq: commit.seq,
    op: visibleOp,
    actor: commit.actor,
    ts: commit.ts,
    clientOpId: commit.clientOpId,
    ...(show.length ? { show: { tasks: showTasks, comments: showComments } } : {}),
    ...(hide.length ? { hide } : {}),
  };
}
