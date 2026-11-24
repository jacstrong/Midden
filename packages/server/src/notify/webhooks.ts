/**
 * Outgoing webhooks in Rocket.Chat's incoming format (`text` plus `attachments`), which Slack
 * and Mattermost accept too. A team's webhook hears about that team's tasks (the task's team,
 * or its run's); a global one hears about every task.
 *
 * Messages go through a queue in the database with retries and backoff, so a chat server
 * that's down for a while still gets them, and each attempt is kept in a delivery log.
 *
 * Guarding what leaves the server:
 * - Destinations must match MIDDEN_WEBHOOK_ALLOWED_HOSTS, checked on save and on every send,
 *   and redirects are not followed. Chat is usually internal, so blocking private addresses
 *   wouldn't do; the allowlist is the control.
 * - A task in a restricted case (or a deleted one) is described only by its number: no title,
 *   comment, status or names.
 * - Text people typed has its @-mentions defused, so a task titled "@all" can't ping a channel.
 */
import {
  categoryOf,
  isClosedCategory,
  statusOf,
  taskRef,
  WEBHOOK_EVENTS,
  type Task,
  type TaskHappening,
  type TaskState,
  type WebhookEvent,
} from '@midden/core';
import type { Db } from '../db/db.js';
import { newId } from '../lib/ids.js';
import type { TaskCommit } from '../tasks/runtime.js';

/** Waits before each retry; after the last, the delivery is marked failed. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
const TIMEOUT_MS = 10_000;
const MAX_ATTACHMENTS = 10;
const TICK_MS = 10_000;
const KEEP_PER_HOOK = 200;

export interface WebhookRow {
  id: string;
  team_id: string;
  name: string;
  url: string;
  events: string;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

export interface DeliveryRow {
  id: string;
  webhook_id: string;
  event: string;
  payload: string;
  status: 'pending' | 'ok' | 'failed';
  attempts: number;
  next_attempt_at: string | null;
  last_status: number | null;
  last_error: string;
  created_at: string;
  delivered_at: string | null;
}

export interface WebhookMessage {
  text: string;
  attachments?: { title: string; title_link?: string; text?: string; color?: string }[];
}

export type Send = (url: string, body: string) => Promise<{ status: number; text: string }>;

/** Why a URL may not be used, or null if it may. */
export function webhookUrlProblem(url: string, allowed: readonly string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'That is not a valid URL';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    return 'Webhook URLs must use http or https';
  if (u.username || u.password) return 'Webhook URLs cannot carry a user name or password';
  if (!allowed.length)
    return 'Webhooks are turned off on this server. An administrator can allow chat hosts with MIDDEN_WEBHOOK_ALLOWED_HOSTS.';
  const host = u.hostname.toLowerCase();
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const ok = allowed.some((entry) => {
    const [h, p] = splitHostPort(entry);
    if (p && p !== port) return false;
    return h.startsWith('*.')
      ? host.endsWith(h.slice(1)) && host.length > h.length - 1
      : host === h;
  });
  return ok ? null : `${u.host} is not on this server's list of allowed webhook hosts`;
}

function splitHostPort(entry: string): [string, string] {
  if (entry.startsWith('[')) {
    const end = entry.indexOf(']');
    const rest = entry.slice(end + 1);
    return [entry.slice(0, end + 1), rest.startsWith(':') ? rest.slice(1) : ''];
  }
  const parts = entry.split(':');
  return parts.length === 2 ? [parts[0]!, parts[1]!] : [entry, ''];
}

/** Enough of a URL to recognise it by, without giving away the secret in its path. */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.length > 8 ? u.pathname.slice(-4) : '';
    return `${u.protocol}//${u.host}/…${tail}`;
  } catch {
    return '…';
  }
}

/** Stop @all, @here and @someone in typed text from pinging anyone. */
const defuse = (s: string): string => s.replace(/@/g, '@​').replace(/<!/g, '<​!');

const COLORS: Record<string, string> = {
  done: '#2e7d32',
  cancelled: '#757575',
  blocked: '#c62828',
  in_progress: '#1565c0',
  todo: '#9e9e9e',
  backlog: '#bdbdbd',
};

export interface MessageContext {
  state: TaskState;
  prev?: TaskState | undefined;
  actorName: string;
  /** User id → display name. */
  names: ReadonlyMap<string, string>;
  /** Whether a task's details must stay out of chat. */
  restricted: (t: Task) => boolean;
  origin: string | null;
}

const VERB: Record<WebhookEvent, string> = {
  created: 'created',
  assigned: 'assigned',
  status: 'changed the status of',
  done: 'finished',
  comment: 'commented on',
  approval_requested: 'asked for approval on',
  approval_decided: 'decided approval on',
  overdue: 'overdue',
};

