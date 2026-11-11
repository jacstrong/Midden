/**
 * Task lists that move between cases: a lead writes the standard opening moves of a hunt once
 * (in Midden or a spreadsheet) and loads them into every new case.
 *
 * A template names people by username and hosts by name or address, never by id, because ids
 * mean nothing in another case or on another server. Import resolves the names against the
 * target case and reports whatever it could not place. Linked events are left out for the same
 * reason; they only exist in the case they came from.
 */
import { z } from 'zod';
import type { CaseState, Task, TaskPriority, TaskStatus } from '../domain/types.js';
import { TaskPrioritySchema, TaskStatusSchema } from '../domain/schemas.js';
import { uid } from '../domain/ids.js';
import { hostIps } from '../ip/ip.js';
import type { Op } from '../ops/ops.js';
import { csvEscape } from '../report/report.js';
import { bottomRank, type TaskActor } from './tasks.js';

export const TASK_TEMPLATE_SCHEMA = 'midden.tasks.v1';
export const MAX_TEMPLATE_TASKS = 2000;

const list = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : splitList(v)))
  .transform((v) => v.map((x) => x.trim()).filter(Boolean))
  .default([]);
const text = z.string().default('');

const STATUS_WORDS: Record<string, TaskStatus> = {
  inprogress: 'doing',
  progress: 'doing',
  active: 'doing',
  started: 'doing',
  open: 'todo',
  new: 'todo',
  complete: 'done',
  completed: 'done',
  closed: 'done',
  waiting: 'blocked',
  onhold: 'blocked',
};
const PRIORITY_WORDS: Record<string, TaskPriority> = {
  critical: 'urgent',
  p1: 'urgent',
  p2: 'high',
  medium: 'normal',
  p3: 'normal',
  p4: 'low',
};
const word = (v: unknown): unknown =>
  typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9]/g, '') : v;

export const TemplateTaskSchema = z.object({
  title: z.string().trim().min(1, 'a task needs a title').max(500),
  description: text,
  status: z
    .preprocess((v) => STATUS_WORDS[word(v) as string] ?? word(v), TaskStatusSchema)
    .catch('todo')
    .default('todo'),
  priority: z
    .preprocess((v) => PRIORITY_WORDS[word(v) as string] ?? word(v), TaskPrioritySchema)
    .catch('normal')
    .default('normal'),
  /** Usernames (hosted) or names (standalone). */
  assignees: list,
  /** Host names or addresses in the target case. */
  hosts: list,
  technique: text,
  tags: list,
  due: text,
  /** Checklist item texts, all unticked on import. */
  checklist: list,
});
export type TemplateTask = z.output<typeof TemplateTaskSchema>;

export interface TaskTemplateFile {
  schema: typeof TASK_TEMPLATE_SCHEMA;
  generator: string;
  exported: string;
  tasks: TemplateTask[];
}

export class TaskTemplateError extends Error {
  override name = 'TaskTemplateError';
}

