/**
 * Pure reducer over TaskState, the task counterpart of `ops/reducer.ts`.
 *
 * `applyTaskOp(state, op, ctx)` takes the logged actor and time, because system fields
 * (number, created/status/done times, checklist and approval decisions) come from the server's
 * record of each op, never from client input.
 *
 * `inverseTaskOp(state, op)` is computed from the pre-state and never depends on ctx: every
 * system field an op changes is carried explicitly in the inverse. Invariant (property-tested):
 * applyTaskOp(applyTaskOp(s, op, c1), inverseTaskOp(s, op), c2) deep-equals s, for any c1, c2.
 *
 * Followers and dependencies are kept sorted so a remove-then-restore is exact.
 */
import type { Patch } from '../ops/ops.js';
import type { AssignMode, TaskOp } from './ops.js';
import { flattenTaskOp } from './ops.js';
import {
  CLOSED_CATEGORIES,
  type ChecklistItem,
  type StatusCategory,
  type Task,
  type TaskCtx,
  type TaskEditable,
  type TaskRun,
  type TaskState,
  type Workflow,
  type WorkflowStatus,
} from './types.js';

export const DEFAULT_WORKFLOW_ID = 'wf_default';

export const DEFAULT_STATUSES: WorkflowStatus[] = [
  { id: 'st_backlog', name: 'Backlog', category: 'backlog', color: '', wipLimit: null },
  { id: 'st_todo', name: 'To do', category: 'todo', color: '', wipLimit: null },
  { id: 'st_doing', name: 'In progress', category: 'in_progress', color: '', wipLimit: null },
  { id: 'st_blocked', name: 'Blocked', category: 'blocked', color: '', wipLimit: null },
  { id: 'st_done', name: 'Done', category: 'done', color: '', wipLimit: null },
  { id: 'st_cancelled', name: 'Cancelled', category: 'cancelled', color: '', wipLimit: null },
];

export function emptyTaskState(): TaskState {
  return {
    tasks: {},
    comments: {},
    runs: {},
    workflows: {
      [DEFAULT_WORKFLOW_ID]: {
        id: DEFAULT_WORKFLOW_ID,
        name: 'Default',
        statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
      },
    },
    defaultWorkflowId: DEFAULT_WORKFLOW_ID,
    nextNum: 1,
  };
}

// ---- lookups --------------------------------------------------------------------------------

export function workflowIdFor(state: TaskState, runId: string): string {
  return (runId && state.runs[runId]?.workflowId) || state.defaultWorkflowId;
}

export function workflowOf(state: TaskState, task: Pick<Task, 'runId'>): Workflow | undefined {
  return state.workflows[workflowIdFor(state, task.runId)];
}

export function statusOf(
  state: TaskState,
  task: Pick<Task, 'runId' | 'statusId'>,
): WorkflowStatus | undefined {
  return workflowOf(state, task)?.statuses.find((s) => s.id === task.statusId);
}

/** A task whose status has gone missing reads as "todo" rather than vanishing from boards. */
export function categoryOf(
  state: TaskState,
  task: Pick<Task, 'runId' | 'statusId'>,
): StatusCategory {
  return statusOf(state, task)?.category ?? 'todo';
}

export const isClosedCategory = (c: StatusCategory): boolean => CLOSED_CATEGORIES.includes(c);

export function isTaskOpen(state: TaskState, task: Task): boolean {
  return !task.archived && !isClosedCategory(categoryOf(state, task));
}

/** First status of a category in a workflow, used when importing and when moving between runs. */
export function firstStatusIn(wf: Workflow, category: StatusCategory): WorkflowStatus | undefined {
  return wf.statuses.find((s) => s.category === category);
}

/** Tasks this one transitively waits on that are still open. */
export function openBlockers(state: TaskState, task: Task): Task[] {
  return task.blockedBy
    .map((id) => state.tasks[id])
    .filter((t): t is Task => !!t && isTaskOpen(state, t));
}

// ---- helpers --------------------------------------------------------------------------------

function patched<T extends object>(target: T, patch: object): T {
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || v === undefined) continue;
    out[k] = v;
  }
  return out as T;
}

