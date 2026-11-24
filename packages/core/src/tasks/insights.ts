/**
 * Insights for leads: what is open, who is carrying it, how fast work gets done, what is
 * stuck, and how a run is burning down. Pure: the server picks the tasks the viewer may see
 * and reads their status history; this only counts.
 */
import { categoryOf, isClosedCategory } from './reducer.js';
import { STATUS_CATEGORIES, type StatusCategory, type Task, type TaskState } from './types.js';

export interface InsightsTaskRef {
  id: string;
  num: number;
  title: string;
}

export interface DurationStats {
  count: number;
  medianSec: number | null;
  p90Sec: number | null;
}

export interface TaskInsights {
  now: string;
  /** The window throughput, cycle time and lead time are counted over. */
  from: string;
  to: string;
  open: {
    total: number;
    /** Every task that isn't archived, open or not. */
    byCategory: Record<StatusCategory, number>;
    overdue: number;
    /** Open, with no one assigned and no team queue. */
    unassigned: number;
  };
  /** Open tasks waiting in a team's queue (a team, no assignees). */
  queues: { teamId: string; open: number; oldestAt: string }[];
  /** Open work per assignee, most loaded first. */
  people: { userId: string; open: number; inProgress: number; blocked: number; overdue: number }[];
  /** One entry per week (Monday, UTC) in the window. */
  throughput: { week: string; created: number; done: number }[];
  /** First in progress → done, for tasks done in the window. */
  cycle: DurationStats;
  /** Created → done, for tasks done in the window. */
  lead: DurationStats;
  /** Open tasks that have sat in one status longest (backlog left out). */
  stuck: (InsightsTaskRef & {
    statusId: string;
    category: StatusCategory;
    since: string;
    assignees: string[];
  })[];
  /** Approvals still waiting on the approver, oldest first. */
  approvals: (InsightsTaskRef & { approverId: string; since: string })[];
  /** Open and total tasks at the end of each day of a run; null unless one run is asked for. */
  burndown: { runId: string; points: { date: string; total: number; open: number }[] } | null;
}

/** One change of status, as `task_transitions` records it. */
export interface TaskTransitionRow {
  taskId: string;
  toCategory: StatusCategory;
  at: string;
}

export const INSIGHTS_STUCK_LIMIT = 10;
/** Burndowns stop after this many days, so a run left open for years stays cheap. */
export const BURNDOWN_MAX_DAYS = 180;

const DAY = 86_400_000;

/** Midnight UTC on the Monday of the week holding `d`. */
export function weekStart(d: Date): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY);
}

/** Nearest-rank percentile of sorted numbers. */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

function stats(values: number[]): DurationStats {
  const s = values.filter((v) => v >= 0).sort((a, b) => a - b);
  return { count: s.length, medianSec: percentile(s, 0.5), p90Sec: percentile(s, 0.9) };
}

const ref = (t: Task): InsightsTaskRef => ({ id: t.id, num: t.num, title: t.title });

