/**
 * Task REST API. Everything here goes through `TaskRuntime.appendOp`, so the same checks apply
 * to the browser, scripts and agents. The convenience routes (create, patch, comment, runs,
 * workflows) build ops; `POST /api/tasks/ops` takes any client op directly.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  categoryOf,
  matchStatus,
  statusOf,
  taskRef,
  workflowIdFor,
  NewTaskSchema,
  TaskPatchSchema,
  TaskRunPatchSchema,
  WorkflowSchema,
  TASK_LIMITS,
  STATUS_CATEGORIES,
  type StatusCategory,
  type Task,
  type TaskComment,
  type TaskOp,
  type TaskRun,
  type TaskState,
  type Workflow,
} from '@midden/core';
import { actorOf, requireUser } from '../app.js';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { actorName } from '../cases/runtime.js';
import { SubmitOp, Revert } from '../cases/routes.js';
import type { TaskAppendResult } from './runtime.js';
import { canSeeTask, viewerFor, type TaskViewer } from './visibility.js';

const ids = z.array(z.string().min(1).max(64));

export const CreateTask = z.object({
  title: z.string().trim().min(1).max(TASK_LIMITS.title),
  description: z.string().max(TASK_LIMITS.description).default(''),
  status: z.string().max(200).optional().meta({
    description: "A status id or name in the task's workflow, or a category such as `todo`.",
  }),
  priority: NewTaskSchema.shape.priority,
  runId: z.string().max(64).default(''),
  teamId: z.string().max(64).default(''),
  assignees: ids.max(TASK_LIMITS.assignees).default([]),
  labels: NewTaskSchema.shape.labels,
  dueAt: z.string().max(40).default(''),
  caseId: z.string().max(64).default(''),
  hostId: z.string().max(64).default(''),
  eventId: z.string().max(64).default(''),
  blockedBy: ids
    .max(TASK_LIMITS.blockedBy)
    .default([])
    .meta({ description: 'Task ids or T-numbers.' }),
  checklist: z
    .array(z.string().trim().min(1).max(TASK_LIMITS.checklistText))
    .max(TASK_LIMITS.checklistItems)
    .default([]),
  approverId: z.string().max(64).default(''),
});

export const PatchTask = TaskPatchSchema.omit({ statusId: true })
  .extend({
    status: z.string().max(200).optional().meta({ description: 'A status id, name or category.' }),
    assignees: ids
      .max(TASK_LIMITS.assignees)
      .optional()
      .meta({ description: 'Replaces the list.' }),
    teamId: z.string().max(64).optional(),
    approverId: z.string().max(64).optional().meta({ description: 'Empty clears the approver.' }),
  })
  .strict();

export const CommentBody = z.object({ body: z.string().trim().min(1).max(TASK_LIMITS.comment) });

export const TaskListQuery = z.object({
  mine: z.enum(['1']).optional().meta({ description: 'Only tasks assigned to you.' }),
  assignee: z.string().optional().meta({ description: 'A user id.' }),
  team: z.string().optional(),
  run: z.string().optional(),
  case: z.string().optional(),
  category: z
    .string()
    .optional()
    .meta({ description: 'Comma-separated, e.g. `todo,in_progress`.' }),
  open: z.enum(['1']).optional().meta({ description: 'Only tasks not done or cancelled.' }),
  overdue: z.enum(['1']).optional(),
  following: z.enum(['1']).optional(),
  archived: z.enum(['exclude', 'include', 'only']).default('exclude'),
  q: z
    .string()
    .max(200)
    .optional()
    .meta({ description: 'Words to find in the title or description.' }),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export type TaskQuery = Omit<z.infer<typeof TaskListQuery>, 'limit' | 'offset'>;

/** Tasks the viewer can see that match a list query, newest first. */
export function queryTasks(s: TaskState, v: TaskViewer, q: TaskQuery): Task[] {
  const cats = q.category
    ? new Set(
        q.category
          .split(',')
          .map((c) => c.trim())
          .filter((c) => (STATUS_CATEGORIES as string[]).includes(c)),
      )
    : null;
  const words = q.q?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const now = new Date().toISOString();
  const me = v.user.id;
  const list = Object.values(s.tasks).filter((t) => {
    if (!canSeeTask(v, t)) return false;
    if (q.archived === 'exclude' && t.archived) return false;
    if (q.archived === 'only' && !t.archived) return false;
    if (q.mine && !t.assignees.includes(me)) return false;
    if (q.following && !t.followers.includes(me)) return false;
    if (q.assignee && !t.assignees.includes(q.assignee)) return false;
    if (q.team && t.teamId !== q.team) return false;
    if (q.run && t.runId !== q.run) return false;
    if (q.case && t.caseId !== q.case) return false;
    const cat = categoryOf(s, t);
    if (cats && !cats.has(cat)) return false;
    if ((q.open || q.overdue) && (cat === 'done' || cat === 'cancelled')) return false;
    if (q.overdue && !(t.dueAt && t.dueAt < now)) return false;
    if (words.length) {
      const hay = `${taskRef(t.num)} ${t.title} ${t.description}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  return list.sort((a, b) => b.num - a.num);
}

export const CreateRun = z.object({
  name: z.string().trim().min(1).max(TASK_LIMITS.name),
  teamId: z.string().max(64).default(''),
  startDate: z.string().max(40).optional().meta({ description: 'ISO-8601; defaults to now.' }),
  workflowId: z
    .string()
    .max(64)
    .optional()
    .meta({ description: 'Copy this workflow for the run. Defaults to the default workflow.' }),
});
export const PatchRun = TaskRunPatchSchema.omit({ workflowId: true });
export const PutWorkflow = WorkflowSchema.omit({ id: true });

export interface TaskView extends Task {
  ref: string;
  category: StatusCategory;
  statusName: string;
}

export function taskView(state: TaskState, t: Task): TaskView {
  return {
    ...t,
    ref: taskRef(t.num),
    category: categoryOf(state, t),
    statusName: statusOf(state, t)?.name ?? '',
  };
}

/** A task by id, `T-12`, or `12`, if the viewer can see it. */
export function findTask(state: TaskState, v: TaskViewer, key: string): Task | null {
  const m = /^(?:T-?)?(\d+)$/i.exec(key.trim());
  const t = m ? Object.values(state.tasks).find((x) => x.num === Number(m[1])) : state.tasks[key];
  return t && canSeeTask(v, t) ? t : null;
}

export function resolveStatus(
  state: TaskState,
  runId: string,
  status: string | undefined,
): string | undefined {
  if (status === undefined) return undefined;
  const wf = state.workflows[workflowIdFor(state, runId)];
  const s = wf && matchStatus(wf, status);
  if (!s) throw badRequest(`Status "${status}" is not in the ${wf?.name ?? 'task'} workflow`);
  return s.id;
}

/** Turn an append result into a response, or the matching HTTP error. */
export function settle(r: TaskAppendResult): {
  seq: number;
  overwrote: unknown[];
  duplicate: boolean;
} {
  if (!r.ok)
    throw new HttpError(
      r.code === 'notfound'
        ? 404
        : r.code === 'schema' || r.code === 'too_large'
          ? 400
          : r.code === 'conflict'
            ? 409
            : 403,
      r.message,
      r.code,
    );
  return { seq: r.seq, overwrote: r.overwrote, duplicate: r.duplicate };
}

/** A run with how many of its visible, unarchived tasks sit in each category. */
export function runView(s: TaskState, v: TaskViewer, r: TaskRun) {
  const tasks = Object.values(s.tasks).filter(
    (t) => t.runId === r.id && canSeeTask(v, t) && !t.archived,
  );
  const byCat = Object.fromEntries(STATUS_CATEGORIES.map((c) => [c, 0])) as Record<
    StatusCategory,
    number
  >;
  for (const t of tasks) byCat[categoryOf(s, t)]++;
  return { ...r, counts: byCat, total: tasks.length };
}

interface TaskOpRow {
  seq: number;
  ts: string;
  actor_id: string;
  via: string | null;
  display_name: string | null;
  type: string;
  payload: string;
  inverse: string | null;
  client_op_id: string | null;
  base_seq: number | null;
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  const rt = (): typeof app.tasks => app.tasks;
  const submit = (
    req: FastifyRequest,
    op: TaskOp,
    extra: { clientOpId?: string | undefined; baseSeq?: number | undefined } = {},
  ) =>
    settle(
      rt().appendOp(actorOf(req), op, {
        user: requireUser(req),
        viaToken: !!req.token,
        ...extra,
      }),
    );
  const viewer = (req: FastifyRequest): TaskViewer => viewerFor(app.db, requireUser(req));
  const mustFind = (v: TaskViewer, key: string): Task => {
    const t = findTask(rt().state, v, key);
    if (!t) throw notFound('No such task');
    return t;
  };

  /** Whether every task a logged op touched is one the viewer can see (admins see all). */
  const opVisible = (v: TaskViewer, seq: number): boolean =>
    v.user.role === 'admin' ||
    app.db
      .all<{ task_id: string }>('SELECT task_id FROM task_op_tasks WHERE seq = ?', seq)
      .every((r) => {
        const t = rt().state.tasks[r.task_id];
        return !t || canSeeTask(v, t);
      });

  /** Records of logged ops, without any that touch a task the viewer can't see. */
  const opRecords = (v: TaskViewer, rows: TaskOpRow[]) =>
    rows
      .filter((r) => opVisible(v, Number(r.seq)))
      .map((r) => ({
        seq: Number(r.seq),
        ts: r.ts,
        actor: { id: r.actor_id, name: actorName(r.display_name ?? r.actor_id, r.via) },
        via: r.via,
        type: r.type,
        op: JSON.parse(r.payload) as TaskOp,
        inverse: r.inverse ? (JSON.parse(r.inverse) as TaskOp) : null,
        clientOpId: r.client_op_id,
        baseSeq: r.base_seq === null ? null : Number(r.base_seq),
      }));

  app.get('/api/tasks', async (req) => {
    const v = viewer(req);
    const q = TaskListQuery.parse(req.query);
    const s = rt().state;
    const list = queryTasks(s, v, q);
    return {
      tasks: list.slice(q.offset, q.offset + q.limit).map((t) => taskView(s, t)),
      total: list.length,
      seq: rt().seq,
    };
  });

  app.post('/api/tasks', async (req, reply) => {
    const v = viewer(req);
    const b = CreateTask.parse(req.body);
    const s = rt().state;
    const id = newId('tk');
    const blockedBy = b.blockedBy.map((k) => {
      const t = findTask(s, v, k);
      if (!t) throw badRequest(`Blocked by unknown task "${k}"`);
      return t.id;
    });
    const ops: TaskOp[] = [
      {
        type: 'task.add',
        task: {
          id,
          title: b.title,
          description: b.description,
          statusId: resolveStatus(s, b.runId, b.status ?? '')!,
          priority: b.priority,
          runId: b.runId,
          labels: b.labels,
          dueAt: b.dueAt,
          caseId: b.caseId,
          hostId: b.hostId,
          eventId: b.eventId,
          assignees: b.assignees,
          teamId: b.teamId,
          blockedBy,
          checklist: b.checklist.map((text) => ({ id: newId('ci'), text })),
        },
      },
    ];
    if (b.approverId) ops.push({ type: 'approval.set', taskId: id, approverId: b.approverId });
    const r = submit(req, ops.length === 1 ? ops[0]! : { type: 'batch', ops });
    reply.status(201);
    return { task: taskView(rt().state, rt().state.tasks[id]!), seq: r.seq };
  });

  app.get('/api/tasks/state', async (req) => {
    const v = viewer(req);
    const s = rt().state;
    const tasks: Record<string, Task> = {};
    for (const [id, t] of Object.entries(s.tasks)) if (canSeeTask(v, t)) tasks[id] = t;
    const comments: Record<string, TaskComment> = {};
    for (const [id, c] of Object.entries(s.comments)) if (tasks[c.taskId]) comments[id] = c;
    return { seq: rt().seq, state: { ...s, tasks, comments } };
  });

  app.post('/api/tasks/ops', async (req) => {
    requireUser(req);
    const body = SubmitOp.parse(req.body);
    return submit(req, body.op as TaskOp, { clientOpId: body.clientOpId, baseSeq: body.baseSeq });
  });

  app.get<{ Querystring: { after?: string; before?: string; limit?: string } }>(
    '/api/tasks/ops',
    async (req) => {
      const v = viewer(req);
      const limit = Math.min(2000, Math.max(1, Number(req.query.limit ?? 200) || 200));
      const before = req.query.before !== undefined ? Number(req.query.before) : null;
      const sql =
        'SELECT o.*, u.display_name FROM task_ops o LEFT JOIN users u ON u.id = o.actor_id';
      const rows =
        before !== null
          ? app.db
              .all<TaskOpRow>(`${sql} WHERE o.seq < ? ORDER BY o.seq DESC LIMIT ?`, before, limit)
              .reverse()
          : app.db.all<TaskOpRow>(
              `${sql} WHERE o.seq > ? ORDER BY o.seq LIMIT ?`,
              Number(req.query.after ?? 0) || 0,
              limit,
            );
      return { ops: opRecords(v, rows), seq: rt().seq };
    },
  );

  app.post('/api/tasks/revert', async (req) => {
    const user = requireUser(req);
    const v = viewerFor(app.db, user);
    const { seq } = Revert.parse(req.body);
    const target = app.db.get<{ inverse: string | null }>(
      'SELECT inverse FROM task_ops WHERE seq = ?',
      seq,
    );
    if (!target || !opVisible(v, seq)) throw notFound('No such op');
    if (!target.inverse) throw badRequest('This op has no recorded inverse');
    const op: TaskOp = {
      type: 'op.revert',
      targetSeq: seq,
      inverse: JSON.parse(target.inverse) as TaskOp,
    };
    return settle(rt().appendOp(actorOf(req), op, { user, viaToken: !!req.token, internal: true }));
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req) => {
    const v = viewer(req);
    const s = rt().state;
    const t = mustFind(v, req.params.id);
    const brief = (x: Task) => ({
      id: x.id,
      ref: taskRef(x.num),
      title: x.title,
      category: categoryOf(s, x),
    });
    return {
      task: taskView(s, t),
      comments: Object.values(s.comments)
        .filter((c) => c.taskId === t.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      blockedBy: t.blockedBy
        .map((b) => s.tasks[b])
        .filter((x): x is Task => !!x && canSeeTask(v, x))
        .map(brief),
      blocking: Object.values(s.tasks)
        .filter((x) => x.blockedBy.includes(t.id) && canSeeTask(v, x))
        .map(brief),
    };
  });

  app.patch<{ Params: { id: string } }>('/api/tasks/:id', async (req) => {
    const v = viewer(req);
    const t = mustFind(v, req.params.id);
    const { status, assignees, teamId, approverId, ...patch } = PatchTask.parse(req.body);
    const s = rt().state;
    const ops: TaskOp[] = [];
    const statusId = resolveStatus(s, patch.runId ?? t.runId, status);
    const fields = { ...patch, ...(statusId !== undefined ? { statusId } : {}) };
    if (Object.keys(fields).length) ops.push({ type: 'task.set', id: t.id, patch: fields });
    if (assignees !== undefined || teamId !== undefined)
      ops.push({
        type: 'task.assign',
        ids: [t.id],
        mode: 'set',
        users: assignees ?? t.assignees,
        ...(teamId !== undefined ? { teamId } : {}),
      });
    if (approverId !== undefined && approverId !== (t.approval?.approverId ?? ''))
      ops.push({ type: 'approval.set', taskId: t.id, approverId });
    if (ops.length === 0) return { task: taskView(s, t), seq: rt().seq };
    const r = submit(req, ops.length === 1 ? ops[0]! : { type: 'batch', ops });
    return { task: taskView(rt().state, rt().state.tasks[t.id]!), seq: r.seq };
  });

  app.post<{ Params: { id: string } }>('/api/tasks/:id/comments', async (req, reply) => {
    const v = viewer(req);
    const t = mustFind(v, req.params.id);
    const { body } = CommentBody.parse(req.body);
    const id = newId('cm');
    const r = submit(req, { type: 'comment.add', comment: { id, taskId: t.id, body } });
    reply.status(201);
    return { comment: rt().state.comments[id], seq: r.seq };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id/history', async (req) => {
    const v = viewer(req);
    const t = mustFind(v, req.params.id);
    const rows = app.db.all<TaskOpRow>(
      `SELECT o.*, u.display_name FROM task_op_tasks x JOIN task_ops o ON o.seq = x.seq
         LEFT JOIN users u ON u.id = o.actor_id WHERE x.task_id = ? ORDER BY o.seq`,
      t.id,
    );
    return { ops: opRecords(v, rows) };
  });

  /* ---- runs ---- */

  app.get('/api/task-runs', async (req) => {
    const v = viewer(req);
    const s = rt().state;
    return {
      runs: Object.values(s.runs)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((r) => runView(s, v, r)),
    };
  });

  app.post('/api/task-runs', async (req, reply) => {
    const v = viewer(req);
    const b = CreateRun.parse(req.body);
    const s = rt().state;
    const from = s.workflows[b.workflowId ?? s.defaultWorkflowId];
    if (!from) throw notFound('No such workflow');
    const runId = newId('run');
    const workflow: Workflow = {
      ...from,
      id: newId('wf'),
      name: `${b.name} workflow`,
      statuses: from.statuses.map((x) => ({ ...x })),
    };
    const r = submit(req, {
      type: 'batch',
      ops: [
        { type: 'workflow.set', workflow },
        {
          type: 'run.add',
          run: {
            id: runId,
            name: b.name,
            teamId: b.teamId,
            playbookId: '',
            workflowId: workflow.id,
            startDate: b.startDate ? new Date(b.startDate).toISOString() : new Date().toISOString(),
          },
        },
      ],
    });
    reply.status(201);
    return { run: runView(rt().state, v, rt().state.runs[runId]!), seq: r.seq };
  });

  app.patch<{ Params: { id: string } }>('/api/task-runs/:id', async (req) => {
    const v = viewer(req);
    if (!rt().state.runs[req.params.id]) throw notFound('No such run');
    const patch = PatchRun.parse(req.body);
    const r = submit(req, { type: 'run.set', id: req.params.id, patch });
    return { run: runView(rt().state, v, rt().state.runs[req.params.id]!), seq: r.seq };
  });

  /* ---- workflows ---- */

  app.get('/api/workflows', async (req) => {
    requireUser(req);
    const s = rt().state;
    return { workflows: Object.values(s.workflows), defaultWorkflowId: s.defaultWorkflowId };
  });

  app.put<{ Params: { id: string } }>('/api/workflows/:id', async (req) => {
    requireUser(req);
    const body = PutWorkflow.parse(req.body);
    const workflow: Workflow = { id: req.params.id, ...body };
    const r = submit(req, { type: 'workflow.set', workflow });
    return { workflow: rt().state.workflows[req.params.id], seq: r.seq };
  });
}