function priorOf<P extends object>(target: object, patch: P): P {
  const out: Record<string, unknown> = {};
  const src = target as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || v === undefined) continue;
    out[k] = src[k];
  }
  return out as P;
}

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const { [key]: _drop, ...rest } = rec;
  return rest;
}

const uniq = (xs: readonly string[]): string[] => [...new Set(xs)];
const sortedUniq = (xs: readonly string[]): string[] => uniq(xs).sort();

function assignUsers(current: string[], mode: AssignMode, users: string[]): string[] {
  switch (mode) {
    case 'add':
      return uniq([...current, ...users]);
    case 'remove': {
      const drop = new Set(users);
      return current.filter((u) => !drop.has(u));
    }
    case 'set':
      return uniq(users);
  }
}

function putTask(state: TaskState, task: Task): TaskState {
  return { ...state, tasks: { ...state.tasks, [task.id]: task } };
}

function withTask(state: TaskState, id: string, f: (t: Task) => Task): TaskState {
  const t = state.tasks[id];
  return t ? putTask(state, f(t)) : state;
}

function insertAt<T>(xs: T[], item: T, index: number | undefined): T[] {
  const i = index === undefined ? xs.length : Math.max(0, Math.min(index, xs.length));
  return [...xs.slice(0, i), item, ...xs.slice(i)];
}

/** Status/done timestamps after a task's status or run changes. */
function statusSys(
  state: TaskState,
  before: Task,
  after: Task,
  ctx: TaskCtx,
): Pick<Task, 'statusAt' | 'doneAt'> {
  const statusAt = after.statusId !== before.statusId ? ctx.ts : before.statusAt;
  const wasClosed = isClosedCategory(categoryOf(state, before));
  const isClosed = isClosedCategory(categoryOf(state, after));
  const doneAt = isClosed ? (wasClosed ? before.doneAt : ctx.ts) : '';
  return { statusAt, doneAt };
}

// ---- apply ----------------------------------------------------------------------------------

