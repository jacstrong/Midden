/**
 * The inbox, notification preferences, and webhooks.
 *
 * Webhooks: admins manage global ones (every task) and any team's; a team's leads manage that
 * team's. URLs are secrets: they are accepted, never returned in full.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotifyPrefsPatchSchema, DEFAULT_NOTIFY_PREFS, WEBHOOK_EVENTS } from '@midden/core';
import { requireUser } from '../app.js';
import type { User } from '../auth/sessions.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { getTeam, ledTeamIds } from '../teams/teams.js';
import { maskUrl, webhookUrlProblem, type DeliveryRow, type WebhookRow } from './webhooks.js';

export const NotificationQuery = z.object({
  unread: z.enum(['0', '1']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().max(40).optional(),
});
export const MarkRead = z.union([
  z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(500) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
const EventsSchema = z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length);
export const CreateWebhook = z
  .object({
    name: z.string().trim().min(1).max(80),
    teamId: z.string().max(64).default(''),
    url: z.string().trim().min(1).max(2000),
    events: EventsSchema,
    enabled: z.boolean().default(true),
  })
  .strict();
export const PatchWebhook = z
  .object({
    name: z.string().trim().min(1).max(80),
    url: z.string().trim().min(1).max(2000),
    events: EventsSchema,
    enabled: z.boolean(),
  })
  .partial()
  .strict();

export interface WebhookView {
  id: string;
  teamId: string;
  name: string;
  /** Masked: scheme, host and the last few characters. */
  url: string;
  events: string[];
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  /** The most recent delivery, if any. */
  last: DeliveryView | null;
}

export interface DeliveryView {
  id: string;
  event: string;
  status: DeliveryRow['status'];
  attempts: number;
  nextAttemptAt: string | null;
  lastStatus: number | null;
  lastError: string;
  createdAt: string;
  deliveredAt: string | null;
  payload: unknown;
}

const deliveryView = (d: DeliveryRow): DeliveryView => ({
  id: d.id,
  event: d.event,
  status: d.status,
  attempts: Number(d.attempts),
  nextAttemptAt: d.next_attempt_at,
  lastStatus: d.last_status === null ? null : Number(d.last_status),
  lastError: d.last_error,
  createdAt: d.created_at,
  deliveredAt: d.delivered_at,
  payload: JSON.parse(d.payload) as unknown,
});

export async function notifyRoutes(app: FastifyInstance): Promise<void> {
  // ---- inbox ----
  app.get('/api/notifications', async (req) => {
    const user = requireUser(req);
    const q = NotificationQuery.parse(req.query);
    return app.notify.list(user, {
      unreadOnly: q.unread === '1',
      limit: q.limit,
      before: q.before,
    });
  });

  app.post('/api/notifications/read', async (req) => {
    const user = requireUser(req);
    const body = MarkRead.parse(req.body);
    return { unread: app.notify.markRead(user, 'all' in body ? 'all' : body.ids) };
  });

  app.get('/api/notifications/prefs', async (req) => {
    const user = requireUser(req);
    return { prefs: app.tasks.prefs.get(user.id), defaults: DEFAULT_NOTIFY_PREFS };
  });

  app.patch('/api/notifications/prefs', async (req) => {
    const user = requireUser(req);
    const patch = NotifyPrefsPatchSchema.parse(req.body);
    return { prefs: app.tasks.prefs.update(user.id, patch) };
  });

  // ---- webhooks ----
  const mayManage = (user: User, teamId: string): boolean =>
    user.role === 'admin' || (teamId !== '' && ledTeamIds(app.db, user.id).has(teamId));

  const hook = (user: User, id: string): WebhookRow => {
    const h = app.db.get<WebhookRow>('SELECT * FROM webhooks WHERE id = ?', id);
    if (!h || !mayManage(user, h.team_id)) throw notFound('No such webhook');
    return h;
  };

  const view = (h: WebhookRow): WebhookView => {
    const last = app.db.get<DeliveryRow>(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 1',
      h.id,
    );
    return {
      id: h.id,
      teamId: h.team_id,
      name: h.name,
      url: maskUrl(h.url),
      events: JSON.parse(h.events) as string[],
      enabled: !!h.enabled,
      createdBy: h.created_by,
      createdAt: h.created_at,
      updatedBy: h.updated_by,
      updatedAt: h.updated_at,
      last: last ? deliveryView(last) : null,
    };
  };

  const checkUrl = (url: string): void => {
    const problem = webhookUrlProblem(url, app.cfg.webhookAllowedHosts);
    if (problem) throw badRequest(problem);
  };

  app.get('/api/webhooks', async (req) => {
    const user = requireUser(req);
    const led = ledTeamIds(app.db, user.id);
    const rows = app.db
      .all<WebhookRow>('SELECT * FROM webhooks ORDER BY team_id, name COLLATE NOCASE')
      .filter((h) => user.role === 'admin' || led.has(h.team_id));
    return {
      webhooks: rows.map(view),
      allowedHosts: app.cfg.webhookAllowedHosts,
      origin: app.cfg.publicOrigin,
    };
  });

  app.post('/api/webhooks', async (req, reply) => {
    const user = requireUser(req);
    const body = CreateWebhook.parse(req.body);
    if (body.teamId && !getTeam(app.db, body.teamId)) throw badRequest('No such team');
    if (!mayManage(user, body.teamId))
      throw forbidden(
        body.teamId
          ? 'Only an admin or a lead of this team can add its webhooks'
          : 'Only an admin can add a webhook for every team',
      );
    checkUrl(body.url);
    const id = newId('wh');
    const ts = nowIso();
    app.db.run(
      'INSERT INTO webhooks (id, team_id, name, url, events, enabled, created_by, created_at, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id,
      body.teamId,
      body.name,
      body.url,
      JSON.stringify(body.events),
      body.enabled ? 1 : 0,
      user.id,
      ts,
      user.id,
      ts,
    );
    reply.status(201);
    return { webhook: view(hook(user, id)) };
  });

  app.patch<{ Params: { id: string } }>('/api/webhooks/:id', async (req) => {
    const user = requireUser(req);
    const h = hook(user, req.params.id);
    const body = PatchWebhook.parse(req.body);
    if (body.url !== undefined) checkUrl(body.url);
    app.db.run(
      'UPDATE webhooks SET name = ?, url = ?, events = ?, enabled = ?, updated_by = ?, updated_at = ? WHERE id = ?',
      body.name ?? h.name,
      body.url ?? h.url,
      body.events ? JSON.stringify(body.events) : h.events,
      body.enabled === undefined ? h.enabled : body.enabled ? 1 : 0,
      user.id,
      nowIso(),
      h.id,
    );
    return { webhook: view(hook(user, h.id)) };
  });

  app.delete<{ Params: { id: string } }>('/api/webhooks/:id', async (req) => {
    const user = requireUser(req);
    const h = hook(user, req.params.id);
    app.db.run('DELETE FROM webhooks WHERE id = ?', h.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/webhooks/:id/test', async (req) => {
    const user = requireUser(req);
    const h = hook(user, req.params.id);
    return { delivery: deliveryView(await app.webhooks.test(h.id, user.displayName)) };
  });

  app.get<{ Params: { id: string } }>('/api/webhooks/:id/deliveries', async (req) => {
    const user = requireUser(req);
    const h = hook(user, req.params.id);
    return {
      deliveries: app.db
        .all<DeliveryRow>(
          'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT 50',
          h.id,
        )
        .map(deliveryView),
    };
  });
}
