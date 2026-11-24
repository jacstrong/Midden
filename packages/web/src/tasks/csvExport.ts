/**
 * CSV export in the browser, for what a board or table shows (a saved view's filter can't be
 * sent to the server). It writes with the same core function as `GET /api/tasks/export`, so
 * the two files are the same format and either can be imported again.
 */
import {
  exportTasksCsv,
  statusOf,
  type Task,
  type TaskComment,
  type TaskDirectory,
  type TaskState,
} from '@midden/core';
import { downloadText } from '../lib/download';

export interface CsvOptions {
  /** Write due dates as offsets from this run's start, to make a playbook. */
  relativeToRun?: string | undefined;
  comments?: boolean | undefined;
  stateColumns?: boolean | undefined;
}

export function tasksCsv(
  state: TaskState,
  dir: TaskDirectory,
  tasks: Task[],
  o: CsvOptions = {},
): string {
  let comments: Map<string, TaskComment[]> | undefined;
  if (o.comments) {
    const ids = new Set(tasks.map((t) => t.id));
    comments = new Map();
    for (const c of Object.values(state.comments))
      if (ids.has(c.taskId)) comments.set(c.taskId, [...(comments.get(c.taskId) ?? []), c]);
    for (const list of comments.values())
      list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  const run = o.relativeToRun ? state.runs[o.relativeToRun] : undefined;
  return exportTasksCsv(tasks, {
    users: new Map(dir.users.map((u) => [u.id, u])),
    teams: new Map(dir.teams.map((t) => [t.id, t])),
    cases: new Map(dir.cases.map((c) => [c.id, c])),
    statusName: (t) => statusOf(state, t)?.name ?? '',
    relativeTo: run?.startDate,
    comments,
    stateColumns: o.stateColumns ?? true,
  });
}

export const csvName = (base: string): string =>
  `${
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'tasks'
  }-${new Date().toISOString().slice(0, 10)}.csv`;

export function downloadCsv(name: string, csv: string): void {
  downloadText(name, csv, 'text/csv;charset=utf-8');
}
