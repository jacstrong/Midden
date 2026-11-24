/**
 * The playbook CSV format: one file shape for import and export, so a team can export a run's
 * state, keep it, and import it again later, or turn a finished run into a reusable playbook.
 *
 *   key,title,description,status,priority,assignees,team,labels,due,blocked_by,checklist,approver,case
 *
 * - `key` is local to the file; `blocked_by` lists other rows' keys. Rows without a key get one.
 * - `assignees`, `labels`, `checklist` and `blocked_by` are `;`-separated (see `splitList`).
 *   A checklist item written `[x] text` is imported already ticked.
 * - `due` is an ISO date or date-time, or relative to the run's start: `+1d`, `+4h`, `+1d12h`.
 * - Export adds read-only columns (`id`, `created`, `completed`, `approval_state`,
 *   `approval_comment`, `comments`) that import ignores.
 *
 * `parsePlaybookCsv` reads the file; `planImport` resolves it against a directory of users,
 * teams and cases and produces the ops. Both run on the server and in the browser's preview.
 */
import { MAX_TASK_BATCH, type TaskOp } from './ops.js';
import { joinList, parseCsv, splitList, unguardCell, writeCsv } from './csv.js';
import { TASK_LIMITS } from './schemas.js';
import {
  STATUS_CATEGORIES,
  TASK_PRIORITIES,
  taskRef,
  type NewTask,
  type StatusCategory,
  type Task,
  type TaskComment,
  type TaskPriority,
  type Workflow,
  type WorkflowStatus,
} from './types.js';

export const PLAYBOOK_COLUMNS = [
  'key',
  'title',
  'description',
  'status',
  'priority',
  'assignees',
  'team',
  'labels',
  'due',
  'blocked_by',
  'checklist',
  'approver',
  'case',
] as const;
export const EXPORT_ONLY_COLUMNS = [
  'id',
  'created',
  'completed',
  'approval_state',
  'approval_comment',
  'comments',
] as const;
type Column = (typeof PLAYBOOK_COLUMNS)[number];

/** Largest file the importer accepts. */
export const MAX_PLAYBOOK_BYTES = 2 * 1024 * 1024;

export type DueSpec = { kind: 'abs'; at: string } | { kind: 'rel'; ms: number };

export interface PlaybookRow {
  line: number;
  key: string;
  title: string;
  description: string;
  status: string;
  priority: TaskPriority;
  assignees: string[];
  team: string;
  labels: string[];
  due: DueSpec | null;
  blockedBy: string[];
  checklist: { text: string; done: boolean }[];
  approver: string;
  case: string;
}

export interface ImportIssue {
  /** 0 for file-level problems. */
  line: number;
  severity: 'error' | 'warning';
  message: string;
}

const UNIT_MS = { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000 } as const;

