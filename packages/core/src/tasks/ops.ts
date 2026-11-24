/**
 * The task op vocabulary. Same rules as case ops (`ops/ops.ts`): every change is one of these,
 * patches carry only the keys that change, and the server logs each op with who and when.
 *
 * Some ops are *internal*: they only ever appear as inverses the server computes (restoring a
 * removed record, or setting system fields back). The server refuses them, and any `sys`
 * payload, from clients. See `isClientSafeTaskOp`.
 */
import { z } from 'zod';
import type { Patch } from '../ops/ops.js';
import { definedKeys } from '../ops/ops.js';
import {
  ApprovalSchema,
  ChecklistItemSchema,
  NewTaskRunSchema,
  NewTaskSchema,
  TaskCommentSchema,
  TaskPatchSchema,
  TaskRunPatchSchema,
  TaskRunSchema,
  TaskSchema,
  TaskSysSchema,
  TASK_LIMITS,
  WorkflowSchema,
} from './schemas.js';
import type {
  Approval,
  ChecklistItem,
  NewTask,
  NewTaskRun,
  Task,
  TaskComment,
  TaskEditable,
  TaskRun,
  TaskRunEditable,
  TaskSys,
  Workflow,
} from './types.js';

export const MAX_TASK_BATCH = 5000;

export type AssignMode = 'add' | 'remove' | 'set';

export type TaskOp =
  | { type: 'noop' }
  | { type: 'task.add'; task: NewTask }
  | {
      type: 'task.set';
      id: string;
      patch: Patch<TaskEditable>;
      /** Internal: system fields restored by an inverse. */
      sys?: TaskSys | undefined;
    }
  /**
   * Assignment, for one task or many (a bulk assign is one op). `users` are added, removed, or
   * replace the list; `teamId`, when given, moves the task to that team ('' for none).
   */
  | {
      type: 'task.assign';
      ids: string[];
      mode: AssignMode;
      users: string[];
      teamId?: string | undefined;
    }
  | { type: 'task.follow'; id: string; userId: string; on: boolean }
  | {
      type: 'checklist.add';
      taskId: string;
      item: { id: string; text: string };
      index?: number | undefined;
    }
  | {
      type: 'checklist.set';
      taskId: string;
      itemId: string;
      patch: { text?: string | undefined; done?: boolean | undefined };
      /** Internal: who ticked it and when, restored by an inverse. */
      sys?: { doneBy: string; doneAt: string } | undefined;
    }
  | { type: 'checklist.remove'; taskId: string; itemId: string }
  | { type: 'checklist.move'; taskId: string; itemId: string; index: number }
  | { type: 'dep.add'; taskId: string; blockedById: string }
  | { type: 'dep.remove'; taskId: string; blockedById: string }
  | { type: 'comment.add'; comment: { id: string; taskId: string; body: string } }
  | { type: 'comment.edit'; id: string; body: string }
  | { type: 'comment.remove'; id: string }
  /** Set the approver ('' clears). Any change resets the decision to pending. */
  | { type: 'approval.set'; taskId: string; approverId: string }
  | { type: 'approval.decide'; taskId: string; decision: 'approved' | 'rejected'; comment: string }
  | { type: 'run.add'; run: NewTaskRun }
  | {
      type: 'run.set';
      id: string;
      patch: Patch<TaskRunEditable>;
      sys?: { closedAt: string } | undefined;
    }
  /** Create or replace a workflow. */
  | { type: 'workflow.set'; workflow: Workflow }
  | { type: 'workflow.default'; id: string }
  // Internal ops, produced only by `inverseTaskOp`:
  | { type: 'task.put'; task: Task; nextNum?: number | undefined }
  | { type: 'task.drop'; id: string; nextNum: number }
  | { type: 'checklist.put'; taskId: string; item: ChecklistItem; index: number }
  | { type: 'comment.put'; comment: TaskComment }
  | { type: 'comment.drop'; id: string }
  | { type: 'approval.put'; taskId: string; approval: Approval | null }
  | { type: 'run.put'; run: TaskRun }
  | { type: 'run.drop'; id: string }
  | { type: 'workflow.drop'; id: string }
  | { type: 'batch'; ops: TaskOp[] }
  | { type: 'op.revert'; targetSeq: number; inverse: TaskOp };

