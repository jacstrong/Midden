/**
 * Bulk actions on a selection of tasks, as ops. A team lead picks tasks on a board or table and
 * hands them out; these build the one batch that does it, so it undoes in one step and sends
 * one notification per person.
 */
import type { TaskOp } from './ops.js';
import { categoryOf, firstStatusIn, isTaskOpen, workflowOf } from './reducer.js';
import type { StatusCategory, Task, TaskState } from './types.js';
import { sortTasks } from './views.js';

/**
 * - `round_robin`: in priority order, one each in turn.
 * - `balanced`: each task, in priority order, to whoever has the least open work, counting the
 *   tasks they already have outside the selection; ties go to whoever has been dealt fewer.
 */
export type DistributeMode = 'round_robin' | 'balanced';
export const DISTRIBUTE_MODES: readonly DistributeMode[] = ['round_robin', 'balanced'];

/** Open, unarchived tasks assigned to each person, not counting `exclude`. */
export function openLoad(
  state: TaskState,
  people: readonly string[],
  exclude: ReadonlySet<string> = new Set(),
): Map<string, number> {
  const load = new Map(people.map((p) => [p, 0]));
  for (const t of Object.values(state.tasks)) {
    if (t.archived || exclude.has(t.id) || !isTaskOpen(state, t)) continue;
    for (const a of t.assignees) if (load.has(a)) load.set(a, load.get(a)! + 1);
  }
  return load;
}

/** Who gets which task. People keep the order given; ties go to the earlier person. */
export function distribute(
  state: TaskState,
  tasks: readonly Task[],
  people: readonly string[],
  mode: DistributeMode,
): Map<string, string[]> {
  const out = new Map<string, string[]>(people.map((p) => [p, []]));
  if (people.length === 0) return out;
  const ordered = sortTasks([...tasks], 'priority');
  if (mode === 'round_robin') {
    ordered.forEach((t, i) => out.get(people[i % people.length]!)!.push(t.id));
    return out;
  }
  const load = openLoad(state, people, new Set(tasks.map((t) => t.id)));
  const dealt = (p: string): number => out.get(p)!.length;
  for (const t of ordered) {
    // Least open work wins; on a tie, whoever has been dealt fewer so far, then list order.
    let best = people[0]!;
    for (const p of people) {
      const d = load.get(p)! - load.get(best)!;
      if (d < 0 || (d === 0 && dealt(p) < dealt(best))) best = p;
    }
    out.get(best)!.push(t.id);
    // Closed tasks in the selection still change hands but add no open work.
    if (isTaskOpen(state, t)) load.set(best, load.get(best)! + 1);
  }
  return out;
}

/**
 * Replace each task's assignees with the one person it was dealt to. The team stays, unless
 * `teamId` is given.
 */
export function distributeOps(
  state: TaskState,
  tasks: readonly Task[],
  people: readonly string[],
  mode: DistributeMode,
  teamId?: string,
): TaskOp | null {
  const ops: TaskOp[] = [];
  for (const [person, ids] of distribute(state, tasks, people, mode))
    if (ids.length)
      ops.push({
        type: 'task.assign',
        ids,
        mode: 'set',
        users: [person],
        ...(teamId !== undefined ? { teamId } : {}),
      });
  if (ops.length === 0) return null;
  return ops.length === 1 ? ops[0]! : { type: 'batch', ops };
}

/**
 * Move tasks to a status. A status id applies to tasks in that status's workflow; a category
 * moves every task to the first status of that category in its own workflow, so a selection
 * that spans runs with different workflows can still be closed out together. Tasks already
 * there, or whose workflow has no such status, are left alone and returned in `skipped`; tasks
 * that can't be done until their approver signs off are returned in `awaitingApproval`.
 */
export function setStatusOps(
  state: TaskState,
  tasks: readonly Task[],
  to: { statusId: string } | { category: StatusCategory },
): { op: TaskOp | null; skipped: Task[]; awaitingApproval: Task[] } {
  const ops: TaskOp[] = [];
  const skipped: Task[] = [];
  const awaitingApproval: Task[] = [];
  for (const t of tasks) {
    const wf = workflowOf(state, t);
    let statusId: string | undefined;
    if ('statusId' in to) {
      statusId = wf?.statuses.some((s) => s.id === to.statusId) ? to.statusId : undefined;
    } else {
      statusId =
        categoryOf(state, t) === to.category
          ? t.statusId
          : wf && firstStatusIn(wf, to.category)?.id;
    }
    const into = wf?.statuses.find((s) => s.id === statusId)?.category;
    if (!statusId) skipped.push(t);
    else if (
      into === 'done' &&
      categoryOf(state, t) !== 'done' &&
      t.approval &&
      t.approval.state !== 'approved'
    )
      // One gated task would refuse the whole batch; leave it and say so instead.
      awaitingApproval.push(t);
    else if (statusId !== t.statusId) ops.push({ type: 'task.set', id: t.id, patch: { statusId } });
  }
  return { op: wrap(ops), skipped, awaitingApproval };
}

/** One `task.set` per task with the same patch, skipping tasks it wouldn't change. */
export function patchOps(
  tasks: readonly Task[],
  patch: Partial<Pick<Task, 'priority' | 'dueAt' | 'caseId' | 'archived'>>,
): TaskOp | null {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  return wrap(
    tasks
      .filter((t) => keys.some((k) => t[k] !== patch[k]))
      .map((t): TaskOp => ({ type: 'task.set', id: t.id, patch })),
  );
}

/** Add or remove labels on every task, keeping each task's other labels and their order. */
export function labelOps(
  tasks: readonly Task[],
  add: readonly string[],
  remove: readonly string[] = [],
): TaskOp | null {
  const drop = new Set(remove.map((l) => l.toLowerCase()));
  return wrap(
    tasks.flatMap((t): TaskOp[] => {
      const kept = t.labels.filter((l) => !drop.has(l.toLowerCase()));
      const have = new Set(kept.map((l) => l.toLowerCase()));
      const labels = [...kept, ...add.filter((l) => !have.has(l.toLowerCase()))];
      return labels.join('\u0000') === t.labels.join('\u0000')
        ? []
        : [{ type: 'task.set', id: t.id, patch: { labels } }];
    }),
  );
}

/** Make each person follow (or stop following) every task. */
export function followOps(
  tasks: readonly Task[],
  users: readonly string[],
  on: boolean,
): TaskOp | null {
  return wrap(
    tasks.flatMap((t) =>
      users
        .filter((u) => t.followers.includes(u) !== on)
        .map((u): TaskOp => ({ type: 'task.follow', id: t.id, userId: u, on })),
    ),
  );
}

function wrap(ops: TaskOp[]): TaskOp | null {
  if (ops.length === 0) return null;
  return ops.length === 1 ? ops[0]! : { type: 'batch', ops };
}