/** Parse a due cell. Date-only values mean the end of that day, UTC. */
export function parseDue(cell: string): DueSpec | null | 'invalid' {
  const v = cell.trim();
  if (!v) return null;
  const rel = /^\+((?:\d+[wdhm])+)$/i.exec(v);
  if (rel) {
    let ms = 0;
    for (const m of rel[1]!.matchAll(/(\d+)([wdhm])/gi))
      ms += Number(m[1]) * UNIT_MS[m[2]!.toLowerCase() as keyof typeof UNIT_MS];
    return { kind: 'rel', ms };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T23:59:59.999Z`);
    return Number.isNaN(d.getTime()) ? 'invalid' : { kind: 'abs', at: d.toISOString() };
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? 'invalid' : { kind: 'abs', at: d.toISOString() };
  }
  return 'invalid';
}

/** `+1d4h` style offset, rounded to the minute. Negative offsets clamp to `+0m`. */
export function formatRelative(ms: number): string {
  let rest = Math.max(0, Math.round(ms / 60_000)) * 60_000;
  let out = '';
  for (const [u, size] of [
    ['d', UNIT_MS.d],
    ['h', UNIT_MS.h],
    ['m', UNIT_MS.m],
  ] as const) {
    const n = Math.floor(rest / size);
    if (n) out += `${n}${u}`;
    rest -= n * size;
  }
  return `+${out || '0m'}`;
}

export function resolveDue(due: DueSpec | null, startDate: string): string {
  if (!due) return '';
  if (due.kind === 'abs') return due.at;
  const start = new Date(startDate).getTime();
  return Number.isNaN(start) ? '' : new Date(start + due.ms).toISOString();
}

const normHeader = (h: string): string =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

/** Read a playbook CSV into rows, reporting every problem rather than stopping at the first. */
export function parsePlaybookCsv(text: string): { rows: PlaybookRow[]; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  if (text.length > MAX_PLAYBOOK_BYTES) {
    issues.push({ line: 0, severity: 'error', message: 'The file is larger than 2 MB' });
    return { rows: [], issues };
  }
  const csv = parseCsv(text);
  const header = csv[0];
  if (!header) {
    issues.push({ line: 0, severity: 'error', message: 'The file is empty' });
    return { rows: [], issues };
  }
  const index = new Map<string, number>();
  header.cells.forEach((h, i) => {
    const n = normHeader(h);
    if (n) index.set(n, i);
  });
  if (!index.has('title')) {
    issues.push({ line: header.line, severity: 'error', message: 'There is no "title" column' });
    return { rows: [], issues };
  }
  const known = new Set<string>([...PLAYBOOK_COLUMNS, ...EXPORT_ONLY_COLUMNS]);
  for (const h of index.keys())
    if (!known.has(h))
      issues.push({
        line: header.line,
        severity: 'warning',
        message: `Ignoring unknown column "${h}"`,
      });

  const body = csv.slice(1).filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (body.length > MAX_TASK_BATCH) {
    issues.push({ line: 0, severity: 'error', message: `More than ${MAX_TASK_BATCH} rows` });
    return { rows: [], issues };
  }

  const get = (r: { cells: string[] }, c: Column): string => {
    const i = index.get(c);
    return i === undefined ? '' : unguardCell(r.cells[i] ?? '').trim();
  };
  const rows: PlaybookRow[] = [];
  const keys = new Map<string, number>();
  for (const r of body) {
    const err = (message: string): void => {
      issues.push({ line: r.line, severity: 'error', message });
    };
    const title = get(r, 'title');
    if (!title) err('Title is empty');
    else if (title.length > TASK_LIMITS.title)
      err(`Title is longer than ${TASK_LIMITS.title} characters`);
    const key = get(r, 'key') || `row${r.line}`;
    if (keys.has(key)) err(`Key "${key}" is also used on line ${keys.get(key)}`);
    else keys.set(key, r.line);
    const pr = get(r, 'priority').toLowerCase();
    let priority: TaskPriority = 'medium';
    if (pr) {
      if ((TASK_PRIORITIES as readonly string[]).includes(pr)) priority = pr as TaskPriority;
      else err(`Priority "${pr}" is not one of ${TASK_PRIORITIES.join(', ')}`);
    }
    const dueCell = get(r, 'due');
    const due = parseDue(dueCell);
    if (due === 'invalid') err(`Due "${dueCell}" is not a date or an offset like +2d`);
    const description = get(r, 'description');
    if (description.length > TASK_LIMITS.description) err('Description is too long');
    const labels = splitList(get(r, 'labels'));
    if (labels.length > TASK_LIMITS.labels) err(`More than ${TASK_LIMITS.labels} labels`);
    const checklist = splitList(get(r, 'checklist')).map((t) => {
      const m = /^\[( |x)\]\s*(.*)$/i.exec(t);
      return m
        ? { text: m[2]!.trim(), done: m[1]!.toLowerCase() === 'x' }
        : { text: t, done: false };
    });
    if (checklist.length > TASK_LIMITS.checklistItems) err('Too many checklist items');
    rows.push({
      line: r.line,
      key,
      title,
      description,
      status: get(r, 'status'),
      priority,
      assignees: splitList(get(r, 'assignees')),
      team: get(r, 'team'),
      labels,
      due: due === 'invalid' ? null : due,
      blockedBy: splitList(get(r, 'blocked_by')),
      checklist: checklist.filter((c) => c.text),
      approver: get(r, 'approver'),
      case: get(r, 'case'),
    });
  }

  for (const row of rows)
    for (const b of row.blockedBy) {
      if (b === row.key)
        issues.push({ line: row.line, severity: 'error', message: 'A task cannot block itself' });
      else if (!keys.has(b))
        issues.push({
          line: row.line,
          severity: 'error',
          message: `Blocked by unknown key "${b}"`,
        });
    }
  const cycle = findCycle(rows);
  if (cycle)
    issues.push({
      line: keys.get(cycle[0]!) ?? 0,
      severity: 'error',
      message: `Dependency cycle: ${cycle.join(' → ')}`,
    });
  return { rows, issues };
}

function findCycle(rows: PlaybookRow[]): string[] | null {
  // First row wins for a duplicated key (already an error), so a later row can't hide a cycle.
  const deps = new Map<string, string[]>();
  for (const r of rows) if (!deps.has(r.key)) deps.set(r.key, r.blockedBy);
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (k: string): string[] | null => {
    const s = state.get(k);
    if (s === 2) return null;
    if (s === 1) return [...path.slice(path.indexOf(k)), k];
    state.set(k, 1);
    path.push(k);
    for (const d of deps.get(k) ?? []) {
      if (!deps.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    path.pop();
    state.set(k, 2);
    return null;
  };
  for (const r of rows) {
    const c = visit(r.key);
    if (c) return c;
  }
  return null;
}

// ---- resolution -----------------------------------------------------------------------------

export interface DirectoryUser {
  id: string;
  username: string;
  displayName: string;
}
export interface DirectoryTeam {
  id: string;
  name: string;
}
export interface DirectoryCase {
  id: string;
  name: string;
  number: string;
}
/** Who and what an import can refer to, as visible to the person importing. */
export interface ImportDirectory {
  users: DirectoryUser[];
  teams: DirectoryTeam[];
  cases: DirectoryCase[];
}

const CATEGORY_ALIASES: Record<string, StatusCategory> = {
  'to do': 'todo',
  'in progress': 'in_progress',
  doing: 'in_progress',
  canceled: 'cancelled',
};

/** Match a status cell to a workflow status by name, id or category. */
export function matchStatus(wf: Workflow, cell: string): WorkflowStatus | undefined {
  const v = cell.trim().toLowerCase();
  if (!v) return wf.statuses.find((s) => s.category === 'todo') ?? wf.statuses[0];
  const byName = wf.statuses.find((s) => s.name.toLowerCase() === v || s.id.toLowerCase() === v);
  if (byName) return byName;
  const cat =
    CATEGORY_ALIASES[v] ??
    (STATUS_CATEGORIES as readonly string[]).find((c) => c === v.replace(/\s+/g, '_'));
  return cat ? wf.statuses.find((s) => s.category === cat) : undefined;
}

export interface ImportPlanOptions {
  directory: ImportDirectory;
  /** The workflow of the run the tasks go into. */
  workflow: Workflow;
  runId: string;
  /** Relative due dates count from here. */
  startDate: string;
  /** Team for rows without one (usually the run's team). */
  defaultTeamId: string;
  newId: (prefix: string) => string;
}

export interface ImportPlan {
  ops: TaskOp[];
  /** Key → new task id. */
  ids: Map<string, string>;
  issues: ImportIssue[];
  /** Status names not in the workflow, so the UI can offer to add them. */
  unknownStatuses: string[];
}

/**
 * Turn parsed rows into ops: every `task.add` first, then dependencies, approvals and ticked
 * checklist items, so the whole import can be one batch that undoes in one step.
 */
export function planImport(rows: PlaybookRow[], o: ImportPlanOptions): ImportPlan {
  const issues: ImportIssue[] = [];
  const unknownStatuses = new Set<string>();
  const users = new Map(o.directory.users.map((u) => [u.username.toLowerCase(), u]));
  const teams = new Map(o.directory.teams.map((t) => [t.name.toLowerCase(), t]));
  const teamIds = new Set(o.directory.teams.map((t) => t.id));
  const findCase = (v: string): DirectoryCase | undefined =>
    o.directory.cases.find((c) => c.id === v || (c.number && c.number === v) || c.name === v);
  const ids = new Map(rows.map((r) => [r.key, o.newId('tk')]));

  const adds: TaskOp[] = [];
  const after: TaskOp[] = [];
  for (const r of rows) {
    const err = (message: string): void => {
      issues.push({ line: r.line, severity: 'error', message });
    };
    const id = ids.get(r.key)!;
    const status = matchStatus(o.workflow, r.status);
    if (!status) {
      unknownStatuses.add(r.status);
      err(`Status "${r.status}" is not in workflow "${o.workflow.name}"`);
    }
    const assignees: string[] = [];
    for (const name of r.assignees) {
      const u = users.get(name.toLowerCase());
      if (u) assignees.push(u.id);
      else err(`Unknown user "${name}"`);
    }
    let teamId = o.defaultTeamId;
    if (r.team) {
      const t =
        teams.get(r.team.toLowerCase()) ?? (teamIds.has(r.team) ? { id: r.team } : undefined);
      if (t) teamId = t.id;
      else err(`Unknown team "${r.team}"`);
    }
    let caseId = '';
    if (r.case) {
      const c = findCase(r.case);
      if (c) caseId = c.id;
      else err(`Unknown case "${r.case}"`);
    }
    let approverId = '';
    if (r.approver) {
      const u = users.get(r.approver.toLowerCase());
      if (u) approverId = u.id;
      else err(`Unknown approver "${r.approver}"`);
    }
    const checklist = r.checklist.map((c) => ({ id: o.newId('ci'), text: c.text, done: c.done }));
    const task: NewTask = {
      id,
      title: r.title,
      description: r.description,
      statusId: status?.id ?? o.workflow.statuses[0]!.id,
      priority: r.priority,
      runId: o.runId,
      labels: r.labels,
      dueAt: resolveDue(r.due, o.startDate),
      caseId,
      hostId: '',
      eventId: '',
      assignees,
      teamId,
      checklist: checklist.map(({ id: cid, text }) => ({ id: cid, text })),
    };
    adds.push({ type: 'task.add', task });
    for (const b of r.blockedBy) {
      const bid = ids.get(b);
      if (bid) after.push({ type: 'dep.add', taskId: id, blockedById: bid });
    }
    for (const c of checklist)
      if (c.done)
        after.push({ type: 'checklist.set', taskId: id, itemId: c.id, patch: { done: true } });
    if (approverId && status?.category === 'done')
      // A decision can only be made in person, so it can't be imported, and a done task may not
      // wait on one. Keep the task's state; drop the approver and say so.
      issues.push({
        line: r.line,
        severity: 'warning',
        message: `Imported without approver "${r.approver}": the task is already done, and approvals can't be carried over`,
      });
    else if (approverId) after.push({ type: 'approval.set', taskId: id, approverId });
  }
  return { ops: [...adds, ...after], ids, issues, unknownStatuses: [...unknownStatuses] };
}

