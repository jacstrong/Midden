/**
 * Saved task views: a filter, a layout (board or table), a grouping, a sort and the fields a
 * card shows. Pure functions, shared by the web UI (which renders them) and the server (which
 * validates saved ones). `dropOp` says what dragging a card into a column means for each
 * grouping, so the board needs no per-field logic of its own.
 */
import { z } from 'zod';
import { taskRef, STATUS_CATEGORIES, TASK_PRIORITIES } from './types.js';
import { StatusCategorySchema, TaskPrioritySchema } from './schemas.js';
import type { StatusCategory, Task, TaskPriority, TaskState, WorkflowStatus } from './types.js';
import type { TaskOp } from './ops.js';
import { categoryOf, firstStatusIn, statusOf, workflowIdFor, workflowOf } from './reducer.js';

export const TASK_GROUP_BYS = [
  'status',
  'category',
  'assignee',
  'team',
  'priority',
  'label',
  'run',
  'case',
  'none',
] as const;
export type TaskGroupBy = (typeof TASK_GROUP_BYS)[number];

export const TASK_SORTS = ['priority', 'due', 'num', 'updated', 'title'] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export const CARD_FIELDS = [
  'assignees',
  'team',
  'priority',
  'due',
  'labels',
  'case',
  'run',
  'checklist',
  'approval',
  'blocked',
] as const;
export type CardField = (typeof CARD_FIELDS)[number];

export interface TaskFilter {
  /** Assigned to the viewer. */
  mine?: boolean | undefined;
  following?: boolean | undefined;
  /** In a team the viewer is on (its queue and everything assigned in it). */
  myTeams?: boolean | undefined;
  /** No one assigned yet: the queue. */
  unassigned?: boolean | undefined;
  assignees?: string[] | undefined;
  teams?: string[] | undefined;
  runs?: string[] | undefined;
  cases?: string[] | undefined;
  categories?: StatusCategory[] | undefined;
  priorities?: TaskPriority[] | undefined;
  labels?: string[] | undefined;
  overdue?: boolean | undefined;
  /** Waiting on the viewer's approval. */
  awaitingMyApproval?: boolean | undefined;
  /** Matches title, description, labels or `T-12`. */
  text?: string | undefined;
}

export interface TaskViewConfig {
  filter: TaskFilter;
  layout: 'board' | 'table';
  groupBy: TaskGroupBy;
  /** Rows across the board; 'none' for a single row. */
  swimlanes: TaskGroupBy;
  sort: TaskSort;
  fields: CardField[];
  /** Show closed (done, cancelled) tasks. */
  showClosed: boolean;
}

export interface TaskView {
  id: string;
  name: string;
  /** '' for built-in views. */
  ownerId: string;
  /** Shared with this team ('' for personal). */
  teamId: string;
  builtIn: boolean;
  config: TaskViewConfig;
}

const DEFAULT_FIELDS: CardField[] = [
  'assignees',
  'priority',
  'due',
  'labels',
  'checklist',
  'approval',
  'blocked',
];

export const defaultViewConfig = (over: Partial<TaskViewConfig> = {}): TaskViewConfig => ({
  filter: {},
  layout: 'board',
  groupBy: 'status',
  swimlanes: 'none',
  sort: 'priority',
  fields: DEFAULT_FIELDS,
  showClosed: true,
  ...over,
});

export const BUILTIN_VIEWS: TaskView[] = [
  {
    id: 'mine',
    name: 'My tasks',
    ownerId: '',
    teamId: '',
    builtIn: true,
    config: defaultViewConfig({ filter: { mine: true } }),
  },
  {
    id: 'queues',
    name: 'My teams’ queues',
    ownerId: '',
    teamId: '',
    builtIn: true,
    config: defaultViewConfig({
      filter: { myTeams: true },
      groupBy: 'assignee',
      swimlanes: 'team',
      showClosed: false,
    }),
  },
  {
    id: 'following',
    name: 'Following',
    ownerId: '',
    teamId: '',
    builtIn: true,
    config: defaultViewConfig({ filter: { following: true } }),
  },
  {
    id: 'approvals',
    name: 'Awaiting my approval',
    ownerId: '',
    teamId: '',
    builtIn: true,
    config: defaultViewConfig({
      filter: { awaitingMyApproval: true },
      layout: 'table',
      sort: 'due',
    }),
  },
  {
    id: 'everyone',
    name: 'Everyone’s tasks',
    ownerId: '',
    teamId: '',
    builtIn: true,
    config: defaultViewConfig({ groupBy: 'assignee', showClosed: false }),
  },
  {
    id: 'all',
    name: 'All tasks',
    ownerId: '',
    teamId: '',
    builtIn: true,
    config: defaultViewConfig({ layout: 'table', sort: 'num' }),
  },
];

