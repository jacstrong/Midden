import { z } from 'zod';
import { type STATUS_CATEGORIES, type TASK_PRIORITIES } from './types.js';

/** Size limits. Tasks are typed by people and imported from CSV, so these are generous. */
export const TASK_LIMITS = {
  title: 300,
  description: 20_000,
  comment: 20_000,
  label: 64,
  labels: 50,
  checklistText: 500,
  checklistItems: 200,
  assignees: 50,
  blockedBy: 100,
  workflowStatuses: 30,
  name: 200,
} as const;

const id = z.string().min(1).max(64);
/** Optional reference: empty string means none. */
const ref = z.string().max(64);
const iso = z.string().max(40);
const L = TASK_LIMITS;

export const StatusCategorySchema = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
]);
export const TaskPrioritySchema = z.enum(['urgent', 'high', 'medium', 'low']);

// Keep the literal lists above and the exported arrays in types.ts in step.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _categoriesMatch: Same<
  z.infer<typeof StatusCategorySchema>,
  (typeof STATUS_CATEGORIES)[number]
> = true;
const _prioritiesMatch: Same<
  z.infer<typeof TaskPrioritySchema>,
  (typeof TASK_PRIORITIES)[number]
> = true;
void _categoriesMatch;
void _prioritiesMatch;

const title = z.string().trim().min(1).max(L.title);
const description = z.string().max(L.description);
const labels = z.array(z.string().trim().min(1).max(L.label)).max(L.labels);
const users = z.array(id).max(L.assignees);

export const WorkflowStatusSchema = z.object({
  id,
  name: z.string().trim().min(1).max(L.name),
  category: StatusCategorySchema,
  color: z.string().max(32),
  wipLimit: z.number().int().positive().nullable(),
});
export const WorkflowSchema = z.object({
  id,
  name: z.string().trim().min(1).max(L.name),
  statuses: z.array(WorkflowStatusSchema).min(1).max(L.workflowStatuses),
});

export const ChecklistItemSchema = z.object({
  id,
  text: z.string().trim().min(1).max(L.checklistText),
  done: z.boolean(),
  doneBy: ref,
  doneAt: iso,
});

export const ApprovalSchema = z.object({
  approverId: id,
  state: z.enum(['pending', 'approved', 'rejected']),
  comment: z.string().max(L.comment),
  requestedBy: ref,
  requestedAt: iso,
  decidedBy: ref,
  decidedAt: iso,
});

export const TaskSchema = z.object({
  id,
  num: z.number().int().positive(),
  title,
  description,
  statusId: id,
  priority: TaskPrioritySchema,
  runId: ref,
  teamId: ref,
  assignees: users,
  followers: z.array(id).max(500),
  labels,
  dueAt: iso,
  caseId: ref,
  hostId: ref,
  eventId: ref,
  blockedBy: z.array(id).max(L.blockedBy),
  checklist: z.array(ChecklistItemSchema).max(L.checklistItems),
  approval: ApprovalSchema.nullable(),
  archived: z.boolean(),
  createdBy: ref,
  createdAt: iso,
  statusAt: iso,
  doneAt: iso,
});

export const NewTaskSchema = z.object({
  id,
  num: z.number().int().positive().optional(),
  title,
  description: description.default(''),
  statusId: id,
  priority: TaskPrioritySchema.default('medium'),
  runId: ref.default(''),
  labels: labels.default([]),
  dueAt: iso.default(''),
  caseId: ref.default(''),
  hostId: ref.default(''),
  eventId: ref.default(''),
  assignees: users.optional(),
  teamId: ref.optional(),
  followers: z.array(id).max(500).optional(),
  blockedBy: z.array(id).max(L.blockedBy).optional(),
  checklist: z
    .array(z.object({ id, text: z.string().trim().min(1).max(L.checklistText) }))
    .max(L.checklistItems)
    .optional(),
});

/** Strict, like the case patch schemas: only the keys being changed, never defaults. */
export const TaskPatchSchema = z
  .object({
    title,
    description,
    statusId: id,
    priority: TaskPrioritySchema,
    runId: ref,
    labels,
    dueAt: iso,
    caseId: ref,
    hostId: ref,
    eventId: ref,
    archived: z.boolean(),
  })
  .partial()
  .strict();

export const TaskSysSchema = z.object({ statusAt: iso, doneAt: iso });

export const TaskCommentSchema = z.object({
  id,
  taskId: id,
  authorId: ref,
  body: z.string().max(L.comment),
  createdAt: iso,
  editedAt: iso,
  deletedAt: iso,
});

export const TaskRunSchema = z.object({
  id,
  name: z.string().trim().min(1).max(L.name),
  teamId: ref,
  playbookId: ref,
  workflowId: id,
  startDate: iso,
  closed: z.boolean(),
  closedAt: iso,
  createdBy: ref,
  createdAt: iso,
});
export const NewTaskRunSchema = z.object({
  id,
  name: z.string().trim().min(1).max(L.name),
  teamId: ref.default(''),
  playbookId: ref.default(''),
  workflowId: id,
  startDate: iso,
});
export const TaskRunPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(L.name),
    teamId: ref,
    workflowId: id,
    startDate: iso,
    closed: z.boolean(),
  })
  .partial()
  .strict();

export const TaskStateSchema = z.object({
  tasks: z.record(z.string(), TaskSchema),
  comments: z.record(z.string(), TaskCommentSchema),
  runs: z.record(z.string(), TaskRunSchema),
  workflows: z.record(z.string(), WorkflowSchema),
  defaultWorkflowId: id,
  nextNum: z.number().int().positive(),
});