/** The chat message for some events on some tasks, or null if there's nothing to say. */
export function webhookMessage(
  events: Map<string, { events: Set<WebhookEvent>; commentId?: string | undefined }>,
  m: MessageContext,
): WebhookMessage | null {
  const entries = [...events].filter(([id]) => m.state.tasks[id]);
  if (!entries.length) return null;
  const who = `*${defuse(m.actorName)}*`;
  const name = (u: string): string => defuse(m.names.get(u) ?? 'someone');
  const ref = (t: Task): string =>
    m.restricted(t) ? `${taskRef(t.num)} (restricted)` : taskRef(t.num);

  const describe = (t: Task, ev: Set<WebhookEvent>, commentId?: string): string => {
    if (m.restricted(t)) return [...ev].map((e) => VERB[e]).join(', ');
    const bits: string[] = [];
    if (ev.has('status') || ev.has('done'))
      bits.push(`Status: ${defuse(statusOf(m.state, t)?.name ?? '?')}`);
    if (ev.has('assigned') || ev.has('created'))
      bits.push(
        t.assignees.length ? `Assigned to ${t.assignees.map(name).join(', ')}` : 'Unassigned',
      );
    if (ev.has('approval_requested') && t.approval)
      bits.push(`Approver: ${name(t.approval.approverId)}`);
    if (ev.has('approval_decided') && t.approval)
      bits.push(
        `${t.approval.state === 'approved' ? 'Approved' : 'Rejected'} by ${name(t.approval.decidedBy)}${t.approval.comment ? `: ${defuse(t.approval.comment.slice(0, 300))}` : ''}`,
      );
    if (ev.has('overdue') && t.dueAt)
      bits.push(`Was due ${t.dueAt.slice(0, 16).replace('T', ' ')} UTC`);
    const c = commentId ? m.state.comments[commentId] : undefined;
    if (ev.has('comment') && c && !c.deletedAt)
      bits.push(`> ${defuse(c.body.length > 500 ? `${c.body.slice(0, 499)}…` : c.body)}`);
    return bits.join('\n');
  };

  const attachments = entries.slice(0, MAX_ATTACHMENTS).map(([id, e]) => {
    const t = m.state.tasks[id]!;
    const cat = categoryOf(m.state, t);
    const color = e.events.has('approval_requested') ? '#ef6c00' : (COLORS[cat ?? ''] ?? '#9e9e9e');
    return {
      title: m.restricted(t) ? ref(t) : `${taskRef(t.num)} · ${defuse(t.title)}`,
      ...(m.origin ? { title_link: `${m.origin}/#/tasks/t/${t.num}` } : {}),
      text: describe(t, e.events, e.commentId),
      color,
    };
  });

  let text: string;
  if (entries.length === 1) {
    const [id, e] = entries[0]!;
    const t = m.state.tasks[id]!;
    const ev = e.events;
    const r = ref(t);
    const restricted = m.restricted(t);
    if (ev.has('overdue')) text = `${r} is overdue`;
    else if (ev.has('created')) text = `${who} created ${r}`;
    else if (ev.has('approval_decided') && t.approval)
      text = `${who} ${t.approval.state === 'approved' ? 'approved' : 'rejected'} ${r}`;
    else if (ev.has('approval_requested') && t.approval)
      text = restricted
        ? `${who} asked for approval on ${r}`
        : `${who} asked ${name(t.approval.approverId)} to approve ${r}`;
    else if ((ev.has('status') || ev.has('done')) && !restricted)
      text = `${who} moved ${r} to *${defuse(statusOf(m.state, t)?.name ?? '?')}*`;
    else if (ev.has('assigned') && !restricted)
      text = `${who} assigned ${r} to ${t.assignees.map(name).join(', ') || 'nobody'}`;
    else if (ev.has('comment')) text = `${who} commented on ${r}`;
    else text = `${who} ${VERB[[...ev][0]!]} ${r}`;
  } else {
    const counts = new Map<WebhookEvent, number>();
    for (const [, e] of entries)
      for (const ev of e.events) counts.set(ev, (counts.get(ev) ?? 0) + 1);
    const summary = WEBHOOK_EVENTS.filter((ev) => counts.has(ev))
      .map((ev) => `${counts.get(ev)} ${ev.replace('_', ' ')}`)
      .join(', ');
    const runs = new Set(entries.map(([id]) => m.state.tasks[id]!.runId));
    const run = runs.size === 1 ? m.state.runs[[...runs][0]!] : undefined;
    const where = run ? ` in *${defuse(run.name)}*` : '';
    const overdueOnly = [...counts.keys()].every((k) => k === 'overdue');
    text = overdueOnly
      ? `${entries.length} tasks${where} are overdue`
      : `${who} updated ${entries.length} tasks${where}: ${summary}`;
    if (entries.length > MAX_ATTACHMENTS) text += ` (showing ${MAX_ATTACHMENTS})`;
  }
  return { text, attachments };
}