export function applyTaskOp(state: TaskState, op: TaskOp, ctx: TaskCtx): TaskState {
  switch (op.type) {
    case 'noop':
      return state;

    case 'task.add': {
      if (state.tasks[op.task.id]) return state;
      const n = op.task;
      const num = n.num ?? state.nextNum;
      const task: Task = {
        id: n.id,
        num,
        title: n.title,
        description: n.description,
        statusId: n.statusId,
        priority: n.priority,
        runId: n.runId,
        teamId: n.teamId ?? '',
        assignees: uniq(n.assignees ?? []),
        followers: sortedUniq(n.followers ?? []),
        labels: uniq(n.labels),
        dueAt: n.dueAt,
        caseId: n.caseId,
        hostId: n.hostId,
        eventId: n.eventId,
        blockedBy: sortedUniq((n.blockedBy ?? []).filter((b) => b !== n.id)),
        checklist: (n.checklist ?? []).map((c) => ({
          id: c.id,
          text: c.text,
          done: false,
          doneBy: '',
          doneAt: '',
        })),
        approval: null,
        archived: false,
        createdBy: ctx.actorId,
        createdAt: ctx.ts,
        statusAt: ctx.ts,
        doneAt: '',
      };
      if (isClosedCategory(categoryOf(state, task))) task.doneAt = ctx.ts;
      return { ...putTask(state, task), nextNum: Math.max(state.nextNum, num + 1) };
    }

    case 'task.set': {
      const before = state.tasks[op.id];
      if (!before) return state;
      const after = patched(before, op.patch);
      if (op.patch.labels) after.labels = uniq(op.patch.labels);
      const sys = op.sys ?? statusSys(state, before, after, ctx);
      return putTask(state, { ...after, statusAt: sys.statusAt, doneAt: sys.doneAt });
    }

    case 'task.assign': {
      let s = state;
      for (const id of op.ids) {
        s = withTask(s, id, (t) => ({
          ...t,
          assignees: assignUsers(t.assignees, op.mode, op.users),
          teamId: op.teamId ?? t.teamId,
        }));
      }
      return s;
    }

    case 'task.follow':
      return withTask(state, op.id, (t) => ({
        ...t,
        followers: op.on
          ? sortedUniq([...t.followers, op.userId])
          : t.followers.filter((u) => u !== op.userId),
      }));

    case 'checklist.add':
      return withTask(state, op.taskId, (t) =>
        t.checklist.some((c) => c.id === op.item.id)
          ? t
          : {
              ...t,
              checklist: insertAt(
                t.checklist,
                { id: op.item.id, text: op.item.text, done: false, doneBy: '', doneAt: '' },
                op.index,
              ),
            },
      );

    case 'checklist.set':
      return withTask(state, op.taskId, (t) => ({
        ...t,
        checklist: t.checklist.map((c) => {
          if (c.id !== op.itemId) return c;
          const next: ChecklistItem = patched(c, op.patch);
          if (op.sys) return { ...next, doneBy: op.sys.doneBy, doneAt: op.sys.doneAt };
          if (op.patch.done !== undefined && op.patch.done !== c.done)
            return op.patch.done
              ? { ...next, doneBy: ctx.actorId, doneAt: ctx.ts }
              : { ...next, doneBy: '', doneAt: '' };
          return next;
        }),
      }));

    case 'checklist.remove':
      return withTask(state, op.taskId, (t) =>
        t.checklist.some((c) => c.id === op.itemId)
          ? { ...t, checklist: t.checklist.filter((c) => c.id !== op.itemId) }
          : t,
      );

    case 'checklist.move':
      return withTask(state, op.taskId, (t) => {
        const item = t.checklist.find((c) => c.id === op.itemId);
        if (!item) return t;
        const rest = t.checklist.filter((c) => c.id !== op.itemId);
        return { ...t, checklist: insertAt(rest, item, op.index) };
      });

    case 'checklist.put':
      return withTask(state, op.taskId, (t) =>
        t.checklist.some((c) => c.id === op.item.id)
          ? t
          : { ...t, checklist: insertAt(t.checklist, op.item, op.index) },
      );

    case 'dep.add':
      if (op.taskId === op.blockedById) return state;
      return withTask(state, op.taskId, (t) =>
        t.blockedBy.includes(op.blockedById)
          ? t
          : { ...t, blockedBy: sortedUniq([...t.blockedBy, op.blockedById]) },
      );

    case 'dep.remove':
      return withTask(state, op.taskId, (t) =>
        t.blockedBy.includes(op.blockedById)
          ? { ...t, blockedBy: t.blockedBy.filter((b) => b !== op.blockedById) }
          : t,
      );

    case 'comment.add': {
      const c = op.comment;
      if (state.comments[c.id] || !state.tasks[c.taskId]) return state;
      return {
        ...state,
        comments: {
          ...state.comments,
          [c.id]: {
            id: c.id,
            taskId: c.taskId,
            authorId: ctx.actorId,
            body: c.body,
            createdAt: ctx.ts,
            editedAt: '',
            deletedAt: '',
          },
        },
      };
    }

    case 'comment.edit': {
      const c = state.comments[op.id];
      if (!c) return state;
      return {
        ...state,
        comments: { ...state.comments, [op.id]: { ...c, body: op.body, editedAt: ctx.ts } },
      };
    }

    case 'comment.remove': {
      const c = state.comments[op.id];
      if (!c) return state;
      return {
        ...state,
        comments: { ...state.comments, [op.id]: { ...c, body: '', deletedAt: ctx.ts } },
      };
    }

    case 'comment.put':
      return { ...state, comments: { ...state.comments, [op.comment.id]: op.comment } };

    case 'comment.drop':
      return { ...state, comments: without(state.comments, op.id) };

    case 'approval.set':
      return withTask(state, op.taskId, (t) => ({
        ...t,
        approval: op.approverId
          ? {
              approverId: op.approverId,
              state: 'pending',
              comment: '',
              requestedBy: ctx.actorId,
              requestedAt: ctx.ts,
              decidedBy: '',
              decidedAt: '',
            }
          : null,
      }));

    case 'approval.decide':
      return withTask(state, op.taskId, (t) =>
        t.approval
          ? {
              ...t,
              approval: {
                ...t.approval,
                state: op.decision,
                comment: op.comment,
                decidedBy: ctx.actorId,
                decidedAt: ctx.ts,
              },
            }
          : t,
      );

    case 'approval.put':
      return withTask(state, op.taskId, (t) => ({ ...t, approval: op.approval }));

    case 'run.add': {
      if (state.runs[op.run.id]) return state;
      const run: TaskRun = {
        ...op.run,
        closed: false,
        closedAt: '',
        createdBy: ctx.actorId,
        createdAt: ctx.ts,
      };
      return { ...state, runs: { ...state.runs, [run.id]: run } };
    }

    case 'run.set': {
      const r = state.runs[op.id];
      if (!r) return state;
      const next = patched(r, op.patch);
      if (op.sys) next.closedAt = op.sys.closedAt;
      else if (op.patch.closed !== undefined && op.patch.closed !== r.closed)
        next.closedAt = op.patch.closed ? ctx.ts : '';
      return { ...state, runs: { ...state.runs, [op.id]: next } };
    }

    case 'run.put':
      return { ...state, runs: { ...state.runs, [op.run.id]: op.run } };

    case 'run.drop':
      return { ...state, runs: without(state.runs, op.id) };

    case 'workflow.set':
      return { ...state, workflows: { ...state.workflows, [op.workflow.id]: op.workflow } };

    case 'workflow.drop':
      if (op.id === state.defaultWorkflowId) return state;
      return { ...state, workflows: without(state.workflows, op.id) };

    case 'workflow.default':
      if (!state.workflows[op.id]) return state;
      return { ...state, defaultWorkflowId: op.id };

    case 'task.put': {
      const s = putTask(state, op.task);
      return op.nextNum !== undefined ? { ...s, nextNum: op.nextNum } : s;
    }

    case 'task.drop':
      return { ...state, tasks: without(state.tasks, op.id), nextNum: op.nextNum };

    case 'batch': {
      let s = state;
      for (const o of op.ops) s = applyTaskOp(s, o, ctx);
      return s;
    }

    case 'op.revert':
      return applyTaskOp(state, op.inverse, ctx);
  }
}

