import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { addUser, as, login, testApp } from '../test/helpers.js';

/** Task routes over API tokens: what a script or agent may do, and what stays in person. */
describe('tasks over API tokens', () => {
  let app: FastifyInstance;
  let ann: string;
  let root: string;
  let read: string;
  let write: string;
  let rootWrite: string;
  const ids: Record<string, string> = {};

  const mint = async (cookie: string, name: string, scope: 'read' | 'write') =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/tokens',
        ...as(cookie),
        payload: { name, scope },
      })
    ).json().token as string;
  const bearer = (token: string, method: InjectOptions['method'], url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  beforeEach(async () => {
    app = testApp();
    ids.ann = addUser(app, 'ann');
    ids.root = addUser(app, 'root', 'admin');
    await app.ready();
    ann = await login(app, 'ann');
    root = await login(app, 'root');
    read = await mint(ann, 'reader', 'read');
    write = await mint(ann, 'writer', 'write');
    rootWrite = await mint(root, 'root-bot', 'write');
  });
  afterEach(async () => {
    await app.close();
  });

  it('lets a read token read tasks and a write token change them', async () => {
    const made = await bearer(write, 'POST', '/api/tasks', { title: 'Scripted task' });
    expect(made.statusCode).toBe(201);
    const id = made.json().task.id as string;
    for (const url of [
      '/api/tasks',
      '/api/tasks/state',
      '/api/tasks/ops',
      `/api/tasks/${id}`,
      `/api/tasks/${id}/history`,
      '/api/tasks/export',
      '/api/task-runs',
      '/api/workflows',
      '/api/playbooks',
      '/api/teams',
    ])
      expect((await bearer(read, 'GET', url)).statusCode, url).toBe(200);
    expect((await bearer(read, 'POST', '/api/tasks', { title: 'x' })).statusCode).toBe(403);
    expect((await bearer(write, 'PATCH', `/api/tasks/${id}`, { status: 'done' })).statusCode).toBe(
      200,
    );
    expect(
      (await bearer(write, 'POST', `/api/tasks/${id}/comments`, { body: 'Done by script' }))
        .statusCode,
    ).toBe(201);
    const hist = (await bearer(read, 'GET', `/api/tasks/${id}/history`)).json().ops;
    expect(hist.at(-1).actor.name).toBe('ANN via writer');
  });

  it('keeps notifications, webhooks, views and team changes in the browser', async () => {
    for (const [method, url] of [
      ['GET', '/api/notifications'],
      ['GET', '/api/webhooks'],
      ['GET', '/api/task-views'],
      ['POST', '/api/teams'],
      ['POST', '/api/task-runs'],
    ] as const)
      expect(
        (await bearer(rootWrite, method, url, method === 'POST' ? {} : undefined)).statusCode,
        url,
      ).toBe(403);
  });

  it('never lets a token decide an approval, or bring a decision back by undoing', async () => {
    const t = (
      await app.inject({
        method: 'POST',
        url: '/api/tasks',
        ...as(ann),
        payload: { title: 'Accept risk', approverId: ids.root },
      })
    ).json().task as { id: string };
    const decide = { type: 'approval.decide', taskId: t.id, decision: 'approved', comment: '' };
    const byToken = await bearer(rootWrite, 'POST', '/api/tasks/ops', { op: decide });
    expect(byToken.statusCode).toBe(403);
    expect(byToken.json().error.message).toMatch(/browser session/);

    // Root approves in person; Ann undoes it; neither a token nor Ann can bring it back.
    const ok = await app.inject({
      method: 'POST',
      url: '/api/tasks/ops',
      ...as(root),
      payload: { op: decide },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const undo = await app.inject({
      method: 'POST',
      url: '/api/tasks/revert',
      ...as(ann),
      payload: { seq: ok.json().seq },
    });
    expect(undo.statusCode, undo.body).toBe(200);
    const redo = { seq: undo.json().seq };
    const tokenRedo = await bearer(rootWrite, 'POST', '/api/tasks/revert', redo);
    expect(tokenRedo.statusCode).toBe(403);
    const annRedo = await app.inject({
      method: 'POST',
      url: '/api/tasks/revert',
      ...as(ann),
      payload: redo,
    });
    expect(annRedo.statusCode).toBe(403);
    expect(annRedo.json().error.message).toMatch(/Only ROOT can restore/);
    const task = (await bearer(read, 'GET', `/api/tasks/${t.id}`)).json().task;
    expect(task.approval.state).toBe('pending');
    // The approver can, in person.
    const rootRedo = await app.inject({
      method: 'POST',
      url: '/api/tasks/revert',
      ...as(root),
      payload: redo,
    });
    expect(rootRedo.statusCode, rootRedo.body).toBe(200);
  });
});