/** Webhook events for a commit, by task. */
export function commitEvents(
  c: Pick<TaskCommit, 'prev' | 'next'>,
  happenings: readonly TaskHappening[],
): Map<string, { events: Set<WebhookEvent>; commentId?: string | undefined }> {
  const out = new Map<string, { events: Set<WebhookEvent>; commentId?: string | undefined }>();
  const add = (id: string, ev: WebhookEvent, commentId?: string): void => {
    let e = out.get(id);
    if (!e) out.set(id, (e = { events: new Set() }));
    e.events.add(ev);
    if (commentId) e.commentId = commentId;
  };
  for (const [id, t] of Object.entries(c.next.tasks))
    if (!c.prev.tasks[id] && t) add(id, 'created');
  for (const h of happenings) {
    const isNew = !c.prev.tasks[h.taskId];
    if (h.kind === 'assigned' && !isNew) add(h.taskId, 'assigned');
    if (h.kind === 'status') {
      add(h.taskId, 'status');
      const before = c.prev.tasks[h.taskId];
      const after = c.next.tasks[h.taskId];
      const was = before && categoryOf(c.prev, before);
      const now = after && categoryOf(c.next, after);
      if (now && isClosedCategory(now) && !(was && isClosedCategory(was))) add(h.taskId, 'done');
    }
    if (h.kind === 'comment') add(h.taskId, 'comment', h.commentId);
    if (h.kind === 'approval_requested') add(h.taskId, 'approval_requested');
    if (h.kind === 'approval_decided') add(h.taskId, 'approval_decided');
  }
  return out;
}

const defaultSend: Send = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Midden-Webhook' },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = (await res.text().catch(() => '')).slice(0, 300);
  return { status: res.status, text };
};

export interface WebhookServiceOptions {
  allowedHosts: () => readonly string[];
  origin: string | null;
  now?: () => Date;
  log?: (err: unknown) => void;
  /** Told how each delivery attempt ended, for metrics. */
  onResult?: (result: 'ok' | 'retry' | 'failed') => void;
}