export function applyAllTaskOps(
  state: TaskState,
  entries: Iterable<{ op: TaskOp; ctx: TaskCtx }>,
): TaskState {
  let s = state;
  for (const e of entries) s = applyTaskOp(s, e.op, e.ctx);
  return s;
}

// ---- inverse --------------------------------------------------------------------------------

const NOOP: TaskOp = { type: 'noop' };

/** Any ctx works for computing the post-state inside a batch: inverses never read ctx. */
const INVERSE_CTX: TaskCtx = { actorId: '', ts: '' };

export function inverseTaskOp(state: TaskState, op: TaskOp): TaskOp {
  switch (op.type) {
    case 'noop':
      return NOOP;

    case 'task.add':
      return state.tasks[op.task.id]
        ? NOOP
        : { type: 'task.drop', id: op.task.id, nextNum: state.nextNum };

    case 'task.set': {
      const t = state.tasks[op.id];
      if (!t) return NOOP;
      return {
        type: 'task.set',
        id: op.id,
        patch: priorOf(t, op.patch) as Patch<TaskEditable>,
        // Only a status or run change moves the system timestamps; reverting an old title edit
        // must not reset them.
        ...(op.patch.statusId !== undefined || op.patch.runId !== undefined || op.sys
          ? { sys: { statusAt: t.statusAt, doneAt: t.doneAt } }
          : {}),
      };
    }

    case 'task.assign': {
      const inv: TaskOp[] = [];
      for (const id of op.ids) {
        const t = state.tasks[id];
        if (!t) continue;
        inv.push({
          type: 'task.assign',
          ids: [id],
          mode: 'set',
          users: [...t.assignees],
          ...(op.teamId !== undefined ? { teamId: t.teamId } : {}),
        });
      }
      if (inv.length === 0) return NOOP;
      return inv.length === 1 ? inv[0]! : { type: 'batch', ops: inv.reverse() };
    }

    case 'task.follow': {
      const t = state.tasks[op.id];
      if (!t) return NOOP;
      return {
        type: 'task.follow',
        id: op.id,
        userId: op.userId,
        on: t.followers.includes(op.userId),
      };
    }

    case 'checklist.add': {
      const t = state.tasks[op.taskId];
      if (!t || t.checklist.some((c) => c.id === op.item.id)) return NOOP;
      return { type: 'checklist.remove', taskId: op.taskId, itemId: op.item.id };
    }

    case 'checklist.set': {
      const item = state.tasks[op.taskId]?.checklist.find((c) => c.id === op.itemId);
      if (!item) return NOOP;
      return {
        type: 'checklist.set',
        taskId: op.taskId,
        itemId: op.itemId,
        patch: priorOf(item, op.patch),
        ...(op.patch.done !== undefined || op.sys
          ? { sys: { doneBy: item.doneBy, doneAt: item.doneAt } }
          : {}),
      };
    }

    case 'checklist.remove': {
      const t = state.tasks[op.taskId];
      const index = t?.checklist.findIndex((c) => c.id === op.itemId) ?? -1;
      if (!t || index < 0) return NOOP;
      return { type: 'checklist.put', taskId: op.taskId, item: t.checklist[index]!, index };
    }

    case 'checklist.move': {
      const index = state.tasks[op.taskId]?.checklist.findIndex((c) => c.id === op.itemId) ?? -1;
      if (index < 0) return NOOP;
      return { type: 'checklist.move', taskId: op.taskId, itemId: op.itemId, index };
    }

    case 'checklist.put': {
      const t = state.tasks[op.taskId];
      if (!t || t.checklist.some((c) => c.id === op.item.id)) return NOOP;
      return { type: 'checklist.remove', taskId: op.taskId, itemId: op.item.id };
    }

    case 'dep.add': {
      const t = state.tasks[op.taskId];
      if (!t || op.taskId === op.blockedById || t.blockedBy.includes(op.blockedById)) return NOOP;
      return { type: 'dep.remove', taskId: op.taskId, blockedById: op.blockedById };
    }

    case 'dep.remove': {
      const t = state.tasks[op.taskId];
      if (!t || !t.blockedBy.includes(op.blockedById)) return NOOP;
      return { type: 'dep.add', taskId: op.taskId, blockedById: op.blockedById };
    }

    case 'comment.add':
      return state.comments[op.comment.id] || !state.tasks[op.comment.taskId]
        ? NOOP
        : { type: 'comment.drop', id: op.comment.id };

    case 'comment.edit':
    case 'comment.remove': {
      const c = state.comments[op.id];
      return c ? { type: 'comment.put', comment: c } : NOOP;
    }

    case 'comment.put': {
      const c = state.comments[op.comment.id];
      return c ? { type: 'comment.put', comment: c } : { type: 'comment.drop', id: op.comment.id };
    }

    case 'comment.drop': {
      const c = state.comments[op.id];
      return c ? { type: 'comment.put', comment: c } : NOOP;
    }

    case 'approval.set':
    case 'approval.decide':
    case 'approval.put': {
      const t = state.tasks[op.taskId];
      return t ? { type: 'approval.put', taskId: op.taskId, approval: t.approval } : NOOP;
    }

    case 'run.add':
      return state.runs[op.run.id] ? NOOP : { type: 'run.drop', id: op.run.id };

    case 'run.set': {
      const r = state.runs[op.id];
      if (!r) return NOOP;
      return {
        type: 'run.set',
        id: op.id,
        patch: priorOf(r, op.patch),
        ...(op.patch.closed !== undefined || op.sys ? { sys: { closedAt: r.closedAt } } : {}),
      };
    }

    case 'run.put': {
      const r = state.runs[op.run.id];
      return r ? { type: 'run.put', run: r } : { type: 'run.drop', id: op.run.id };
    }

    case 'run.drop': {
      const r = state.runs[op.id];
      return r ? { type: 'run.put', run: r } : NOOP;
    }

    case 'workflow.set': {
      const w = state.workflows[op.workflow.id];
      return w
        ? { type: 'workflow.set', workflow: w }
        : { type: 'workflow.drop', id: op.workflow.id };
    }

    case 'workflow.drop': {
      const w = state.workflows[op.id];
      return w && op.id !== state.defaultWorkflowId ? { type: 'workflow.set', workflow: w } : NOOP;
    }

    case 'workflow.default':
      return state.workflows[op.id]
        ? { type: 'workflow.default', id: state.defaultWorkflowId }
        : NOOP;

    case 'task.put': {
      const t = state.tasks[op.task.id];
      const nextNum = op.nextNum !== undefined ? { nextNum: state.nextNum } : {};
      return t
        ? { type: 'task.put', task: t, ...nextNum }
        : { type: 'task.drop', id: op.task.id, nextNum: state.nextNum };
    }

    case 'task.drop': {
      const t = state.tasks[op.id];
      return t
        ? { type: 'task.put', task: t, nextNum: state.nextNum }
        : { type: 'task.drop', id: op.id, nextNum: state.nextNum };
    }

    case 'batch': {
      const inverses: TaskOp[] = [];
      let s = state;
      for (const o of op.ops) {
        inverses.push(inverseTaskOp(s, o));
        s = applyTaskOp(s, o, INVERSE_CTX);
      }
      inverses.reverse();
      return { type: 'batch', ops: inverses };
    }

    case 'op.revert':
      return inverseTaskOp(state, op.inverse);
  }
}