export type TaskOpType = TaskOp['type'];

/** Ops a client may send. Everything else is internal (inverses) or server-built (reverts). */
export const CLIENT_TASK_OP_TYPES: ReadonlySet<TaskOpType> = new Set<TaskOpType>([
  'noop',
  'task.add',
  'task.set',
  'task.assign',
  'task.follow',
  'checklist.add',
  'checklist.set',
  'checklist.remove',
  'checklist.move',
  'dep.add',
  'dep.remove',
  'comment.add',
  'comment.edit',
  'comment.remove',
  'approval.set',
  'approval.decide',
  'run.add',
  'run.set',
  'workflow.set',
  'workflow.default',
  'batch',
]);

const tid = z.string().min(1).max(64);

export const TaskOpSchema: z.ZodType<TaskOp> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('noop') }),
    z.object({ type: z.literal('task.add'), task: NewTaskSchema }),
    z.object({
      type: z.literal('task.set'),
      id: tid,
      patch: TaskPatchSchema,
      sys: TaskSysSchema.optional(),
    }),
    z.object({
      type: z.literal('task.assign'),
      ids: z.array(tid).min(1).max(MAX_TASK_BATCH),
      mode: z.enum(['add', 'remove', 'set']),
      users: z.array(tid).max(TASK_LIMITS.assignees),
      teamId: z.string().max(64).optional(),
    }),
    z.object({ type: z.literal('task.follow'), id: tid, userId: tid, on: z.boolean() }),
    z.object({
      type: z.literal('checklist.add'),
      taskId: tid,
      item: z.object({ id: tid, text: z.string().trim().min(1).max(TASK_LIMITS.checklistText) }),
      index: z.number().int().nonnegative().optional(),
    }),
    z.object({
      type: z.literal('checklist.set'),
      taskId: tid,
      itemId: tid,
      patch: z
        .object({
          text: z.string().trim().min(1).max(TASK_LIMITS.checklistText),
          done: z.boolean(),
        })
        .partial()
        .strict(),
      sys: z.object({ doneBy: z.string().max(64), doneAt: z.string().max(40) }).optional(),
    }),
    z.object({ type: z.literal('checklist.remove'), taskId: tid, itemId: tid }),
    z.object({
      type: z.literal('checklist.move'),
      taskId: tid,
      itemId: tid,
      index: z.number().int().nonnegative(),
    }),
    z.object({ type: z.literal('dep.add'), taskId: tid, blockedById: tid }),
    z.object({ type: z.literal('dep.remove'), taskId: tid, blockedById: tid }),
    z.object({
      type: z.literal('comment.add'),
      comment: z.object({
        id: tid,
        taskId: tid,
        body: z.string().trim().min(1).max(TASK_LIMITS.comment),
      }),
    }),
    z.object({
      type: z.literal('comment.edit'),
      id: tid,
      body: z.string().trim().min(1).max(TASK_LIMITS.comment),
    }),
    z.object({ type: z.literal('comment.remove'), id: tid }),
    z.object({ type: z.literal('approval.set'), taskId: tid, approverId: z.string().max(64) }),
    z.object({
      type: z.literal('approval.decide'),
      taskId: tid,
      decision: z.enum(['approved', 'rejected']),
      comment: z.string().max(TASK_LIMITS.comment),
    }),
    z.object({ type: z.literal('run.add'), run: NewTaskRunSchema }),
    z.object({
      type: z.literal('run.set'),
      id: tid,
      patch: TaskRunPatchSchema,
      sys: z.object({ closedAt: z.string().max(40) }).optional(),
    }),
    z.object({ type: z.literal('workflow.set'), workflow: WorkflowSchema }),
    z.object({ type: z.literal('workflow.default'), id: tid }),
    z.object({
      type: z.literal('task.put'),
      task: TaskSchema,
      nextNum: z.number().int().positive().optional(),
    }),
    z.object({ type: z.literal('task.drop'), id: tid, nextNum: z.number().int().positive() }),
    z.object({
      type: z.literal('checklist.put'),
      taskId: tid,
      item: ChecklistItemSchema,
      index: z.number().int().nonnegative(),
    }),
    z.object({ type: z.literal('comment.put'), comment: TaskCommentSchema }),
    z.object({ type: z.literal('comment.drop'), id: tid }),
    z.object({
      type: z.literal('approval.put'),
      taskId: tid,
      approval: ApprovalSchema.nullable(),
    }),
    z.object({ type: z.literal('run.put'), run: TaskRunSchema }),
    z.object({ type: z.literal('run.drop'), id: tid }),
    z.object({ type: z.literal('workflow.drop'), id: tid }),
    z.object({ type: z.literal('batch'), ops: z.array(TaskOpSchema) }),
    z.object({
      type: z.literal('op.revert'),
      targetSeq: z.number().int().positive(),
      inverse: TaskOpSchema,
    }),
  ]),
) as unknown as z.ZodType<TaskOp>;