export class WebhookService {
  /** Replaceable in tests. */
  send: Send = defaultSend;
  private readonly now: () => Date;
  private readonly inflight = new Set<Promise<void>>();
  private readonly sending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly opts: WebhookServiceOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    this.timer ??= setInterval(() => this.kick(), TICK_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  /** Wait until nothing is being sent. */
  async flush(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  private hooksFor(task: Task, state: TaskState, event: WebhookEvent): WebhookRow[] {
    const runTeam = task.runId ? state.runs[task.runId]?.teamId : '';
    return this.db
      .all<WebhookRow>('SELECT * FROM webhooks WHERE enabled = 1')
      .filter(
        (h) =>
          (h.team_id === '' || h.team_id === task.teamId || h.team_id === runTeam) &&
          (JSON.parse(h.events) as string[]).includes(event),
      );
  }

  private restricted = (t: Task): boolean => {
    if (!t.caseId) return false;
    const c = this.db.get<{ restricted: number }>(
      'SELECT restricted FROM cases WHERE id = ?',
      t.caseId,
    );
    return !c || !!c.restricted;
  };

  private names(): Map<string, string> {
    return new Map(
      this.db
        .all<{ id: string; display_name: string }>('SELECT id, display_name FROM users')
        .map((u) => [u.id, u.display_name]),
    );
  }

  /** Queue messages for what a commit did, one per webhook. */
  onCommit(c: TaskCommit, happenings: readonly TaskHappening[]): void {
    const events = commitEvents(c, happenings);
    if (!events.size) return;
    this.queueFor(events, c.next, c.prev, c.actor.name);
  }

  onOverdue(state: TaskState, tasks: Task[]): void {
    const events = new Map(
      tasks.map((t) => [t.id, { events: new Set<WebhookEvent>(['overdue']) }]),
    );
    this.queueFor(events, state, undefined, 'Midden');
  }

  private queueFor(
    events: Map<string, { events: Set<WebhookEvent>; commentId?: string | undefined }>,
    state: TaskState,
    prev: TaskState | undefined,
    actorName: string,
  ): void {
    // Each webhook gets the tasks and events it subscribes to.
    const per = new Map<string, { hook: WebhookRow; events: typeof events }>();
    for (const [id, e] of events) {
      const t = state.tasks[id];
      if (!t) continue;
      for (const ev of e.events)
        for (const hook of this.hooksFor(t, state, ev)) {
          let p = per.get(hook.id);
          if (!p) per.set(hook.id, (p = { hook, events: new Map() }));
          let te = p.events.get(id);
          if (!te) p.events.set(id, (te = { events: new Set(), commentId: e.commentId }));
          te.events.add(ev);
        }
    }
    if (!per.size) return;
    const ctx: MessageContext = {
      state,
      prev,
      actorName,
      names: this.names(),
      restricted: this.restricted,
      origin: this.opts.origin,
    };
    for (const { hook, events: ev } of per.values()) {
      const msg = webhookMessage(ev, ctx);
      if (!msg) continue;
      const kinds = new Set([...ev.values()].flatMap((e) => [...e.events]));
      this.enqueue(hook.id, [...kinds].join(','), msg);
    }
    this.kick();
  }

  enqueue(webhookId: string, event: string, msg: WebhookMessage): string {
    const id = newId('wd');
    const ts = this.now().toISOString();
    this.db.run(
      "INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, attempts, next_attempt_at, created_at) VALUES (?,?,?,?,'pending',0,?,?)",
      id,
      webhookId,
      event,
      JSON.stringify(msg),
      ts,
      ts,
    );
    return id;
  }

  /** Start sending whatever is due, without waiting for it. */
  kick(): void {
    const due = this.db.all<DeliveryRow>(
      "SELECT * FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50",
      this.now().toISOString(),
    );
    for (const d of due) this.attemptInBackground(d);
  }

  private attemptInBackground(d: DeliveryRow): Promise<void> {
    if (this.sending.has(d.id)) return Promise.resolve();
    this.sending.add(d.id);
    const p = this.attempt(d)
      .catch((err) => this.opts.log?.(err))
      .finally(() => {
        this.sending.delete(d.id);
        this.inflight.delete(p);
      });
    this.inflight.add(p);
    return p;
  }

  /** Send a test message now and wait for the outcome. */
  async test(hookId: string, by: string): Promise<DeliveryRow> {
    const id = this.enqueue(hookId, 'test', {
      text: `Test message from Midden, sent by *${defuse(by)}*. This webhook works.`,
    });
    await this.attemptInBackground(this.delivery(id)!);
    return this.delivery(id)!;
  }

  delivery(id: string): DeliveryRow | undefined {
    return this.db.get<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE id = ?', id);
  }

  private async attempt(d: DeliveryRow): Promise<void> {
    const hook = this.db.get<WebhookRow>('SELECT * FROM webhooks WHERE id = ?', d.webhook_id);
    if (!hook) return;
    const attempts = Number(d.attempts) + 1;
    const problem = webhookUrlProblem(hook.url, this.opts.allowedHosts());
    let status: number | null = null;
    let error = '';
    if (problem) error = problem;
    else
      try {
        const res = await this.send(hook.url, d.payload);
        status = res.status;
        if (status < 200 || status >= 300)
          error =
            status >= 300 && status < 400
              ? `The server answered with a redirect (${status}), which isn't followed`
              : `HTTP ${status}${res.text ? `: ${res.text}` : ''}`;
      } catch (err) {
        error =
          err instanceof Error
            ? err.name === 'TimeoutError'
              ? 'Timed out'
              : err.message
            : 'Failed';
      }
    const now = this.now();
    if (!error) {
      this.opts.onResult?.('ok');
      this.db.run(
        "UPDATE webhook_deliveries SET status = 'ok', attempts = ?, last_status = ?, last_error = '', delivered_at = ?, next_attempt_at = NULL WHERE id = ?",
        attempts,
        status,
        now.toISOString(),
        d.id,
      );
    } else {
      // A host that isn't allowed won't become allowed by waiting; neither will a test.
      const delay = problem || d.event === 'test' ? undefined : RETRY_DELAYS_MS[attempts - 1];
      this.opts.onResult?.(delay === undefined ? 'failed' : 'retry');
      this.db.run(
        'UPDATE webhook_deliveries SET status = ?, attempts = ?, last_status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
        delay === undefined ? 'failed' : 'pending',
        attempts,
        status,
        error.slice(0, 500),
        delay === undefined ? null : new Date(now.getTime() + delay).toISOString(),
        d.id,
      );
    }
    this.db.run(
      'DELETE FROM webhook_deliveries WHERE webhook_id = ? AND id NOT IN (SELECT id FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?)',
      d.webhook_id,
      d.webhook_id,
      KEEP_PER_HOOK,
    );
  }
}
