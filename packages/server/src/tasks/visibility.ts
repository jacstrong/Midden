/**
 * Who can see which tasks. A task linked to a restricted case is visible only to people who
 * can read that case, everywhere: snapshots, broadcasts, REST, MCP, notifications, webhooks
 * and exports all go through `canSeeTask`. A task title can say more than the case name does.
 *
 * A task whose case no longer exists is shown only to admins: the case may have been
 * restricted, and deleting it must not publish its tasks to everyone.
 */
import type { Task, TaskComment, TaskState } from '@midden/core';
import type { Db } from '../db/db.js';
import { caseAccess, type CaseRow } from '../auth/permissions.js';
import type { User } from '../auth/sessions.js';

export interface TaskViewer {
  user: User;
  /** Case ids that exist. */
  known: Set<string>;
  /** Existing case ids this user cannot read. */
  hidden: Set<string>;
}

export function viewerFor(db: Db, user: User): TaskViewer {
  const rows = db.all<CaseRow>('SELECT id, restricted, archived_at FROM cases');
  const known = new Set<string>();
  const hidden = new Set<string>();
  for (const r of rows) {
    known.add(r.id);
    if (r.restricted && !caseAccess(db, user, r).read) hidden.add(r.id);
  }
  return { user, known, hidden };
}

export function canSeeCase(v: TaskViewer, caseId: string): boolean {
  return v.known.has(caseId) && !v.hidden.has(caseId);
}

export function canSeeTask(v: TaskViewer, task: Pick<Task, 'caseId'>): boolean {
  if (!task.caseId) return true;
  if (v.user.role === 'admin') return true;
  return canSeeCase(v, task.caseId);
}

/** Whether a task is part of the live set clients keep in memory (not archived, run not closed). */
export function isLiveTask(state: TaskState, task: Task): boolean {
  return !task.archived && !(task.runId && state.runs[task.runId]?.closed);
}

/**
 * The part of the state a viewer may see. `live` keeps only what boards need in memory;
 * archived tasks and closed runs' tasks are fetched page by page instead.
 */
export function visibleState(state: TaskState, v: TaskViewer, opts: { live: boolean }): TaskState {
  const tasks: Record<string, Task> = {};
  for (const [id, t] of Object.entries(state.tasks))
    if (canSeeTask(v, t) && (!opts.live || isLiveTask(state, t))) tasks[id] = t;
  const comments: Record<string, TaskComment> = {};
  for (const [id, c] of Object.entries(state.comments)) if (tasks[c.taskId]) comments[id] = c;
  return { ...state, tasks, comments };
}