/** Validate and normalise an untrusted task op. Throws ZodError. */
export function parseTaskOp(input: unknown): TaskOp {
  return TaskOpSchema.parse(input);
}

/** Count leaf operations (a bulk assign counts once per task). */
export function taskOpSize(op: TaskOp): number {
  if (op.type === 'batch') return op.ops.reduce((n, o) => n + taskOpSize(o), 0);
  if (op.type === 'op.revert') return taskOpSize(op.inverse);
  if (op.type === 'task.assign') return op.ids.length;
  return 1;
}

/**
 * True when a client may send this op: only client op types, no `sys` payloads, no reverts
 * (the revert endpoint builds those from the stored inverse).
 */
export function isClientSafeTaskOp(op: TaskOp): boolean {
  if (!CLIENT_TASK_OP_TYPES.has(op.type)) return false;
  if (op.type === 'batch') return op.ops.every(isClientSafeTaskOp);
  if ((op.type === 'task.set' || op.type === 'checklist.set' || op.type === 'run.set') && op.sys)
    return false;
  return true;
}

/**
 * Give every `task.add` its number, in order from `nextNum`. The server does this before
 * logging, so the number is part of the op every client applies.
 */
export function stampTaskNums(op: TaskOp, nextNum: number): TaskOp {
  let n = nextNum;
  const walk = (o: TaskOp): TaskOp => {
    if (o.type === 'task.add') return { ...o, task: { ...o.task, num: n++ } };
    if (o.type === 'batch') return { ...o, ops: o.ops.map(walk) };
    return o;
  };
  return walk(op);
}

/** Leaf ops in order, with batches and reverts unwrapped. */
export function flattenTaskOp(op: TaskOp): TaskOp[] {
  if (op.type === 'batch') return op.ops.flatMap(flattenTaskOp);
  if (op.type === 'op.revert') return flattenTaskOp(op.inverse);
  return [op];
}

/**
 * Field keys an op writes, as `entityId/field`, for overwrite notices. Whole-record writes
 * are `id/*` and are not reported as overwrites.
 */