/* ---- schema (for saved views) ---- */

const ids = z.array(z.string().max(64)).max(200).optional();
export const TaskFilterSchema = z
  .object({
    mine: z.boolean().optional(),
    following: z.boolean().optional(),
    myTeams: z.boolean().optional(),
    unassigned: z.boolean().optional(),
    assignees: ids,
    teams: ids,
    runs: ids,
    cases: ids,
    categories: z.array(StatusCategorySchema).optional(),
    priorities: z.array(TaskPrioritySchema).optional(),
    labels: z.array(z.string().max(64)).max(50).optional(),
    overdue: z.boolean().optional(),
    awaitingMyApproval: z.boolean().optional(),
    text: z.string().max(200).optional(),
  })
  .strict();

export const TaskViewConfigSchema = z
  .object({
    filter: TaskFilterSchema,
    layout: z.enum(['board', 'table']),
    groupBy: z.enum(TASK_GROUP_BYS),
    swimlanes: z.enum(TASK_GROUP_BYS),
    sort: z.enum(TASK_SORTS),
    fields: z.array(z.enum(CARD_FIELDS)).max(CARD_FIELDS.length),
    showClosed: z.boolean(),
  })
  .strict();

/* ---- filtering ---- */

export interface ViewContext {
  me: string;
  /** Teams the viewer is on. */
  myTeams: ReadonlySet<string>;
  now: string;
}

export function isOverdue(state: TaskState, t: Task, now: string): boolean {
  if (!t.dueAt || t.dueAt >= now) return false;
  const c = categoryOf(state, t);
  return c !== 'done' && c !== 'cancelled';
}