// ---- export ---------------------------------------------------------------------------------

export interface ExportOptions {
  /** Users, teams and cases by id, for names. */
  users: Map<string, { username: string; displayName: string }>;
  teams: Map<string, { name: string }>;
  cases: Map<string, { name: string; number: string }>;
  /** Status lookup for a task (its run's workflow). */
  statusName: (task: Task) => string;
  /** Write due dates relative to this start (to make a playbook); absolute when absent. */
  relativeTo?: string | undefined;
  /** Comments by task id; included as a column when given. */
  comments?: Map<string, TaskComment[]> | undefined;
  /** Add the read-only state columns (on by default). */
  stateColumns?: boolean | undefined;
}

/** Write tasks in the playbook format. Keys are task numbers, so dependencies survive. */
export function exportTasksCsv(tasks: Task[], o: ExportOptions): string {
  const inSet = new Map(tasks.map((t) => [t.id, t]));
  const stateCols = o.stateColumns ?? true;
  const header: string[] = [
    ...PLAYBOOK_COLUMNS,
    ...(stateCols ? EXPORT_ONLY_COLUMNS.filter((c) => c !== 'comments' || o.comments) : []),
  ];
  const userName = (id: string): string => o.users.get(id)?.username ?? id;
  const sorted = [...tasks].sort((a, b) => a.num - b.num);
  const rows = sorted.map((t) => {
    const due = !t.dueAt
      ? ''
      : o.relativeTo
        ? formatRelative(new Date(t.dueAt).getTime() - new Date(o.relativeTo).getTime())
        : t.dueAt;
    const c = t.caseId ? o.cases.get(t.caseId) : undefined;
    const base: Record<Column, string> = {
      key: taskRef(t.num),
      title: t.title,
      description: t.description,
      status: o.statusName(t),
      priority: t.priority,
      assignees: joinList(t.assignees.map(userName)),
      team: t.teamId ? (o.teams.get(t.teamId)?.name ?? t.teamId) : '',
      labels: joinList(t.labels),
      due,
      blocked_by: joinList(
        t.blockedBy.filter((b) => inSet.has(b)).map((b) => taskRef(inSet.get(b)!.num)),
      ),
      checklist: joinList(t.checklist.map((i) => (i.done ? `[x] ${i.text}` : i.text))),
      approver: t.approval ? userName(t.approval.approverId) : '',
      case: t.caseId ? c?.number || t.caseId : '',
    };
    const out = PLAYBOOK_COLUMNS.map((k) => base[k]);
    if (stateCols) {
      out.push(
        taskRef(t.num),
        t.createdAt,
        t.doneAt,
        t.approval?.state ?? '',
        t.approval?.comment ?? '',
      );
      if (o.comments)
        out.push(
          (o.comments.get(t.id) ?? [])
            .filter((cm) => !cm.deletedAt)
            .map(
              (cm) =>
                `${o.users.get(cm.authorId)?.displayName ?? cm.authorId} (${cm.createdAt}): ${cm.body}`,
            )
            .join('\n\n'),
        );
    }
    return out;
  });
  return writeCsv([header, ...rows]);
}