export function taskTouchedFields(op: TaskOp): string[] {
  switch (op.type) {
    case 'noop':
      return [];
    case 'task.add':
      return [`${op.task.id}/*`];
    case 'task.set':
      return definedKeys(op.patch).map((k) => `${op.id}/${k}`);
    case 'task.assign':
      return op.ids.flatMap((i) =>
        op.teamId !== undefined ? [`${i}/assignees`, `${i}/teamId`] : [`${i}/assignees`],
      );
    case 'task.follow':
      return [`${op.id}/followers`];
    case 'checklist.add':
    case 'checklist.remove':
    case 'checklist.move':
      return [`${op.taskId}/checklist`];
    case 'checklist.set':
      return definedKeys(op.patch).map((k) => `${op.taskId}/checklist/${op.itemId}/${k}`);
    case 'dep.add':
    case 'dep.remove':
      return [`${op.taskId}/blockedBy`];
    case 'comment.add':
      return [`${op.comment.id}/*`];
    case 'comment.edit':
      return [`${op.id}/body`];
    case 'comment.remove':
      return [`${op.id}/*`];
    case 'approval.set':
    case 'approval.decide':
      return [`${op.taskId}/approval`];
    case 'run.add':
      return [`${op.run.id}/*`];
    case 'run.set':
      return definedKeys(op.patch).map((k) => `${op.id}/${k}`);
    case 'workflow.set':
      return [`${op.workflow.id}/*`];
    case 'workflow.default':
      return ['tasks/defaultWorkflowId'];
    case 'task.put':
      return [`${op.task.id}/*`];
    case 'task.drop':
    case 'comment.drop':
    case 'run.drop':
    case 'workflow.drop':
      return [`${op.id}/*`];
    case 'checklist.put':
      return [`${op.taskId}/checklist`];
    case 'comment.put':
      return [`${op.comment.id}/*`];
    case 'approval.put':
      return [`${op.taskId}/approval`];
    case 'run.put':
      return [`${op.run.id}/*`];
    case 'batch':
      return op.ops.flatMap(taskTouchedFields);
    case 'op.revert':
      return taskTouchedFields(op.inverse);
  }
}

/** Task ids an op touches (comments resolve through state, so callers pass a lookup). */
export function taskIdsOf(
  op: TaskOp,
  commentTask: (commentId: string) => string | undefined,
): string[] {
  const out = new Set<string>();
  for (const o of flattenTaskOp(op)) {
    switch (o.type) {
      case 'task.add':
        out.add(o.task.id);
        break;
      case 'task.set':
      case 'task.follow':
      case 'task.drop':
        out.add(o.id);
        break;
      case 'task.put':
        out.add(o.task.id);
        break;
      case 'task.assign':
        for (const i of o.ids) out.add(i);
        break;
      case 'checklist.add':
      case 'checklist.set':
      case 'checklist.remove':
      case 'checklist.move':
      case 'checklist.put':
      case 'dep.add':
      case 'dep.remove':
      case 'approval.set':
      case 'approval.decide':
      case 'approval.put':
        out.add(o.taskId);
        break;
      case 'comment.add':
        out.add(o.comment.taskId);
        break;
      case 'comment.put':
        out.add(o.comment.taskId);
        break;
      case 'comment.edit':
      case 'comment.remove':
      case 'comment.drop': {
        const t = commentTask(o.id);
        if (t) out.add(t);
        break;
      }
      default:
        break;
    }
  }
  return [...out];
}

// Compile-time checks that the schemas produce the domain types (TaskOpSchema itself is cast).
type Infer<T extends z.ZodType> = z.infer<T>;
const _schemasMatch = {
  newTask: (x: Infer<typeof NewTaskSchema>): NewTask => x,
  task: (x: Infer<typeof TaskSchema>): Task => x,
  patch: (x: Infer<typeof TaskPatchSchema>): Patch<TaskEditable> => x,
  run: (x: Infer<typeof TaskRunSchema>): TaskRun => x,
  newRun: (x: Infer<typeof NewTaskRunSchema>): NewTaskRun => x,
  runPatch: (x: Infer<typeof TaskRunPatchSchema>): Patch<TaskRunEditable> => x,
  workflow: (x: Infer<typeof WorkflowSchema>): Workflow => x,
  comment: (x: Infer<typeof TaskCommentSchema>): TaskComment => x,
  approval: (x: Infer<typeof ApprovalSchema>): Approval => x,
  item: (x: Infer<typeof ChecklistItemSchema>): ChecklistItem => x,
};
void _schemasMatch;
