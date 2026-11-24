import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { addUser, as, login, testApp, testAppWith } from '../test/helpers.js';

describe('task insights and metrics', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  const setup = async (env: Record<string, string> = {}) => {
    app = Object.keys(env).length ? testAppWith(env) : testApp();
    const ids = {
      root: addUser(app, 'root', 'admin'),
      ann: addUser(app, 'ann'),
      bob: addUser(app, 'bob'),
    };
    await app.ready();
    const root = await login(app, 'root');
    const ann = await login(app, 'ann');
    const bob = await login(app, 'bob');
    const call = async (
      cookie: string,
      method: InjectOptions['method'],
      url: string,
      payload?: unknown,
    ) => {
      const r = await app.inject({
        method,
        url,
        ...as(cookie),
        ...(payload !== undefined ? { payload: payload as object } : {}),
      });
      if (r.statusCode >= 300) throw new Error(`${method} ${url}: ${r.statusCode} ${r.body}`);
      return r.json();
    };
    return { ids, root, ann, bob, call };
  };

  it('counts what the viewer can see, by team and run', async () => {
    const { ids, root, ann, bob, call } = await setup();
    const host = (await call(root, 'POST', '/api/teams', { name: 'Host' })).team.id as string;
    await call(root, 'PUT', `/api/teams/${host}/members/${ids.ann}`, { role: 'lead' });
    const run = (await call(ann, 'POST', '/api/task-runs', { name: 'Hunt 7', teamId: host })).run
      .id as string;
    const secret = (await call(ann, 'POST', '/api/cases', { name: 'Insider', restricted: true }))
      .case.id as string;

    const mk = (body: object) => call(ann, 'POST', '/api/tasks', body);
    const a = (await mk({ title: 'Pull DNS', runId: run, assignees: [ids.ann] })).task;
    await mk({ title: 'Queue me', runId: run, teamId: host });
    await mk({ title: 'Bob ad hoc', assignees: [ids.bob], dueAt: '2020-01-01T00:00:00Z' });
    await mk({ title: 'Secret lead', caseId: secret, assignees: [ids.ann] });
    await call(ann, 'PATCH', `/api/tasks/${a.id}`, { status: 'in_progress' });
    await call(ann, 'PATCH', `/api/tasks/${a.id}`, { status: 'done' });

    const forAnn = (await call(ann, 'GET', '/api/tasks/insights')).insights;
    expect(forAnn.open.total).toBe(3);
    expect(forAnn.open.byCategory.done).toBe(1);
    expect(forAnn.open.overdue).toBe(1);
    expect(forAnn.queues).toEqual([expect.objectContaining({ teamId: host, open: 1 })]);
    expect(forAnn.cycle.count).toBe(1);
    expect(forAnn.throughput.at(-1)).toMatchObject({ created: 4, done: 1 });

    // Bob isn't on the restricted case, so its task is in none of his numbers.
    const forBob = (await call(bob, 'GET', '/api/tasks/insights')).insights;
    expect(forBob.open.total).toBe(2);
    expect(forBob.people.map((p: { userId: string }) => p.userId)).toEqual([ids.bob]);
    expect(forBob.throughput.at(-1)).toMatchObject({ created: 3 });
    expect(JSON.stringify(forBob)).not.toContain('Secret');

    // The team filter keeps the host team's queue, runs and members' work.
    const team = (await call(ann, 'GET', `/api/tasks/insights?team=${host}`)).insights;
    expect(team.open.total).toBe(2);
    const byRun = (await call(ann, 'GET', `/api/tasks/insights?run=${run}`)).insights;
    expect(byRun.open.total).toBe(1);
    expect(byRun.burndown.points.at(-1)).toMatchObject({ total: 2, open: 1 });

    const bad = await app.inject({
      method: 'GET',
      url: '/api/tasks/insights?from=2026-03-01&to=2020-01-01',
      ...as(ann),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('keeps metrics off unless turned on', async () => {
    const { root, call } = await setup();
    const token = (await call(root, 'POST', '/api/tokens', { name: 'prom', scope: 'read' }))
      .token as string;
    const r = await app.inject({
      method: 'GET',
      url: '/api/metrics',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(404);
  });

  it("serves metrics to an admin's token only", async () => {
    const { ids, root, ann, call } = await setup({ MIDDEN_METRICS: 'token' });
    const host = (await call(root, 'POST', '/api/teams', { name: 'Host "A"' })).team.id as string;
    const t = (await call(ann, 'POST', '/api/tasks', { title: 'x', teamId: host })).task;
    await call(ann, 'PATCH', `/api/tasks/${t.id}`, {
      status: 'in_progress',
      assignees: [ids.ann],
    });
    await call(ann, 'PATCH', `/api/tasks/${t.id}`, { status: 'done' });
    await call(ann, 'PATCH', `/api/tasks/${t.id}`, { status: 'todo' });
    await call(ann, 'POST', '/api/tasks', { title: 'y' });

    const rootToken = (await call(root, 'POST', '/api/tokens', { name: 'prom', scope: 'read' }))
      .token as string;
    const annToken = (await call(ann, 'POST', '/api/tokens', { name: 'mine', scope: 'read' }))
      .token as string;
    const get = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/api/metrics', headers });

    const bySession = await app.inject({ method: 'GET', url: '/api/metrics', ...as(root) });
    expect(bySession.statusCode).toBe(401);
    expect((await get({ authorization: `Bearer ${annToken}` })).statusCode).toBe(403);
    const r = await get({ authorization: `Bearer ${rootToken}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain; version=0.0.4');
    const text = r.body;
    expect(text).toContain('midden_tasks_created_total 2\n');
    expect(text).toContain('midden_tasks_completed_total{team="Host \\"A\\""} 1\n');
    expect(text).toContain('midden_tasks_reopened_total 1\n');
    expect(text).toContain('midden_task_cycle_seconds_count 1\n');
    expect(text).toContain('midden_tasks_open{category="todo",team="Host \\"A\\""} 1\n');
    expect(text).toContain('midden_tasks_open{category="todo",team=""} 1\n');
    expect(text).toMatch(
      /midden_http_requests_total\{method="PATCH",route="\/api\/tasks\/:id",status="200"\} 3/,
    );
    expect(text).toContain('midden_webhook_deliveries_total{result="ok"} 0\n');
    expect(text).toMatch(/midden_db_size_bytes \d+/);
    // No person, task or case is named anywhere.
    expect(text).not.toContain(ids.ann);
    expect(text).not.toContain(t.id);

    // Every line is a comment or `name{labels} value`, and each family is declared once.
    const types = new Set<string>();
    for (const line of text.trimEnd().split('\n')) {
      if (line.startsWith('# TYPE ')) {
        const name = line.split(' ')[2]!;
        expect(types.has(name), name).toBe(false);
        types.add(name);
      } else if (!line.startsWith('# HELP '))
        expect(line).toMatch(/^[a-z_:][a-z0-9_:]*(\{.*\})? (-?[\d.e+-]+|NaN|\+Inf)$/i);
    }
  });
});
