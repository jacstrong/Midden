/**
 * Task board logic: column order, filters, card placement and the ops behind bulk actions.
 * Everything here returns ops rather than changing state, so a bulk action is one batch in the
 * history and one revert undoes it.
 */
import type { Labelled } from '../domain/reference.js';
import type {
  CaseState,
  Task,
  TaskComment,
  TaskFields,
  TaskPriority,
  TaskStatus,
} from '../domain/types.js';
import { uid } from '../domain/ids.js';
import { definedKeys, type Op, type Patch } from '../ops/ops.js';

export const TASK_STATUS: readonly Labelled<TaskStatus>[] = [
  { id: 'backlog', label: 'Backlog', color: '#6d8299' },
  { id: 'todo', label: 'To do', color: '#22e8ff' },
  { id: 'doing', label: 'In progress', color: '#ffb020' },
  { id: 'blocked', label: 'Blocked', color: '#ff4d5e' },
  { id: 'review', label: 'Review', color: '#9d6bff' },
  { id: 'done', label: 'Done', color: '#4dff9a' },
];
export const TASK_STATUS_IDS: readonly TaskStatus[] = TASK_STATUS.map((s) => s.id);

export const TASK_PRIORITY: readonly Labelled<TaskPriority>[] = [
  { id: 'urgent', label: 'Urgent', color: '#ff1f3d' },
  { id: 'high', label: 'High', color: '#ff6b3d' },
  { id: 'normal', label: 'Normal', color: '#22e8ff' },
  { id: 'low', label: 'Low', color: '#6d8299' },
];
const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export interface TaskActor {
  id: string;
  name: string;
}

export function blankTask(
  actor: TaskActor,
  now: string = new Date().toISOString(),
  fields: Partial<TaskFields> = {},
): Task {
  return {
    id: uid('task'),
    title: '',
    description: '',
    status: 'todo',
    priority: 'normal',
    assignees: [],
    hostIds: [],
    eventIds: [],
    technique: '',
    tags: [],
    due: '',
    checklist: [],
    outcome: '',
    rank: 0,
    createdBy: actor.id,
    createdByName: actor.name,
    createdAt: now,
    completedAt: '',
    ...fields,
  };
}

const byRank = (a: Task, b: Task): number =>
  a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Tasks in each column, in card order. */
export function tasksByStatus(tasks: Iterable<Task>): Record<TaskStatus, Task[]> {
  const out = Object.fromEntries(TASK_STATUS_IDS.map((s) => [s, [] as Task[]])) as Record<
    TaskStatus,
    Task[]
  >;
  for (const t of tasks) (out[t.status] ?? out.todo).push(t);
  for (const s of TASK_STATUS_IDS) out[s].sort(byRank);
  return out;
}

/** A rank strictly between two neighbours. Either side may be missing (top or bottom of a column). */
export function rankBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return (after as number) - 1;
  if (after === undefined) return before + 1;
  // After ~50 halvings of one gap the midpoint collides with a neighbour; ties then sort by id,
  // which only blurs the order of those two cards.
  return (before + after) / 2;
}

/** The rank that puts a new card at the bottom of a column. */
export function bottomRank(state: CaseState, status: TaskStatus): number {
  let max: number | undefined;
  for (const t of Object.values(state.tasks))
    if (t.status === status && (max === undefined || t.rank > max)) max = t.rank;
  return max === undefined ? 0 : max + 1;
}

/** Fields that change when a task changes column: done stamps a completion time, leaving clears it. */
export function statusPatch(
  task: Pick<Task, 'status' | 'completedAt'>,
  status: TaskStatus,
  now: string,
): Patch<TaskFields> {
  if (task.status === status) return {};
  const patch: Patch<TaskFields> = { status };
  if (status === 'done') patch.completedAt = now;
  else if (task.completedAt) patch.completedAt = '';
  return patch;
}

