/**
 * Playbooks, CSV import and CSV export. One file format serves all three (see
 * core/tasks/playbook.ts), so a team can export a run, keep it, and import it again, or save a
 * finished run as the playbook for the next hunt.
 *
 * - Playbooks are plain CRUD. Anyone signed in can read them; a lead of the playbook's team (or
 *   an admin) changes them, and only admins keep playbooks that belong to no team.
 * - An import starts a run (or adds to one) as a single batch op, so it undoes in one step. It
 *   takes a lead of the run's team or an admin; `?preview=1` runs every check, the runtime's
 *   permission and data checks included, and commits nothing.
 * - Export takes the same filters as `GET /api/tasks` and leaves out what the caller can't see.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  categoryOf,
  exportTasksCsv,
  matchStatus,
  parsePlaybookCsv,
  planImport,
  statusOf,
  taskOpSize,
  MAX_PLAYBOOK_BYTES,
  MAX_TASK_BATCH,
  STATUS_CATEGORIES,
  TASK_LIMITS,
  StatusCategorySchema,
  WorkflowStatusSchema,
  type ImportIssue,
  type StatusCategory,
  type Task,
  type TaskComment,
  type TaskOp,
  type TaskState,
  type Workflow,
  type WorkflowStatus,
} from '@midden/core';
import { actorOf, requireUser } from '../app.js';
import type { User } from '../auth/sessions.js';
import { listUsers } from '../auth/sessions.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { getTeam, ledTeamIds, listTeams } from '../teams/teams.js';
import { queryTasks, runView, settle, TaskListQuery } from './routes.js';
import { viewerFor, type TaskViewer } from './visibility.js';

const statuses = z.array(WorkflowStatusSchema).min(1).max(TASK_LIMITS.workflowStatuses);

export const CreatePlaybook = z.object({
  name: z.string().trim().min(1).max(TASK_LIMITS.name),
  description: z.string().max(2000).default(''),
  teamId: z
    .string()
    .max(64)
    .default('')
    .meta({ description: 'Empty for a playbook every team can use (admins only).' }),
  csv: z.string().max(MAX_PLAYBOOK_BYTES).meta({ description: 'The playbook CSV.' }),
  statuses: statuses.nullable().default(null).meta({
    description: 'Workflow for runs started from it; null uses the default workflow.',
  }),
});
export const PatchPlaybook = z
  .object({
    name: CreatePlaybook.shape.name,
    description: z.string().max(2000),
    teamId: z.string().max(64),
    csv: CreatePlaybook.shape.csv,
    statuses: statuses.nullable(),
  })
  .partial()
  .strict();

export const SaveRunAsPlaybook = z.object({
  name: z.string().trim().min(1).max(TASK_LIMITS.name).optional().meta({
    description: "Defaults to the run's name.",
  }),
  description: z.string().max(2000).default(''),
  teamId: z.string().max(64).optional().meta({ description: "Defaults to the run's team." }),
  keepAssignees: z.boolean().default(false),
  keepStatus: z
    .boolean()
    .default(false)
    .meta({ description: 'Keep statuses and ticked checklist items instead of starting fresh.' }),
});

const NewStatus = z.object({
  name: z.string().trim().min(1).max(TASK_LIMITS.name),
  category: StatusCategorySchema,
});

export const ImportTasks = z
  .object({
    csv: z.string().max(MAX_PLAYBOOK_BYTES).optional(),
    playbookId: z.string().max(64).optional(),
    runId: z
      .string()
      .max(64)
      .optional()
      .meta({ description: 'Add the tasks to this run instead of starting one.' }),
    run: z
      .object({
        name: z.string().trim().min(1).max(TASK_LIMITS.name),
        teamId: z.string().max(64).default(''),
        startDate: z
          .string()
          .max(40)
          .optional()
          .meta({ description: 'ISO-8601; relative due dates count from here. Defaults to now.' }),
      })
      .optional()
      .meta({ description: 'Start this run for the tasks.' }),
    addStatuses: z.array(NewStatus).max(TASK_LIMITS.workflowStatuses).default([]).meta({
      description: "Statuses to add to the run's workflow, for status names it doesn't have.",
    }),
  })
  .refine((b) => (b.csv === undefined) !== (b.playbookId === undefined), {
    message: 'Give either csv or playbookId',
  })
  .refine((b) => (b.runId === undefined) !== (b.run === undefined), {
    message: 'Give either runId or run',
  });

export const ImportQuery = z.object({
  preview: z.enum(['1']).optional().meta({ description: 'Check the import and change nothing.' }),
});

export const ExportQuery = TaskListQuery.omit({ limit: true, offset: true }).extend({
  due: z.enum(['absolute', 'relative']).default('absolute').meta({
    description: "`relative` writes due dates as offsets from the run's start (needs `run`).",
  }),
  comments: z.enum(['1']).optional().meta({ description: 'Add a comments column.' }),
  state: z
    .enum(['0', '1'])
    .default('1')
    .meta({ description: 'Add the read-only columns (id, created, completed, approval).' }),
});

interface PlaybookRow {
  id: string;
  name: string;
  description: string;
  team_id: string;
  csv: string;
  statuses: string | null;
  version: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

export interface Playbook {
  id: string;
  name: string;
  description: string;
  teamId: string;
  statuses: WorkflowStatus[] | null;
  version: number;
  /** Tasks in the file. */
  rows: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