export function matchesFilter(state: TaskState, t: Task, f: TaskFilter, ctx: ViewContext): boolean {
  if (f.mine && !t.assignees.includes(ctx.me)) return false;
  if (f.following && !t.followers.includes(ctx.me)) return false;
  if (f.myTeams && !(t.teamId && ctx.myTeams.has(t.teamId))) return false;
  if (f.unassigned && t.assignees.length) return false;
  if (f.assignees?.length && !f.assignees.some((u) => t.assignees.includes(u))) return false;
  if (f.teams?.length && !f.teams.includes(t.teamId)) return false;
  if (f.runs?.length && !f.runs.includes(t.runId)) return false;
  if (f.cases?.length && !f.cases.includes(t.caseId)) return false;
  if (f.categories?.length && !f.categories.includes(categoryOf(state, t))) return false;
  if (f.priorities?.length && !f.priorities.includes(t.priority)) return false;
  if (f.labels?.length && !f.labels.some((l) => t.labels.includes(l))) return false;
  if (f.overdue && !isOverdue(state, t, ctx.now)) return false;
  if (
    f.awaitingMyApproval &&
    !(t.approval && t.approval.approverId === ctx.me && t.approval.state === 'pending')
  )
    return false;
  const q = f.text?.trim().toLowerCase();
  if (q) {
    const hay = [taskRef(t.num), t.title, t.description, ...t.labels].join('\n').toLowerCase();
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

export function filterTasks(
  state: TaskState,
  cfg: Pick<TaskViewConfig, 'filter' | 'showClosed'>,
  ctx: ViewContext,
): Task[] {
  return Object.values(state.tasks).filter((t) => {
    if (t.archived) return false;
    if (!cfg.showClosed) {
      const c = categoryOf(state, t);
      if (c === 'done' || c === 'cancelled') return false;
    }
    return matchesFilter(state, t, cfg.filter, ctx);
  });
}

/* ---- sorting ---- */

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

export function sortTasks(tasks: Task[], sort: TaskSort): Task[] {
  const by: Record<TaskSort, (a: Task, b: Task) => number> = {
    priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || dueCmp(a, b),
    due: (a, b) => dueCmp(a, b) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
    num: () => 0,
    updated: (a, b) => b.statusAt.localeCompare(a.statusAt),
    title: (a, b) => a.title.localeCompare(b.title),
  };
  return [...tasks].sort((a, b) => by[sort](a, b) || a.num - b.num);
}

function dueCmp(a: Task, b: Task): number {
  if (a.dueAt === b.dueAt) return 0;
  if (!a.dueAt) return 1;
  if (!b.dueAt) return -1;
  return a.dueAt.localeCompare(b.dueAt);
}

/* ---- grouping ---- */

/** Names the board shows for ids it groups by. */
export interface ViewNames {
  user(id: string): string;
  team(id: string): string;
  caseName(id: string): string;
}

export interface TaskGroup {
  /** The value this column stands for ('' for none). */
  key: string;
  label: string;
  color?: string | undefined;
  category?: StatusCategory | undefined;
  wipLimit?: number | undefined;
  tasks: Task[];
}

const CATEGORY_LABEL: Record<StatusCategory, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};
export const categoryLabel = (c: StatusCategory): string => CATEGORY_LABEL[c];

/**
 * Status columns need one workflow. When every task uses the same one (a single run, or no
 * runs), the board shows its statuses; when they span workflows it falls back to categories.
 */
export function effectiveGroupBy(state: TaskState, tasks: Task[], g: TaskGroupBy): TaskGroupBy {
  if (g !== 'status') return g;
  const wfs = new Set(tasks.map((t) => workflowIdFor(state, t.runId)));
  return wfs.size <= 1 ? 'status' : 'category';
}

/** The workflow a status board shows: the tasks' own, or the default when there are none. */
function boardStatuses(state: TaskState, tasks: Task[], runFilter?: string[]): WorkflowStatus[] {
  const wfId =
    tasks.length > 0
      ? workflowIdFor(state, tasks[0]!.runId)
      : runFilter?.length === 1
        ? workflowIdFor(state, runFilter[0]!)
        : state.defaultWorkflowId;
  return state.workflows[wfId]?.statuses ?? [];
}

export function groupTasks(
  state: TaskState,
  tasks: Task[],
  groupBy: TaskGroupBy,
  names: ViewNames,
  opts: { runFilter?: string[] | undefined; keepEmpty?: string[] | undefined } = {},
): TaskGroup[] {
  const g = effectiveGroupBy(state, tasks, groupBy);
  const groups = new Map<string, TaskGroup>();
  const ensure = (key: string, label: string, extra: Partial<TaskGroup> = {}): TaskGroup => {
    let grp = groups.get(key);
    if (!grp) {
      grp = { key, label, tasks: [], ...extra };
      groups.set(key, grp);
    }
    return grp;
  };

  // fixed columns first, so empty ones still show (somewhere to drop a card)
  if (g === 'status')
    for (const st of boardStatuses(state, tasks, opts.runFilter))
      ensure(st.id, st.name, {
        color: st.color,
        category: st.category,
        wipLimit: st.wipLimit ?? undefined,
      });
  if (g === 'category')
    for (const c of STATUS_CATEGORIES) ensure(c, CATEGORY_LABEL[c], { category: c });
  if (g === 'priority')
    for (const p of TASK_PRIORITIES) ensure(p, p[0]!.toUpperCase() + p.slice(1));
  if (g === 'assignee') ensure('', 'Unassigned');
  for (const k of opts.keepEmpty ?? []) ensure(k, labelFor(state, g, k, names));

  for (const t of tasks) {
    for (const key of keysOf(state, t, g))
      ensure(key, labelFor(state, g, key, names)).tasks.push(t);
  }

  const out = [...groups.values()];
  if (g === 'assignee' || g === 'team' || g === 'label' || g === 'run' || g === 'case') {
    // named groups alphabetically, "none" last
    out.sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : a.label.localeCompare(b.label)));
    if (g === 'assignee') {
      // unassigned (the queue) first: that's where work is picked up
      const i = out.findIndex((x) => x.key === '');
      if (i > 0) out.unshift(...out.splice(i, 1));
    }
  }
  if (g === 'category') return out.filter((x) => x.tasks.length || x.category !== 'cancelled');
  return out;
}

