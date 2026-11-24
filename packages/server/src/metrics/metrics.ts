/**
 * Operator metrics in Prometheus text format at `GET /api/metrics`. Off unless
 * `MIDDEN_METRICS=token`, and then only for an admin's API token (a read-only one is enough).
 *
 * Nothing here is sent anywhere: Prometheus has to come and ask. Labels never name a person,
 * a case or a task; the most specific label is a team's name.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { FastifyInstance } from 'fastify';
import {
  categoryOf,
  isClosedCategory,
  STATUS_CATEGORIES,
  type Task,
  type TaskState,
} from '@midden/core';
import type { Db } from '../db/db.js';
import { HttpError } from '../lib/errors.js';
import type { TaskCommit } from '../tasks/runtime.js';
import { changedTaskIds } from '../tasks/projection.js';
import { Counter, family, Histogram, type Labels } from './prom.js';

const H = 3600;
/** Cycle time buckets: an hour to a month. */
export const CYCLE_BUCKETS = [H, 4 * H, 12 * H, 24 * H, 48 * H, 96 * H, 168 * H, 336 * H, 720 * H];
export const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export interface MetricsSources {
  db: Db;
  version: string;
  tasks: () => TaskState;
}

export class Metrics {
  readonly tasksCreated = new Counter(
    'midden_tasks_created_total',
    'Tasks created since the server started.',
  );
  readonly tasksCompleted = new Counter(
    'midden_tasks_completed_total',
    'Tasks that reached a done status since the server started, by team.',
  );
  readonly tasksReopened = new Counter(
    'midden_tasks_reopened_total',
    'Tasks moved from done or cancelled back to an open status since the server started.',
  );
  readonly cycle = new Histogram(
    'midden_task_cycle_seconds',
    'Time from a task first going in progress to it being done.',
    CYCLE_BUCKETS,
  );
  readonly notifications = new Counter(
    'midden_notifications_total',
    'In-app notifications delivered, by kind. A change folded into an unread one still counts.',
  );
  readonly webhookDeliveries = new Counter(
    'midden_webhook_deliveries_total',
    'Webhook delivery attempts by result: ok, retry (will try again) or failed (gave up).',
    [{ result: 'ok' }, { result: 'retry' }, { result: 'failed' }],
  );
  readonly httpRequests = new Counter(
    'midden_http_requests_total',
    'API requests by method, route and status code.',
  );
  readonly httpDuration = new Histogram(
    'midden_http_request_duration_seconds',
    'API request duration by method and route.',
    HTTP_BUCKETS,
  );
  /** Browser sockets open now; the WebSocket route counts them in and out. */
  ws = 0;
  private loop: IntervalHistogram | null = null;
  private readonly started = Date.now() / 1000;

  constructor(private readonly src: MetricsSources) {}

  start(): void {
    if (this.loop) return;
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
  }

  stop(): void {
    this.loop?.disable();
    this.loop = null;
  }

  /** Count creations, completions, reopenings and cycle times in one committed op. */
  onTaskCommit(c: TaskCommit): void {
    const { prev, next } = c;
    let teams: Map<string, string> | null = null;
    for (const id of changedTaskIds(c.op, prev, next)) {
      const t = next.tasks[id];
      if (!t) continue;
      const p = prev.tasks[id];
      const cat = categoryOf(next, t);
      if (!p) {
        this.tasksCreated.inc();
        if (cat !== 'done') continue;
      }
      const was = p ? categoryOf(prev, p) : null;
      if (was && isClosedCategory(was) && !isClosedCategory(cat)) this.tasksReopened.inc();
      if (cat === 'done' && was !== 'done') {
        teams ??= this.teamNames();
        const team = teams.get(teamOf(next, t)) ?? '';
        this.tasksCompleted.inc({ team });
        const start = this.src.db.get<{ at: string | null }>(
          "SELECT MIN(at) AS at FROM task_transitions WHERE task_id = ? AND to_category = 'in_progress'",
          id,
        )?.at;
        if (start)
          this.cycle.observe({}, Math.max(0, (Date.parse(c.ts) - Date.parse(start)) / 1000));
      }
    }
  }

  observeHttp(method: string, route: string, status: number, seconds: number): void {
    this.httpRequests.inc({ method, route, status: String(status) });
    this.httpDuration.observe({ method, route }, seconds);
  }

  private teamNames(): Map<string, string> {
    return new Map(
      this.src.db
        .all<{ id: string; name: string }>('SELECT id, name FROM teams')
        .map((r) => [r.id, r.name]),
    );
  }