const toPlaybook = (r: PlaybookRow): Playbook => ({
  id: r.id,
  name: r.name,
  description: r.description,
  teamId: r.team_id,
  statuses: r.statuses ? (JSON.parse(r.statuses) as WorkflowStatus[]) : null,
  version: Number(r.version),
  rows: parsePlaybookCsv(r.csv).rows.length,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

/** Refuse a CSV with errors (unknown users and the like are only checked at import). */
function checkCsv(csv: string): void {
  const errors = parsePlaybookCsv(csv).issues.filter((i) => i.severity === 'error');
  if (errors.length)
    throw badRequest(
      `The CSV has ${errors.length} problem${errors.length === 1 ? '' : 's'}: ${errors
        .slice(0, 3)
        .map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message))
        .join('; ')}`,
    );
}

function checkStatuses(list: WorkflowStatus[] | null): void {
  if (!list) return;
  const ids = list.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw badRequest('Status ids must be unique');
}

/** Add statuses by name, each after the last status of its category or an earlier one. */
export function withStatuses(
  list: WorkflowStatus[],
  add: { name: string; category: StatusCategory }[],
): WorkflowStatus[] {
  const out = list.map((s) => ({ ...s }));
  const rank = (c: StatusCategory): number => STATUS_CATEGORIES.indexOf(c);
  for (const a of add) {
    if (out.some((s) => s.name.toLowerCase() === a.name.toLowerCase())) continue;
    const base = `st_${
      a.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '') || 'status'
    }`;
    let id = base;
    for (let n = 2; out.some((s) => s.id === id); n++) id = `${base}_${n}`;
    let at = 0;
    out.forEach((s, i) => {
      if (rank(s.category) <= rank(a.category)) at = i + 1;
    });
    out.splice(at, 0, { id, name: a.name, category: a.category, color: '', wipLimit: null });
  }
  return out;
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'tasks';

export async function playbookRoutes(app: FastifyInstance): Promise<void> {
  const rt = () => app.tasks;
  const viewer = (req: FastifyRequest): TaskViewer => viewerFor(app.db, requireUser(req));
  const leads = (u: User, teamId: string): boolean =>
    u.role === 'admin' || (!!teamId && ledTeamIds(app.db, u.id).has(teamId));

  const load = (id: string): PlaybookRow => {
    const r = app.db.get<PlaybookRow>('SELECT * FROM playbooks WHERE id = ?', id);
    if (!r) throw notFound('No such playbook');
    return r;
  };
  const mayKeep = (u: User, teamId: string): void => {
    if (teamId && !getTeam(app.db, teamId)) throw notFound('No such team');
    if (!leads(u, teamId))
      throw forbidden(
        teamId
          ? 'Only a lead of that team or an admin can change its playbooks'
          : 'Only an admin can keep a playbook for every team',
      );
  };

  const exportNames = () => {
    const users = new Map(
      listUsers(app.db).map((x) => [x.id, { username: x.username, displayName: x.displayName }]),
    );
    const teams = new Map(listTeams(app.db).map((x) => [x.id, { name: x.name }]));
    const cases = new Map(
      app.db
        .all<{ id: string; name: string; number: string }>('SELECT id, name, number FROM cases')
        .map((x) => [x.id, { name: x.name, number: x.number }]),
    );
    return { users, teams, cases };
  };

  const insert = (u: User, b: z.infer<typeof CreatePlaybook>): Playbook => {
    const id = newId('pb');
    const now = nowIso();
    app.db.run(
      `INSERT INTO playbooks (id, name, description, team_id, csv, statuses, version,
         created_by, created_at, updated_by, updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?)`,
      id,
      b.name,
      b.description,
      b.teamId,
      b.csv,
      b.statuses ? JSON.stringify(b.statuses) : null,
      u.id,
      now,
      u.id,
      now,
    );
    return toPlaybook(load(id));
  };

  app.get('/api/playbooks', async (req) => {
    requireUser(req);
    return {
      playbooks: app.db
        .all<PlaybookRow>('SELECT * FROM playbooks ORDER BY name COLLATE NOCASE')
        .map(toPlaybook),
    };
  });

  app.get<{ Params: { id: string } }>('/api/playbooks/:id', async (req) => {
    requireUser(req);
    const r = load(req.params.id);
    return { playbook: { ...toPlaybook(r), csv: r.csv } };
  });

  app.post('/api/playbooks', async (req, reply) => {
    const u = requireUser(req);
    const b = CreatePlaybook.parse(req.body);
    mayKeep(u, b.teamId);
    checkCsv(b.csv);
    checkStatuses(b.statuses);
    reply.status(201);
    return { playbook: insert(u, b) };
  });

  app.patch<{ Params: { id: string } }>('/api/playbooks/:id', async (req) => {
    const u = requireUser(req);
    const r = load(req.params.id);
    mayKeep(u, r.team_id);
    const b = PatchPlaybook.parse(req.body);
    if (b.teamId !== undefined && b.teamId !== r.team_id) mayKeep(u, b.teamId);
    if (b.csv !== undefined) checkCsv(b.csv);
    if (b.statuses !== undefined) checkStatuses(b.statuses);
    const content =
      (b.csv !== undefined && b.csv !== r.csv) ||
      (b.statuses !== undefined && JSON.stringify(b.statuses) !== (r.statuses ?? 'null'));
    app.db.run(
      `UPDATE playbooks SET name = ?, description = ?, team_id = ?, csv = ?, statuses = ?,
         version = version + ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      b.name ?? r.name,
      b.description ?? r.description,
      b.teamId ?? r.team_id,
      b.csv ?? r.csv,
      b.statuses === undefined ? r.statuses : b.statuses ? JSON.stringify(b.statuses) : null,
      content ? 1 : 0,
      u.id,
      nowIso(),
      r.id,
    );
    return { playbook: toPlaybook(load(r.id)) };
  });

  app.delete<{ Params: { id: string } }>('/api/playbooks/:id', async (req) => {
    const u = requireUser(req);
    const r = load(req.params.id);
    mayKeep(u, r.team_id);
    app.db.run('DELETE FROM playbooks WHERE id = ?', r.id);
    return { ok: true };
  });

  /* ---- save a run as a playbook ---- */

  app.post<{ Params: { id: string } }>('/api/task-runs/:id/playbook', async (req, reply) => {
    const u = requireUser(req);
    const v = viewerFor(app.db, u);
    const s = rt().state;
    const run = s.runs[req.params.id];
    if (!run) throw notFound('No such run');
    const b = SaveRunAsPlaybook.parse(req.body);
    const teamId = b.teamId ?? run.teamId;
    mayKeep(u, teamId);
    // A playbook is shared with the whole team, so tasks linked to any restricted case stay out,
    // even when the person saving it can read that case. Case links are per-hunt anyway.
    const restricted = new Set(
      app.db.all<{ id: string }>('SELECT id FROM cases WHERE restricted = 1').map((r) => r.id),
    );
    const all = queryTasks(s, v, { run: run.id, archived: 'exclude' });
    const kept = all.filter((t) => !restricted.has(t.caseId));
    const shaped = kept.map((t): Task => ({
      ...t,
      caseId: '',
      assignees: b.keepAssignees ? t.assignees : [],
      checklist: b.keepStatus ? t.checklist : t.checklist.map((c) => ({ ...c, done: false })),
    }));
    const csv = exportTasksCsv(shaped, {
      ...exportNames(),
      statusName: (t) => (b.keepStatus ? (statusOf(s, t)?.name ?? '') : ''),
      relativeTo: run.startDate,
      stateColumns: false,
    });
    const wf = s.workflows[run.workflowId];
    const playbook = insert(u, {
      name: b.name ?? run.name,
      description: b.description,
      teamId,
      csv,
      statuses: wf ? wf.statuses : null,
    });
    reply.status(201);
    return { playbook, skipped: all.length - kept.length };
  });

  /* ---- import ---- */

  app.post('/api/tasks/import', async (req, reply) => {
    const user = requireUser(req);
    const v = viewerFor(app.db, user);
    const preview = ImportQuery.parse(req.query).preview === '1';
    const b = ImportTasks.parse(req.body);
    const s = rt().state;

    const pb = b.playbookId ? load(b.playbookId) : null;
    const csv = pb ? pb.csv : b.csv!;
    const existing = b.runId ? s.runs[b.runId] : undefined;
    if (b.runId && !existing) throw notFound('No such run');
    if (existing?.closed) throw badRequest('That run is closed; reopen it first');
    const teamId = existing ? existing.teamId : b.run!.teamId;
    if (teamId && !getTeam(app.db, teamId)) throw notFound('No such team');
    if (user.role === 'viewer') throw forbidden('Viewers cannot import tasks');
    if (!leads(user, teamId))
      throw forbidden(
        teamId
          ? "Importing tasks takes a lead of the run's team or an admin"
          : 'Only an admin can import into a run with no team',
      );

    let startDate: string;
    if (existing) startDate = existing.startDate;
    else {
      const d = b.run!.startDate ? new Date(b.run!.startDate) : new Date();
      if (Number.isNaN(d.getTime())) throw badRequest('Start date is not a date');
      startDate = d.toISOString();
    }

    // The run's workflow: its own when adding to a run, else a copy of the playbook's or the
    // default, with any statuses the caller asked to add.
    const ops: TaskOp[] = [];
    let workflow: Workflow;
    if (existing) {
      const wf = s.workflows[existing.workflowId]!;
      workflow = { ...wf, statuses: withStatuses(wf.statuses, b.addStatuses) };
      if (workflow.statuses.length !== wf.statuses.length)
        ops.push({ type: 'workflow.set', workflow });
    } else {
      const from = pb?.statuses
        ? (JSON.parse(pb.statuses) as WorkflowStatus[])
        : s.workflows[s.defaultWorkflowId]!.statuses;
      workflow = {
        id: newId('wf'),
        name: `${b.run!.name} workflow`,
        statuses: withStatuses(from, b.addStatuses),
      };
      ops.push({ type: 'workflow.set', workflow });
    }
    if (workflow.statuses.length > TASK_LIMITS.workflowStatuses)
      throw badRequest(`A workflow has at most ${TASK_LIMITS.workflowStatuses} statuses`);
    const runId = existing?.id ?? newId('run');
    if (!existing)
      ops.push({
        type: 'run.add',
        run: {
          id: runId,
          name: b.run!.name,
          teamId,
          playbookId: pb?.id ?? '',
          workflowId: workflow.id,
          startDate,
        },
      });

    const parsed = parsePlaybookCsv(csv);
    const dir = app.taskChannel.directoryFor(v);
    const disabled = new Map(
      dir.users.filter((x) => x.disabled).map((x) => [x.username.toLowerCase(), x]),
    );
    const plan = planImport(parsed.rows, {
      directory: { ...dir, users: dir.users.filter((x) => !x.disabled) },
      workflow,
      runId,
      startDate,
      defaultTeamId: teamId,
      newId,
    });
    const issues: ImportIssue[] = [...parsed.issues];
    for (const i of plan.issues) {
      // "Unknown user" is wrong for someone who exists but is switched off.
      const m = /^Unknown (user|approver) "(.*)"$/.exec(i.message);
      const off = m && disabled.get(m[2]!.toLowerCase());
      issues.push(off ? { ...i, message: `${off.displayName} is disabled` } : i);
    }
    const batch: TaskOp = { type: 'batch', ops: [...ops, ...plan.ops] };
    if (taskOpSize(batch) > MAX_TASK_BATCH)
      issues.push({
        line: 0,
        severity: 'error',
        message: `The import needs more than ${MAX_TASK_BATCH} changes; split the file`,
      });
    if (parsed.rows.length === 0 && !issues.some((i) => i.severity === 'error'))
      issues.push({ line: 0, severity: 'error', message: 'The file has no tasks' });

    // With the file itself in order, ask the runtime: it knows who may be assigned what.
    let ok = !issues.some((i) => i.severity === 'error');
    if (ok) {
      const dry = rt().appendOp(actorOf(req), batch, {
        user,
        viaToken: !!req.token,
        dryRun: true,
      });
      if (!dry.ok) {
        issues.push({ line: 0, severity: 'error', message: dry.message });
        ok = false;
      }
    }

    if (preview) {
      const users = new Map(dir.users.map((x) => [x.id, x.displayName]));
      const teams = new Map(dir.teams.map((x) => [x.id, x.name]));
      const cases = new Map(dir.cases.map((x) => [x.id, x.number || x.name]));
      const statusById = new Map(workflow.statuses.map((x) => [x.id, x]));
      const keyOf = new Map([...plan.ids].map(([k, id]) => [id, k]));
      const approvers = new Map<string, string>();
      for (const o of plan.ops)
        if (o.type === 'approval.set') approvers.set(o.taskId, users.get(o.approverId) ?? '');
      const deps = new Map<string, string[]>();
      for (const o of plan.ops)
        if (o.type === 'dep.add')
          deps.set(o.taskId, [...(deps.get(o.taskId) ?? []), keyOf.get(o.blockedById) ?? '']);
      const rowOf = new Map(parsed.rows.map((r) => [plan.ids.get(r.key), r]));
      return {
        ok,
        issues,
        unknownStatuses: plan.unknownStatuses,
        run: { id: existing?.id ?? '', name: existing?.name ?? b.run!.name, teamId, startDate },
        workflow: {
          name: existing ? workflow.name : `${b.run!.name} workflow`,
          statuses: workflow.statuses,
        },
        tasks: plan.ops.flatMap((o) => {
          if (o.type !== 'task.add') return [];
          const t = o.task;
          const row = rowOf.get(t.id);
          // A status the workflow lacks shows as written, not as the fallback it was given.
          const unknown = row && !matchStatus(workflow, row.status);
          const st = unknown ? undefined : statusById.get(t.statusId);
          return [
            {
              line: row?.line ?? 0,
              key: keyOf.get(t.id) ?? '',
              title: t.title,
              status: unknown ? row.status : (st?.name ?? ''),
              category: st?.category ?? 'todo',
              priority: t.priority,
              assignees: (t.assignees ?? []).map((id) => users.get(id) ?? id),
              team: t.teamId ? (teams.get(t.teamId) ?? '') : '',
              labels: t.labels,
              dueAt: t.dueAt,
              blockedBy: deps.get(t.id) ?? [],
              checklist: t.checklist?.length ?? 0,
              approver: approvers.get(t.id) ?? '',
              case: t.caseId ? (cases.get(t.caseId) ?? '') : '',
            },
          ];
        }),
      };
    }

    if (!ok) {
      const errors = issues.filter((i) => i.severity === 'error');
      throw new HttpError(
        400,
        `The import has ${errors.length} problem${errors.length === 1 ? '' : 's'}: ${errors
          .slice(0, 3)
          .map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message))
          .join('; ')}`,
        'import_invalid',
      );
    }
    const r = settle(rt().appendOp(actorOf(req), batch, { user, viaToken: !!req.token }));
    reply.status(201);
    return {
      run: runView(rt().state, v, rt().state.runs[runId]!),
      created: plan.ids.size,
      warnings: issues.filter((i) => i.severity === 'warning'),
      seq: r.seq,
    };
  });

  /* ---- export ---- */

  app.get('/api/tasks/export', async (req, reply) => {
    const v = viewer(req);
    const q = ExportQuery.parse(req.query);
    const s: TaskState = rt().state;
    const run = q.run ? s.runs[q.run] : undefined;
    if (q.run && !run) throw notFound('No such run');
    if (q.due === 'relative' && !run)
      throw badRequest('Relative due dates count from a run’s start, so they need `run`');
    const tasks = queryTasks(s, v, q);
    let comments: Map<string, TaskComment[]> | undefined;
    if (q.comments) {
      const ids = new Set(tasks.map((t) => t.id));
      comments = new Map();
      for (const c of Object.values(s.comments))
        if (ids.has(c.taskId)) comments.set(c.taskId, [...(comments.get(c.taskId) ?? []), c]);
      for (const list of comments.values())
        list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    const csv = exportTasksCsv(tasks, {
      ...exportNames(),
      statusName: (t) => statusOf(s, t)?.name ?? categoryOf(s, t),
      relativeTo: q.due === 'relative' ? run!.startDate : undefined,
      comments,
      stateColumns: q.state === '1',
    });
    const name = `${slug(run?.name ?? 'tasks')}-${nowIso().slice(0, 10)}.csv`;
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store');
    return csv;
  });
}