export function keysOf(state: TaskState, t: Task, g: TaskGroupBy): string[] {
  switch (g) {
    case 'status':
      return [t.statusId];
    case 'category':
      return [categoryOf(state, t)];
    case 'assignee':
      return t.assignees.length ? t.assignees : [''];
    case 'team':
      return [t.teamId];
    case 'priority':
      return [t.priority];
    case 'label':
      return t.labels.length ? t.labels : [''];
    case 'run':
      return [t.runId];
    case 'case':
      return [t.caseId];
    case 'none':
      return [''];
  }
}

function labelFor(state: TaskState, g: TaskGroupBy, key: string, n: ViewNames): string {
  switch (g) {
    case 'assignee':
      return key ? n.user(key) : 'Unassigned';
    case 'team':
      return key ? n.team(key) : 'No team';
    case 'label':
      return key || 'No label';
    case 'run':
      return key ? (state.runs[key]?.name ?? 'Unknown run') : 'No run';
    case 'case':
      return key ? n.caseName(key) : 'No case';
    case 'none':
      return 'Tasks';
    default:
      return key;
  }
}

/* ---- dropping a card ---- */

/**
 * The op that moves `t` from column `from` to column `to` of a board grouped by `g`, or null
 * when the move means nothing (same column) or can't be expressed (no such status).
 */
export function dropOp(
  state: TaskState,
  t: Task,
  g: TaskGroupBy,
  from: string,
  to: string,
): TaskOp | null {
  if (from === to) return null;
  switch (g) {
    case 'status':
      return statusOf(state, { runId: t.runId, statusId: to })
        ? { type: 'task.set', id: t.id, patch: { statusId: to } }
        : null;
    case 'category': {
      const wf = workflowOf(state, t);
      const st = wf && firstStatusIn(wf, to as StatusCategory);
      return st ? { type: 'task.set', id: t.id, patch: { statusId: st.id } } : null;
    }
    case 'assignee': {
      const ops: TaskOp[] = [];
      if (from) ops.push({ type: 'task.assign', ids: [t.id], mode: 'remove', users: [from] });
      if (to) ops.push({ type: 'task.assign', ids: [t.id], mode: 'add', users: [to] });
      // dropping onto "Unassigned" empties the task: back to the queue
      if (!to) return { type: 'task.assign', ids: [t.id], mode: 'set', users: [] };
      return ops.length === 1 ? ops[0]! : { type: 'batch', ops };
    }
    case 'team':
      return { type: 'task.assign', ids: [t.id], mode: 'add', users: [], teamId: to };
    case 'priority':
      return { type: 'task.set', id: t.id, patch: { priority: to as TaskPriority } };
    case 'label': {
      const labels = t.labels.filter((l) => l !== from);
      if (to && !labels.includes(to)) labels.push(to);
      return { type: 'task.set', id: t.id, patch: { labels } };
    }
    case 'run':
      return moveToRunOp(state, t, to);
    case 'case':
      return { type: 'task.set', id: t.id, patch: { caseId: to } };
    case 'none':
      return null;
  }
}

/** Moving to another run may change the workflow: keep the task in the same category. */
export function moveToRunOp(state: TaskState, t: Task, runId: string): TaskOp | null {
  const wf = state.workflows[workflowIdFor(state, runId)];
  if (!wf) return null;
  const keep = wf.statuses.some((s) => s.id === t.statusId)
    ? t.statusId
    : (firstStatusIn(wf, categoryOf(state, t))?.id ?? wf.statuses[0]?.id);
  if (!keep) return null;
  return {
    type: 'task.set',
    id: t.id,
    patch: keep === t.statusId ? { runId } : { runId, statusId: keep },
  };
}