  /** The whole exposition, computed now. */
  render(): string {
    const { db } = this.src;
    const state = this.src.tasks();
    const teams = this.teamNames();
    const open = new Map<string, { labels: Labels; value: number }>();
    for (const c of STATUS_CATEGORIES)
      if (!isClosedCategory(c))
        open.set(`${c}\u0000`, { labels: { category: c, team: '' }, value: 0 });
    for (const t of Object.values(state.tasks)) {
      if (t.archived) continue;
      const cat = categoryOf(state, t);
      if (isClosedCategory(cat)) continue;
      const team = teams.get(teamOf(state, t)) ?? '';
      const k = `${cat}\u0000${team}`;
      const cur = open.get(k) ?? { labels: { category: cat, team }, value: 0 };
      cur.value++;
      open.set(k, cur);
    }
    const count = (sql: string): number => Number(db.get<{ n: number }>(sql)?.n ?? 0);
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const page = Number(db.get<{ page_size: number }>('PRAGMA page_size')?.page_size ?? 0);
    const pages = Number(db.get<{ page_count: number }>('PRAGMA page_count')?.page_count ?? 0);
    const loopStat = (v: number | undefined): number => (v && Number.isFinite(v) ? v / 1e9 : 0);
    const out = [
      family('midden_build_info', 'The running version; always 1.', 'gauge', [
        { labels: { version: this.src.version, node: process.version }, value: 1 },
      ]),
      family(
        'midden_tasks_open',
        'Open tasks (not done, cancelled or archived) by status category and team.',
        'gauge',
        [...open.values()],
      ),
      this.tasksCreated.render(),
      this.tasksCompleted.render(),
      this.tasksReopened.render(),
      this.cycle.render(),
      this.notifications.render(),
      this.webhookDeliveries.render(),
      family(
        'midden_webhook_queue_depth',
        'Webhook deliveries waiting to be sent or retried.',
        'gauge',
        [{ value: count("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = 'pending'") }],
      ),
      family('midden_ws_connections', 'Open browser sockets.', 'gauge', [{ value: this.ws }]),
      family(
        'midden_ops_total',
        'Changes recorded in the logs: tasks, and cases (deleting a case lowers this).',
        'counter',
        [
          {
            labels: { stream: 'tasks' },
            value: count('SELECT seq AS n FROM task_log WHERE id = 1'),
          },
          {
            labels: { stream: 'cases' },
            value: count('SELECT COALESCE(SUM(seq), 0) AS n FROM cases'),
          },
        ],
      ),
      family('midden_cases', 'Cases, by whether they are archived.', 'gauge', [
        {
          labels: { state: 'open' },
          value: count('SELECT COUNT(*) AS n FROM cases WHERE archived_at IS NULL'),
        },
        {
          labels: { state: 'archived' },
          value: count('SELECT COUNT(*) AS n FROM cases WHERE archived_at IS NOT NULL'),
        },
      ]),
      family('midden_users', 'Accounts that are not disabled.', 'gauge', [
        { value: count('SELECT COUNT(*) AS n FROM users WHERE disabled = 0') },
      ]),
      this.httpRequests.render(),
      this.httpDuration.render(),
      family(
        'midden_event_loop_delay_p50_seconds',
        'Median event loop delay since the last scrape.',
        'gauge',
        [{ value: loopStat(this.loop?.percentile(50)) }],
      ),
      family(
        'midden_event_loop_delay_p99_seconds',
        '99th percentile event loop delay since the last scrape.',
        'gauge',
        [{ value: loopStat(this.loop?.percentile(99)) }],
      ),
      family(
        'midden_event_loop_delay_max_seconds',
        'Longest event loop delay since the last scrape.',
        'gauge',
        [{ value: loopStat(this.loop?.max) }],
      ),
      family(
        'midden_db_size_bytes',
        'Size of the SQLite database, not counting its write-ahead log.',
        'gauge',
        [{ value: page * pages }],
      ),
      family('process_resident_memory_bytes', 'Resident memory size in bytes.', 'gauge', [
        { value: mem.rss },
      ]),
      family('nodejs_heap_used_bytes', 'V8 heap in use, in bytes.', 'gauge', [
        { value: mem.heapUsed },
      ]),
      family(
        'process_cpu_seconds_total',
        'User and system CPU time spent, in seconds.',
        'counter',
        [{ value: (cpu.user + cpu.system) / 1e6 }],
      ),
      family('process_start_time_seconds', 'When the process started, in Unix seconds.', 'gauge', [
        { value: Math.round(this.started) },
      ]),
    ];
    this.loop?.reset();
    return out.join('');
  }
}

/** The team a task counts toward: its queue's team, else its run's. */
function teamOf(state: TaskState, t: Task): string {
  return t.teamId || (t.runId ? (state.runs[t.runId]?.teamId ?? '') : '');
}

export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/metrics', async (req, reply) => {
    if (app.cfg.metrics === 'off')
      throw new HttpError(
        404,
        'Metrics are turned off on this server (MIDDEN_METRICS)',
        'notfound',
      );
    if (!req.token || !req.user)
      throw new HttpError(401, 'Metrics need an API token', 'unauthorized');
    if (req.user.role !== 'admin')
      throw new HttpError(403, "Metrics need an administrator's API token", 'forbidden');
    reply.header('cache-control', 'no-store');
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(app.metrics.render());
  });
}