export function computeInsights(
  state: TaskState,
  tasks: readonly Task[],
  transitions: readonly TaskTransitionRow[],
  opts: { now: Date; from: Date; to: Date; runId?: string },
): TaskInsights {
  const now = opts.now.toISOString();
  const from = opts.from.toISOString();
  const to = opts.to.toISOString();
  const byCategory = Object.fromEntries(STATUS_CATEGORIES.map((c) => [c, 0])) as Record<
    StatusCategory,
    number
  >;
  const queues = new Map<string, { open: number; oldestAt: string }>();
  const people = new Map<
    string,
    { open: number; inProgress: number; blocked: number; overdue: number }
  >();
  let open = 0;
  let overdue = 0;
  let unassigned = 0;
  const stuck: TaskInsights['stuck'] = [];
  const approvals: TaskInsights['approvals'] = [];

  for (const t of tasks) {
    if (t.archived) continue;
    const cat = categoryOf(state, t);
    byCategory[cat]++;
    if (t.approval?.approverId && t.approval.state === 'pending' && cat !== 'cancelled')
      approvals.push({
        ...ref(t),
        approverId: t.approval.approverId,
        since: t.approval.requestedAt || t.createdAt,
      });
    if (isClosedCategory(cat)) continue;
    open++;
    const late = !!t.dueAt && t.dueAt < now;
    if (late) overdue++;
    if (t.assignees.length === 0) {
      if (t.teamId) {
        const q = queues.get(t.teamId) ?? { open: 0, oldestAt: t.statusAt };
        q.open++;
        if (t.statusAt < q.oldestAt) q.oldestAt = t.statusAt;
        queues.set(t.teamId, q);
      } else unassigned++;
    }
    for (const u of t.assignees) {
      const p = people.get(u) ?? { open: 0, inProgress: 0, blocked: 0, overdue: 0 };
      p.open++;
      if (cat === 'in_progress') p.inProgress++;
      if (cat === 'blocked') p.blocked++;
      if (late) p.overdue++;
      people.set(u, p);
    }
    if (cat !== 'backlog')
      stuck.push({
        ...ref(t),
        statusId: t.statusId,
        category: cat,
        since: t.statusAt,
        assignees: t.assignees,
      });
  }

  // When each task first started, for cycle time.
  const started = new Map<string, string>();
  for (const tr of transitions)
    if (tr.toCategory === 'in_progress') {
      const s = started.get(tr.taskId);
      if (!s || tr.at < s) started.set(tr.taskId, tr.at);
    }

  // Throughput, cycle and lead over the window.
  const weeks: TaskInsights['throughput'] = [];
  const weekIndex = new Map<string, number>();
  for (let w = weekStart(opts.from); w < opts.to; w = new Date(w.getTime() + 7 * DAY)) {
    const key = w.toISOString().slice(0, 10);
    weekIndex.set(key, weeks.length);
    weeks.push({ week: key, created: 0, done: 0 });
  }
  const bucket = (iso: string): (typeof weeks)[number] | undefined => {
    const i = weekIndex.get(weekStart(new Date(iso)).toISOString().slice(0, 10));
    return i === undefined ? undefined : weeks[i];
  };
  const cycle: number[] = [];
  const lead: number[] = [];
  for (const t of tasks) {
    if (t.createdAt >= from && t.createdAt < to) {
      const b = bucket(t.createdAt);
      if (b) b.created++;
    }
    if (!t.doneAt || t.doneAt < from || t.doneAt >= to) continue;
    if (categoryOf(state, t) !== 'done') continue;
    const b = bucket(t.doneAt);
    if (b) b.done++;
    const done = Date.parse(t.doneAt);
    lead.push((done - Date.parse(t.createdAt)) / 1000);
    const s = started.get(t.id);
    if (s && s <= t.doneAt) cycle.push((done - Date.parse(s)) / 1000);
  }

  stuck.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.num - b.num));
  approvals.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.num - b.num));

  return {
    now,
    from,
    to,
    open: { total: open, byCategory, overdue, unassigned },
    queues: [...queues]
      .map(([teamId, q]) => ({ teamId, ...q }))
      .sort((a, b) => b.open - a.open || a.oldestAt.localeCompare(b.oldestAt)),
    people: [...people]
      .map(([userId, p]) => ({ userId, ...p }))
      .sort((a, b) => b.open - a.open || b.overdue - a.overdue || a.userId.localeCompare(b.userId)),
    throughput: weeks,
    cycle: stats(cycle),
    lead: stats(lead),
    stuck: stuck.slice(0, INSIGHTS_STUCK_LIMIT),
    approvals,
    burndown: opts.runId ? burndown(state, opts.runId, tasks, transitions, opts.now) : null,
  };
}

/**
 * For each day of a run, how many of its tasks existed and how many of those were still open
 * at the end of the day, replayed from the status history.
 */
function burndown(
  state: TaskState,
  runId: string,
  tasks: readonly Task[],
  transitions: readonly TaskTransitionRow[],
  now: Date,
): NonNullable<TaskInsights['burndown']> {
  const run = state.runs[runId];
  const mine = tasks.filter((t) => t.runId === runId);
  const ids = new Set(mine.map((t) => t.id));
  const history = new Map<string, TaskTransitionRow[]>();
  for (const tr of transitions) {
    if (!ids.has(tr.taskId)) continue;
    const list = history.get(tr.taskId) ?? [];
    list.push(tr);
    history.set(tr.taskId, list);
  }
  for (const list of history.values()) list.sort((a, b) => a.at.localeCompare(b.at));

  const firstCreated = mine.reduce<string>((m, t) => (!m || t.createdAt < m ? t.createdAt : m), '');
  const startIso = [run?.startDate, firstCreated].filter(Boolean).sort()[0];
  if (!startIso) return { runId, points: [] };
  const endMs = Math.min(
    now.getTime(),
    run?.closed && run.closedAt ? Date.parse(run.closedAt) : Infinity,
  );
  const start = new Date(startIso);
  let day = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const points: { date: string; total: number; open: number }[] = [];
  for (let n = 0; day <= endMs && n < BURNDOWN_MAX_DAYS; n++, day += DAY) {
    const cutoff = new Date(Math.min(day + DAY, endMs + 1)).toISOString();
    let total = 0;
    let openCount = 0;
    for (const t of mine) {
      if (t.createdAt >= cutoff) continue;
      total++;
      // The last status change before the cutoff says where the task stood.
      const list = history.get(t.id);
      let cat: StatusCategory | null = null;
      if (list)
        for (const tr of list) {
          if (tr.at >= cutoff) break;
          cat = tr.toCategory;
        }
      if (cat === null) cat = categoryOf(state, t);
      if (!isClosedCategory(cat)) openCount++;
    }
    points.push({ date: new Date(day).toISOString().slice(0, 10), total, open: openCount });
  }
  return { runId, points };
}