/**
 * Move a card to a column, above `beforeId` (or to the bottom when it is null). Returns null when
 * the card would not move.
 */
export function moveTaskOp(
  state: CaseState,
  taskId: string,
  status: TaskStatus,
  beforeId: string | null,
  now: string = new Date().toISOString(),
): Op | null {
  const task = state.tasks[taskId];
  if (!task) return null;
  const column = tasksByStatus(Object.values(state.tasks))[status].filter((t) => t.id !== taskId);
  const at = beforeId ? column.findIndex((t) => t.id === beforeId) : -1;
  const index = at < 0 ? column.length : at;
  const rank = rankBetween(column[index - 1]?.rank, column[index]?.rank);
  const patch: Patch<TaskFields> = { ...statusPatch(task, status, now) };
  const neighboursUnchanged =
    task.status === status &&
    (column[index - 1]?.rank ?? -Infinity) < task.rank &&
    task.rank < (column[index]?.rank ?? Infinity);
  if (!neighboursUnchanged) patch.rank = rank;
  return definedKeys(patch).length ? { type: 'task.set', id: taskId, patch } : null;
}

export type TaskScope = 'all' | 'mine' | 'unassigned' | 'following';

export interface TaskFilter {
  scope: TaskScope;
  /** The signed-in user, for `mine`. */
  me?: string | null | undefined;
  /** Task ids the signed-in user follows, for `following`. */
  following?: ReadonlySet<string> | undefined;
  query?: string | undefined;
  priority?: TaskPriority | '' | undefined;
  hostId?: string | undefined;
  /** Display names for assignee ids, so a search for "ann" finds Ann's tasks. */
  names?: ((id: string) => string) | undefined;
}

export function filterTasks(state: CaseState, f: TaskFilter): Task[] {
  const q = f.query?.trim().toLowerCase() ?? '';
  return Object.values(state.tasks).filter((t) => {
    if (f.scope === 'mine' && !(f.me && t.assignees.includes(f.me))) return false;
    if (f.scope === 'unassigned' && t.assignees.length) return false;
    if (
      f.scope === 'following' &&
      !(f.following?.has(t.id) || (f.me && t.assignees.includes(f.me)))
    )
      return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.hostId && !t.hostIds.includes(f.hostId)) return false;
    if (!q) return true;
    const hay = [
      t.title,
      t.description,
      t.technique,
      t.outcome,
      ...t.tags,
      ...t.assignees.map((a) => f.names?.(a) ?? a),
      ...t.hostIds.map((h) => state.hosts[h]?.name ?? ''),
      ...t.checklist.map((c) => c.text),
    ]
      .join('\n')
      .toLowerCase();
    return hay.includes(q);
  });
}

/** Past due and not finished. */
export function isOverdue(task: Pick<Task, 'due' | 'status'>, now: number = Date.now()): boolean {
  if (!task.due || task.status === 'done') return false;
  const t = Date.parse(task.due);
  return Number.isFinite(t) && t < now;
}

export function checklistProgress(task: Pick<Task, 'checklist'>): { done: number; total: number } {
  return { done: task.checklist.filter((c) => c.done).length, total: task.checklist.length };
}

export const sortByPriority = (tasks: Task[]): Task[] =>
  [...tasks].sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || byRank(a, b),
  );

export function commentsFor(state: CaseState, taskId: string): TaskComment[] {
  return Object.values(state.comments)
    .filter((c) => c.taskId === taskId)
    .sort((a, b) => a.ts.localeCompare(b.ts) || (a.id < b.id ? -1 : 1));
}

export function tasksForHost(state: CaseState, hostId: string): Task[] {
  return Object.values(state.tasks)
    .filter((t) => t.hostIds.includes(hostId))
    .sort(byRank);
}

export function tasksForEvent(state: CaseState, eventId: string): Task[] {
  return Object.values(state.tasks)
    .filter((t) => t.eventIds.includes(eventId))
    .sort(byRank);
}