/** `a; b; c` or one per line. Commas stay, so a title or checklist item can contain one. */
export function splitList(s: string): string[] {
  return s
    .split(/[;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/* ---------------- export ---------------- */

export interface TemplateNames {
  /** A username for an assignee id; standalone passes the name straight through. */
  user(id: string): string;
}

export function taskToTemplate(state: CaseState, t: Task, names: TemplateNames): TemplateTask {
  return {
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    assignees: t.assignees.map((a) => names.user(a)),
    hosts: t.hostIds.map((h) => state.hosts[h]?.name).filter((n): n is string => !!n),
    technique: t.technique,
    tags: [...t.tags],
    due: t.due,
    checklist: t.checklist.map((c) => c.text).filter(Boolean),
  };
}

export function writeTaskTemplate(
  state: CaseState,
  ids: readonly string[],
  names: TemplateNames,
  opts: { generator?: string; now?: string } = {},
): TaskTemplateFile {
  const tasks = ids
    .map((id) => state.tasks[id])
    .filter((t): t is Task => !!t)
    .sort((a, b) => a.rank - b.rank)
    .map((t) => taskToTemplate(state, t, names));
  return {
    schema: TASK_TEMPLATE_SCHEMA,
    generator: opts.generator ?? 'MIDDEN',
    exported: opts.now ?? new Date().toISOString(),
    tasks,
  };
}

export const TASK_CSV_COLUMNS = [
  'title',
  'description',
  'status',
  'priority',
  'assignees',
  'hosts',
  'technique',
  'tags',
  'due',
  'checklist',
] as const;

/** One row per task; list cells are joined with `; ` so a spreadsheet keeps them in one cell. */
export function taskTemplateCsv(tasks: readonly TemplateTask[]): string {
  const rows = [TASK_CSV_COLUMNS.join(',')];
  for (const t of tasks)
    rows.push(
      TASK_CSV_COLUMNS.map((c) => {
        const v = t[c];
        return csvEscape(Array.isArray(v) ? v.join('; ') : v);
      }).join(','),
    );
  return rows.join('\r\n') + '\r\n';
}

/* ---------------- import ---------------- */

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes, CRLF or LF. */
export function parseCsv(input: string): string[][] {
  const s = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export interface ReadTemplateResult {
  tasks: TemplateTask[];
  dropped: Array<{ index: number; reason: string }>;
}

function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  return i ? `${i.path.join('.') || 'task'}: ${i.message}` : 'invalid';
}

function fromRecords(records: unknown[]): ReadTemplateResult {
  if (records.length > MAX_TEMPLATE_TASKS)
    throw new TaskTemplateError(`A template holds at most ${MAX_TEMPLATE_TASKS} tasks`);
  const out: ReadTemplateResult = { tasks: [], dropped: [] };
  records.forEach((raw, index) => {
    // A case file's tasks carry checklist objects; a template carries plain strings.
    const rec =
      raw && typeof raw === 'object' && Array.isArray((raw as { checklist?: unknown }).checklist)
        ? {
            ...(raw as object),
            checklist: ((raw as { checklist: unknown[] }).checklist ?? []).map((c) =>
              c && typeof c === 'object' ? String((c as { text?: unknown }).text ?? '') : c,
            ),
          }
        : raw;
    const parsed = TemplateTaskSchema.safeParse(rec);
    if (parsed.success) out.tasks.push(parsed.data);
    else out.dropped.push({ index, reason: firstIssue(parsed.error) });
  });
  return out;
}

/**
 * Read a task list from text: a `midden.tasks.v1` file, a bare JSON array of tasks, or a CSV
 * with a header row. Column names are matched loosely ("Title", "assigned to", "host").
 */
export function readTaskTemplate(input: string): ReadTemplateResult {
  const trimmed = input.trim();
  if (!trimmed) throw new TaskTemplateError('The file is empty');
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new TaskTemplateError('That file is not valid JSON');
    }
    if (Array.isArray(data)) return fromRecords(data);
    const tasks = (data as { tasks?: unknown }).tasks;
    if (!Array.isArray(tasks))
      throw new TaskTemplateError('No tasks found: expected a "tasks" array');
    return fromRecords(tasks);
  }
  const rows = parseCsv(trimmed);
  const header = rows.shift();
  if (!header) throw new TaskTemplateError('The CSV has no header row');
  const columns = header.map((h) => csvColumn(h));
  if (!columns.includes('title')) throw new TaskTemplateError('The CSV needs a "title" column');
  return fromRecords(
    rows.map((r) => {
      const rec: Record<string, string> = {};
      columns.forEach((c, i) => {
        if (c && r[i] !== undefined && r[i] !== '') rec[c] = r[i]!;
      });
      return rec;
    }),
  );
}

const ALIASES: Record<string, (typeof TASK_CSV_COLUMNS)[number]> = {
  title: 'title',
  task: 'title',
  name: 'title',
  summary: 'title',
  description: 'description',
  details: 'description',
  notes: 'description',
  status: 'status',
  column: 'status',
  priority: 'priority',
  assignees: 'assignees',
  assignee: 'assignees',
  assignedto: 'assignees',
  owner: 'assignees',
  hosts: 'hosts',
  host: 'hosts',
  systems: 'hosts',
  technique: 'technique',
  attack: 'technique',
  tags: 'tags',
  tag: 'tags',
  due: 'due',
  duedate: 'due',
  checklist: 'checklist',
  steps: 'checklist',
};

function csvColumn(h: string): (typeof TASK_CSV_COLUMNS)[number] | null {
  return ALIASES[h.toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

export interface ImportOptions {
  actor: TaskActor;
  now?: string;
  /** Resolve a template's person reference to an assignee id, or null when nobody matches. */
  resolveUser(ref: string): string | null;
  /** Put every imported task in this column instead of the one the template names. */
  status?: TaskStatus | undefined;
  /** Assign these ids to every imported task as well. */
  assignAlso?: readonly string[] | undefined;
}

export interface ImportPlan {
  op: Op;
  ids: string[];
  unresolvedUsers: string[];
  unresolvedHosts: string[];
}

/** Host name (case-insensitive) or any of its addresses. */
export function hostResolver(state: CaseState): (ref: string) => string | null {
  const byName = new Map<string, string>();
  const byIp = new Map<string, string>();
  for (const h of Object.values(state.hosts)) {
    if (h.name && !byName.has(h.name.toLowerCase())) byName.set(h.name.toLowerCase(), h.id);
    for (const ip of hostIps(h.ip)) if (!byIp.has(ip)) byIp.set(ip, h.id);
  }
  return (ref) => byName.get(ref.toLowerCase()) ?? byIp.get(ref.trim()) ?? null;
}

const normalizeDue = (due: string): string => {
  if (!due) return '';
  const t = Date.parse(due);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
};

/** The ops that add a template's tasks to a case, as one batch, each with a fresh id. */
export function planTaskImport(
  state: CaseState,
  tasks: readonly TemplateTask[],
  opts: ImportOptions,
): ImportPlan {
  const now = opts.now ?? new Date().toISOString();
  const findHost = hostResolver(state);
  const unresolvedUsers = new Set<string>();
  const unresolvedHosts = new Set<string>();
  const nextRank = new Map<TaskStatus, number>();
  const ops: Op[] = [];
  const ids: string[] = [];
  for (const t of tasks) {
    const status = opts.status ?? t.status;
    const rank = nextRank.get(status) ?? bottomRank(state, status);
    nextRank.set(status, rank + 1);
    const assignees = new Set(opts.assignAlso ?? []);
    for (const ref of t.assignees) {
      const id = opts.resolveUser(ref);
      if (id) assignees.add(id);
      else unresolvedUsers.add(ref);
    }
    const hostIds = new Set<string>();
    for (const ref of t.hosts) {
      const id = findHost(ref);
      if (id) hostIds.add(id);
      else unresolvedHosts.add(ref);
    }
    const task: Task = {
      id: uid('task'),
      title: t.title,
      description: t.description,
      status,
      priority: t.priority,
      assignees: [...assignees],
      hostIds: [...hostIds],
      eventIds: [],
      technique: t.technique.trim().toUpperCase(),
      tags: [...new Set(t.tags)],
      due: normalizeDue(t.due),
      checklist: t.checklist.map((text) => ({ id: uid('ck'), text, done: false })),
      outcome: '',
      rank,
      createdBy: opts.actor.id,
      createdByName: opts.actor.name,
      createdAt: now,
      completedAt: status === 'done' ? now : '',
    };
    ops.push({ type: 'task.add', task });
    ids.push(task.id);
  }
  return {
    op: { type: 'batch', ops },
    ids,
    unresolvedUsers: [...unresolvedUsers],
    unresolvedHosts: [...unresolvedHosts],
  };
}