// ---- validation -----------------------------------------------------------------------------

/**
 * Why an op can't be applied to this state, or null if it can. Checks that targets exist, then
 * applies the whole op and checks the invariants on the result, so a batch may pass through an
 * intermediate state (e.g. switch a run's workflow, then remap its tasks' statuses).
 *
 * Permissions (who may do what) are the server's job; this is only about the data.
 */
export function checkTaskOp(state: TaskState, op: TaskOp, ctx: TaskCtx): string | null {
  let s = state;
  const touchedTasks = new Set<string>();
  const touchedRuns = new Set<string>();
  const touchedWorkflows = new Set<string>();
  let defaultChanged = false;
  const missingTask = (id: string): string | null =>
    s.tasks[id] ? null : `Task ${id} does not exist`;

  for (const o of flattenTaskOp(op)) {
    let err: string | null = null;
    switch (o.type) {
      case 'task.add':
        if (s.tasks[o.task.id]) err = `Task ${o.task.id} already exists`;
        else if (o.task.runId && !s.runs[o.task.runId]) err = `Run ${o.task.runId} does not exist`;
        else
          for (const b of o.task.blockedBy ?? [])
            if (!s.tasks[b] && b !== o.task.id) err = `Task ${b} does not exist`;
        touchedTasks.add(o.task.id);
        break;
      case 'task.set':
        err = missingTask(o.id);
        if (!err && o.patch.runId && !s.runs[o.patch.runId])
          err = `Run ${o.patch.runId} does not exist`;
        touchedTasks.add(o.id);
        break;
      case 'task.assign':
        for (const id of o.ids) err ??= missingTask(id);
        break;
      case 'task.follow':
        err = missingTask(o.id);
        break;
      case 'checklist.add': {
        err = missingTask(o.taskId);
        if (!err && s.tasks[o.taskId]!.checklist.some((c) => c.id === o.item.id))
          err = `Checklist item ${o.item.id} already exists`;
        break;
      }
      case 'checklist.set':
      case 'checklist.remove':
      case 'checklist.move':
        err = missingTask(o.taskId);
        if (!err && !s.tasks[o.taskId]!.checklist.some((c) => c.id === o.itemId))
          err = `Checklist item ${o.itemId} does not exist`;
        break;
      case 'dep.add':
        err = missingTask(o.taskId) ?? missingTask(o.blockedById);
        if (!err && o.taskId === o.blockedById) err = 'A task cannot block itself';
        touchedTasks.add(o.taskId);
        break;
      case 'dep.remove':
        err = missingTask(o.taskId);
        break;
      case 'comment.add':
        err = missingTask(o.comment.taskId);
        if (!err && s.comments[o.comment.id]) err = `Comment ${o.comment.id} already exists`;
        break;
      case 'comment.edit':
      case 'comment.remove': {
        const c = s.comments[o.id];
        if (!c) err = `Comment ${o.id} does not exist`;
        else if (c.deletedAt) err = 'That comment was deleted';
        break;
      }
      case 'approval.set':
        err = missingTask(o.taskId);
        touchedTasks.add(o.taskId);
        break;
      case 'approval.decide':
        err = missingTask(o.taskId);
        if (!err && !s.tasks[o.taskId]!.approval) err = 'This task has no approver';
        touchedTasks.add(o.taskId);
        break;
      case 'run.add':
        if (s.runs[o.run.id]) err = `Run ${o.run.id} already exists`;
        else if (!s.workflows[o.run.workflowId])
          err = `Workflow ${o.run.workflowId} does not exist`;
        touchedRuns.add(o.run.id);
        break;
      case 'run.set':
        if (!s.runs[o.id]) err = `Run ${o.id} does not exist`;
        else if (o.patch.workflowId && !s.workflows[o.patch.workflowId])
          err = `Workflow ${o.patch.workflowId} does not exist`;
        touchedRuns.add(o.id);
        break;
      case 'workflow.set': {
        const ids = o.workflow.statuses.map((x) => x.id);
        if (new Set(ids).size !== ids.length) err = 'Status ids in a workflow must be unique';
        touchedWorkflows.add(o.workflow.id);
        break;
      }
      case 'workflow.default':
        if (!s.workflows[o.id]) err = `Workflow ${o.id} does not exist`;
        defaultChanged = true;
        break;
      case 'workflow.drop':
        if (o.id === s.defaultWorkflowId) err = 'The default workflow cannot be removed';
        else if (Object.values(s.runs).some((r) => r.workflowId === o.id))
          err = 'That workflow is still used by a run';
        break;
      case 'task.put':
        touchedTasks.add(o.task.id);
        break;
      case 'run.put':
        touchedRuns.add(o.run.id);
        break;
      default:
        break;
    }
    if (err) return err;
    s = applyTaskOp(s, o, ctx);
  }

  // Every task whose workflow or status may have changed must sit on a status that exists.
  const recheck = new Set(touchedTasks);
  if (touchedRuns.size || touchedWorkflows.size || defaultChanged) {
    for (const t of Object.values(s.tasks)) {
      const wf = workflowIdFor(s, t.runId);
      if (touchedRuns.has(t.runId) || touchedWorkflows.has(wf) || (defaultChanged && !t.runId))
        recheck.add(t.id);
    }
  }
  for (const id of recheck) {
    const t = s.tasks[id];
    if (!t) continue;
    const wf = workflowOf(s, t);
    if (!wf) return `Workflow for ${id} does not exist`;
    if (!wf.statuses.some((x) => x.id === t.statusId))
      return `Status ${t.statusId} is not in workflow "${wf.name}"`;
  }

  // Dependencies may not form a cycle.
  for (const id of touchedTasks)
    if (s.tasks[id] && dependsOn(s, id, id)) return 'That would create a dependency cycle';

  // Risk acceptance: a task with an approver reaches done only once approved.
  for (const id of recheck) {
    const after = s.tasks[id];
    if (!after?.approval || after.approval.state === 'approved') continue;
    const before = state.tasks[id];
    const wasDone = before ? categoryOf(state, before) === 'done' : false;
    if (!wasDone && categoryOf(s, after) === 'done')
      return after.approval.state === 'rejected'
        ? 'The approver rejected this task, so it cannot be marked done'
        : 'This task needs approval before it can be marked done';
  }
  return null;
}

/** Whether `from` (transitively) waits on `target`, starting from `from`'s blockers. */
function dependsOn(state: TaskState, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [...(state.tasks[from]?.blockedBy ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(state.tasks[id]?.blockedBy ?? []));
  }
  return false;
}