/* ---------------- bulk actions ---------------- */

const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];
const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export type ListMode = 'add' | 'remove' | 'replace';

export interface ListChange {
  mode: ListMode;
  values: string[];
}

export function changeList(current: readonly string[], change: ListChange): string[] {
  switch (change.mode) {
    case 'add':
      return uniq([...current, ...change.values]);
    case 'remove':
      return current.filter((x) => !change.values.includes(x));
    case 'replace':
      return uniq(change.values);
  }
}

/** What a bulk edit may change. Anything left undefined is left alone on every task. */
export interface BulkEdit {
  status?: TaskStatus | undefined;
  priority?: TaskPriority | undefined;
  assignees?: ListChange | undefined;
  hostIds?: ListChange | undefined;
  tags?: ListChange | undefined;
  /** An ISO instant, or '' to clear. */
  due?: string | undefined;
}

/** One `task.set` per task that actually changes, in one batch. */
export function bulkEditOp(
  state: CaseState,
  ids: readonly string[],
  edit: BulkEdit,
  now: string = new Date().toISOString(),
): Op {
  const ops: Op[] = [];
  for (const id of ids) {
    const t = state.tasks[id];
    if (!t) continue;
    const patch: Patch<TaskFields> = {};
    if (edit.status) Object.assign(patch, statusPatch(t, edit.status, now));
    if (edit.status && edit.status !== t.status)
      patch.rank = bottomRank(state, edit.status) + ops.length;
    if (edit.priority && edit.priority !== t.priority) patch.priority = edit.priority;
    if (edit.due !== undefined && edit.due !== t.due) patch.due = edit.due;
    for (const key of ['assignees', 'hostIds', 'tags'] as const) {
      const change = edit[key];
      if (!change) continue;
      const next = changeList(t[key], change);
      if (!sameList(next, t[key])) patch[key] = next;
    }
    if (definedKeys(patch).length) ops.push({ type: 'task.set', id, patch });
  }
  return { type: 'batch', ops };
}

/** Remove tasks along with their comments, so a revert brings back both. */
export function removeTasksOp(state: CaseState, ids: readonly string[]): Op {
  const gone = new Set(ids.filter((id) => state.tasks[id]));
  const ops: Op[] = [];
  for (const c of Object.values(state.comments))
    if (gone.has(c.taskId)) ops.push({ type: 'comment.remove', id: c.id });
  for (const id of gone) ops.push({ type: 'task.remove', id });
  return { type: 'batch', ops };
}

/**
 * Copies of tasks in the same case, placed under their originals' columns. The copy is a fresh
 * piece of work: it keeps the plan (title, hosts, checklist with every item unticked) and drops
 * the result (outcome, completion) and the comments.
 */
export function duplicateTasksOp(
  state: CaseState,
  ids: readonly string[],
  actor: TaskActor,
  now: string = new Date().toISOString(),
): { op: Op; ids: string[] } {
  const ops: Op[] = [];
  const created: string[] = [];
  const nextRank = new Map<TaskStatus, number>();
  for (const id of ids) {
    const t = state.tasks[id];
    if (!t) continue;
    const status: TaskStatus = t.status === 'done' ? 'todo' : t.status;
    const rank = nextRank.get(status) ?? bottomRank(state, status);
    nextRank.set(status, rank + 1);
    const copy: Task = {
      ...t,
      id: uid('task'),
      title: t.title.endsWith(' (copy)') ? t.title : `${t.title} (copy)`,
      status,
      rank,
      checklist: t.checklist.map((c) => ({ ...c, id: uid('ck'), done: false })),
      outcome: '',
      completedAt: '',
      createdBy: actor.id,
      createdByName: actor.name,
      createdAt: now,
    };
    ops.push({ type: 'task.add', task: copy });
    created.push(copy.id);
  }
  return { op: { type: 'batch', ops }, ids: created };
}
