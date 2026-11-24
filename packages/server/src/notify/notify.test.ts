import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { NotificationView, ServerMessage } from '@midden/core';
import { addUser, as, login, testAppWith } from '../test/helpers.js';
import { findUserById } from '../auth/sessions.js';
import { responseSchemas } from '../openapi/spec.js';
import { maskUrl, webhookUrlProblem, type WebhookMessage } from './webhooks.js';

describe('notifications and webhooks', () => {
  let app: FastifyInstance;
  const c: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const sent: { url: string; body: WebhookMessage }[] = [];
  let reply: { status: number; text: string } | Error = { status: 200, text: 'ok' };

  const call = async (who: string, method: InjectOptions['method'], url: string, p?: unknown) => {
    const res = await app.inject({
      method,
      url,
      ...as(c[who]!),
      ...(p !== undefined ? { payload: p } : {}),
    });
    return { status: res.statusCode, text: res.body, body: res.body ? res.json() : null };
  };
  const ok = async (who: string, method: InjectOptions['method'], url: string, p?: unknown) => {
    const r = await call(who, method, url, p);
    expect(r.status, r.text).toBeLessThan(300);
    return r.body;
  };
  const create = async (who: string, body: Record<string, unknown>) =>
    (await ok(who, 'POST', '/api/tasks', body)).task as { id: string; num: number };
  const inbox = async (who: string, q = '') =>
    (await ok(who, 'GET', `/api/notifications${q}`)) as {
      notifications: NotificationView[];
      unread: number;
    };

  beforeEach(async () => {
    app = testAppWith({
      MIDDEN_WEBHOOK_ALLOWED_HOSTS: 'chat.test, *.chat.mil:8443',
      MIDDEN_PUBLIC_ORIGIN: 'https://midden.test',
    });
    sent.length = 0;
    reply = { status: 200, text: 'ok' };
    app.webhooks.send = async (url, body) => {
      sent.push({ url, body: JSON.parse(body) as WebhookMessage });
      if (reply instanceof Error) throw reply;
      return reply;
    };
    for (const [n, role] of [
      ['root', 'admin'],
      ['lena', 'analyst'],
      ['ann', 'analyst'],
      ['bob', 'analyst'],
      ['vic', 'viewer'],
    ] as const)
      ids[n] = addUser(app, n, role);
    await app.ready();
    for (const n of ['root', 'lena', 'ann', 'bob', 'vic']) c[n] = await login(app, n);
    ids.host = (await ok('root', 'POST', '/api/teams', { name: 'Host' })).team.id;
    ids.net = (await ok('root', 'POST', '/api/teams', { name: 'Network' })).team.id;
    await ok('root', 'PUT', `/api/teams/${ids.host}/members/${ids.lena}`, { role: 'lead' });
    for (const n of ['ann', 'bob'])
      await ok('root', 'PUT', `/api/teams/${ids.host}/members/${ids[n]}`, { role: 'member' });
  });
  afterEach(async () => {
    await app.close();
  });

  it('tells the assignee, folds quick follow-ups together and never tells the actor', async () => {
    const t = await create('lena', { title: 'Pull DNS logs', assignees: [ids.ann] });
    expect((await inbox('lena')).notifications).toEqual([]);
    let ann = await inbox('ann');
    expect(ann.unread).toBe(1);
    expect(ann.notifications[0]).toMatchObject({
      kind: 'assigned',
      tasks: [{ id: t.id, num: 1, title: 'Pull DNS logs' }],
      actors: [{ id: ids.lena, name: 'LENA' }],
      read: false,
    });
    responseSchemas.Notification.parse(ann.notifications[0]);

    // Bob comments a minute later: same notification, now about a comment from Bob too.
    await ok('bob', 'POST', `/api/tasks/${t.id}/comments`, {
      body: 'Resolver list is in the wiki',
    });
    ann = await inbox('ann');
    expect(ann.unread).toBe(1);
    expect(ann.notifications[0]).toMatchObject({
      kind: 'assigned',
      kinds: ['assigned', 'comment'],
      actors: [{ name: 'LENA' }, { name: 'BOB' }],
      comments: [{ taskId: t.id, excerpt: 'Resolver list is in the wiki' }],
      count: 2,
    });

    // The creator auto-followed, so Lena hears about Bob's comment.
    expect((await inbox('lena')).notifications[0]).toMatchObject({ kind: 'comment' });

    // Once read, the next change starts a new notification.
    await ok('ann', 'POST', '/api/notifications/read', { ids: [ann.notifications[0]!.id] });
    await ok('bob', 'PATCH', `/api/tasks/${t.id}`, { status: 'In progress' });
    ann = await inbox('ann');
    expect(ann.unread).toBe(1);
    expect(ann.notifications.map((n) => [n.kind, n.read])).toEqual([
      ['status', false],
      ['assigned', true],
    ]);
    expect((await inbox('ann', '?unread=1')).notifications).toHaveLength(1);
    expect((await ok('ann', 'POST', '/api/notifications/read', { all: true })).unread).toBe(0);
  });

  it('sends one notification per person for a bulk change', async () => {
    const a = await create('lena', { title: 'A' });
    const b = await create('lena', { title: 'B' });
    const d = await create('lena', { title: 'D' });
    await ok('lena', 'POST', '/api/tasks/ops', {
      op: { type: 'task.assign', ids: [a.id, b.id, d.id], mode: 'set', users: [ids.ann] },
    });
    const ann = await inbox('ann');
    expect(ann.notifications).toHaveLength(1);
    expect(ann.notifications[0]!.tasks.map((t) => t.title)).toEqual(['A', 'B', 'D']);
  });

  it('tells mentioned people, but only about tasks they can see', async () => {
    const secret = (await ok('ann', 'POST', '/api/cases', { name: 'Insider', restricted: true }))
      .case.id as string;
    await create('ann', { title: 'Open', description: 'ping @bob' });
    const hidden = await create('ann', {
      title: 'Interview',
      description: 'ping @bob',
      caseId: secret,
    });
    let bob = await inbox('bob');
    expect(bob.notifications.map((n) => [n.kind, n.tasks[0]!.title])).toEqual([
      ['mention', 'Open'],
    ]);

    // A task that moves into a restricted case drops out of the inbox it was already in.
    const open = bob.notifications[0]!.tasks[0]!.id;
    await ok('ann', 'PATCH', `/api/tasks/${open}`, { caseId: secret });
    bob = await inbox('bob');
    expect(bob).toEqual({ notifications: [], unread: 0 });
    expect(JSON.stringify(bob)).not.toContain(hidden.id);
  });

  it('asks the approver, who always hears, and tells the assignee the decision', async () => {
    await ok('root', 'PATCH', '/api/notifications/prefs', {
      grid: { status: { creator: false, assignee: false, follower: false, approver: false } },
    });
    const t = await create('ann', {
      title: 'Accept risk',
      assignees: [ids.ann],
      approverId: ids.root,
    });
    expect((await inbox('root')).notifications[0]).toMatchObject({ kind: 'approval_requested' });
    await ok('root', 'POST', '/api/tasks/ops', {
      op: { type: 'approval.decide', taskId: t.id, decision: 'approved', comment: 'ok' },
    });
    expect((await inbox('ann')).notifications[0]).toMatchObject({ kind: 'approval_decided' });
  });

  it('keeps preferences, including auto-follow and queue notices', async () => {
    const got = await ok('bob', 'GET', '/api/notifications/prefs');
    responseSchemas.NotifyPrefs.parse(got.prefs);
    expect(got.prefs).toEqual(got.defaults);
    const saved = await ok('bob', 'PATCH', '/api/notifications/prefs', {
      queue: true,
      autoFollow: { created: false },
    });
    expect(saved.prefs).toMatchObject({
      queue: true,
      autoFollow: { created: false, assigned: true },
    });
    expect((await call('bob', 'PATCH', '/api/notifications/prefs', { queue: 'yes' })).status).toBe(
      400,
    );

    const mine = await create('bob', { title: 'Mine' });
    expect((await ok('bob', 'GET', `/api/tasks/${mine.id}`)).task.followers).toEqual([]);
    const theirs = await create('ann', { title: 'Theirs' });
    expect((await ok('ann', 'GET', `/api/tasks/${theirs.id}`)).task.followers).toEqual([ids.ann]);

    await create('lena', { title: 'Queued work', teamId: ids.host });
    expect((await inbox('bob')).notifications.map((n) => n.kind)).toEqual(['queued']);
    expect((await inbox('ann')).notifications).toEqual([]);
  });

  it('sends due-soon and overdue reminders once per due date', async () => {
    const soon = new Date(Date.now() + 2 * 3600_000).toISOString();
    const late = new Date(Date.now() - 3600_000).toISOString();
    const a = await create('lena', { title: 'Soon', assignees: [ids.ann], dueAt: soon });
    await create('lena', { title: 'Late', assignees: [ids.ann], dueAt: late });
    await create('lena', { title: 'Done late', assignees: [ids.ann], dueAt: late, status: 'done' });
    await ok('ann', 'POST', '/api/notifications/read', { all: true });

    expect(app.notify.runReminders()).toBe(2);
    expect(app.notify.runReminders()).toBe(0);
    const ann = await inbox('ann', '?unread=1');
    expect(ann.notifications.map((n) => [n.kind, n.tasks.map((t) => t.title), n.actors])).toEqual([
      ['due_soon', ['Soon'], []],
      ['overdue', ['Late'], []],
    ]);

    // Moving the due date arms the reminder again.
    await ok('lena', 'PATCH', `/api/tasks/${a.id}`, {
      dueAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
    });
    expect(app.notify.runReminders()).toBe(1);
  });

  it('pushes to the person’s open sockets', async () => {
    const got: ServerMessage[] = [];
    app.taskChannel.join({
      id: 'sock1',
      user: findUserById(app.db, ids.ann)!,
      send: (m) => got.push(m),
      close: () => {},
    });
    await create('lena', { title: 'Live', assignees: [ids.ann] });
    const n = got.find((m) => m.t === 'notify');
    expect(n).toMatchObject({ t: 'notify', unread: 1, notification: { kind: 'assigned' } });
    await ok('ann', 'POST', '/api/notifications/read', { all: true });
    expect(got.at(-1)).toEqual({ t: 'notify', unread: 0, read: 'all' });
  });

  describe('webhooks', () => {
    const hook = async (who: string, body: Record<string, unknown>) =>
      call(who, 'POST', '/api/webhooks', {
        name: 'Host chat',
        url: 'https://chat.test/hooks/abc/SECRET1234',
        events: ['created', 'status', 'comment'],
        ...body,
      });

    it('checks destinations and who may manage them', () => {
      const allowed = ['chat.test', '*.chat.mil:8443'];
      expect(webhookUrlProblem('https://chat.test/x', allowed)).toBeNull();
      expect(webhookUrlProblem('http://chat.test:9000/x', allowed)).toBeNull();
      expect(webhookUrlProblem('https://rc.chat.mil:8443/x', allowed)).toBeNull();
      expect(webhookUrlProblem('https://rc.chat.mil/x', allowed)).toMatch(/not on this server/);
      expect(webhookUrlProblem('https://chat.mil:8443/x', allowed)).toMatch(/not on this server/);
      expect(webhookUrlProblem('https://evil.test/x', allowed)).toMatch(/not on this server/);
      expect(webhookUrlProblem('ftp://chat.test/x', allowed)).toMatch(/http or https/);
      expect(webhookUrlProblem('https://u:p@chat.test/x', allowed)).toMatch(/password/);
      expect(webhookUrlProblem('https://chat.test/x', [])).toMatch(/turned off/);
      expect(maskUrl('https://chat.test/hooks/abc/SECRET1234')).toBe('https://chat.test/…1234');
    });

    it('lets admins and the team’s leads manage webhooks, and hides the URL', async () => {
      expect((await hook('ann', { teamId: ids.host })).status).toBe(403);
      expect((await hook('lena', { teamId: ids.net })).status).toBe(403);
      expect((await hook('lena', {})).status).toBe(403);
      expect((await hook('lena', { teamId: ids.host, url: 'https://evil.test/x' })).status).toBe(
        400,
      );
      const made = await hook('lena', { teamId: ids.host });
      expect(made.status).toBe(201);
      responseSchemas.Webhook.parse(made.body.webhook);
      expect(made.text).not.toContain('SECRET');
      const id = made.body.webhook.id as string;

      const list = await ok('lena', 'GET', '/api/webhooks');
      expect(list.webhooks.map((w: { id: string }) => w.id)).toEqual([id]);
      expect(list.allowedHosts).toEqual(['chat.test', '*.chat.mil:8443']);
      expect((await ok('ann', 'GET', '/api/webhooks')).webhooks).toEqual([]);
      expect((await call('ann', 'PATCH', `/api/webhooks/${id}`, { enabled: false })).status).toBe(
        404,
      );
      const patched = await ok('lena', 'PATCH', `/api/webhooks/${id}`, { name: 'Renamed' });
      expect(patched.webhook).toMatchObject({ name: 'Renamed', url: 'https://chat.test/…1234' });
      expect((await ok('root', 'GET', '/api/webhooks')).webhooks).toHaveLength(1);
      await ok('root', 'DELETE', `/api/webhooks/${id}`);
      expect((await ok('lena', 'GET', '/api/webhooks')).webhooks).toEqual([]);
    });

    it('posts team task changes in Rocket.Chat format, with restricted tasks kept vague', async () => {
      const id = (await hook('lena', { teamId: ids.host })).body.webhook.id as string;
      await hook('root', { name: 'Everything', url: 'https://chat.test/all', events: ['done'] });
      const secret = (await ok('ann', 'POST', '/api/cases', { name: 'Insider', restricted: true }))
        .case.id as string;

      const t = await create('ann', { title: 'Ping @all about beacons', teamId: ids.host });
      await create('ann', { title: 'Other team', teamId: ids.net });
      await app.webhooks.flush();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.url).toBe('https://chat.test/hooks/abc/SECRET1234');
      expect(sent[0]!.body.text).toBe('*ANN* created T-1');
      expect(sent[0]!.body.attachments![0]).toMatchObject({
        title: 'T-1 · Ping @​all about beacons',
        title_link: 'https://midden.test/#/tasks/t/1',
      });

      sent.length = 0;
      await ok('bob', 'PATCH', `/api/tasks/${t.id}`, { status: 'done' });
      await app.webhooks.flush();
      expect(sent.map((s) => [s.url, s.body.text])).toEqual([
        ['https://chat.test/hooks/abc/SECRET1234', '*BOB* moved T-1 to *Done*'],
        ['https://chat.test/all', '*BOB* moved T-1 to *Done*'],
      ]);

      sent.length = 0;
      const r = await create('ann', {
        title: 'Interview the suspect',
        teamId: ids.host,
        caseId: secret,
      });
      await ok('ann', 'POST', `/api/tasks/${r.id}/comments`, { body: 'He admitted it' });
      await app.webhooks.flush();
      expect(sent.map((s) => s.body.text)).toEqual([
        '*ANN* created T-3 (restricted)',
        '*ANN* commented on T-3 (restricted)',
      ]);
      expect(JSON.stringify(sent)).not.toMatch(/Interview|admitted/);

      const deliveries = (await ok('lena', 'GET', `/api/webhooks/${id}/deliveries`)).deliveries;
      expect(deliveries.map((d: { status: string }) => d.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
      responseSchemas.WebhookDelivery.parse(deliveries[0]);
    });

    it('retries failures with backoff, and sends tests on demand', async () => {
      const id = (await hook('lena', { teamId: ids.host })).body.webhook.id as string;
      reply = { status: 500, text: 'Internal Server Error' };
      await create('ann', { title: 'Flaky', teamId: ids.host });
      await app.webhooks.flush();
      let [d] = (await ok('lena', 'GET', `/api/webhooks/${id}/deliveries`)).deliveries;
      expect(d).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastStatus: 500,
        lastError: 'HTTP 500: Internal Server Error',
      });
      const wait = Date.parse(d.nextAttemptAt) - Date.now();
      expect(wait).toBeGreaterThan(25_000);
      expect(wait).toBeLessThanOrEqual(30_000);

      // Not due yet, so a kick sends nothing.
      sent.length = 0;
      app.webhooks.kick();
      await app.webhooks.flush();
      expect(sent).toEqual([]);

      reply = new Error('connect ECONNREFUSED');
      const test = (await ok('lena', 'POST', `/api/webhooks/${id}/test`)).delivery;
      expect(test).toMatchObject({
        event: 'test',
        status: 'failed',
        lastError: 'connect ECONNREFUSED',
      });
      reply = { status: 200, text: 'ok' };
      expect((await ok('lena', 'POST', `/api/webhooks/${id}/test`)).delivery).toMatchObject({
        status: 'ok',
        attempts: 1,
      });
      expect(sent.at(-1)!.body.text).toMatch(/^Test message from Midden, sent by \*LENA\*/);
      [d] = (await ok('lena', 'GET', '/api/webhooks')).webhooks;
      expect(d.last).toMatchObject({ event: 'test', status: 'ok' });
    });

    it('refuses to save webhooks when the server allows no hosts', async () => {
      await app.close();
      app = testAppWith({});
      ids.root = addUser(app, 'root', 'admin');
      await app.ready();
      c.root = await login(app, 'root');
      const r = await hook('root', {});
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/MIDDEN_WEBHOOK_ALLOWED_HOSTS/);
    });
  });
});
