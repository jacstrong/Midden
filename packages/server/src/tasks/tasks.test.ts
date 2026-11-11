import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { blankTask, emptyState, type Op, type Task } from '@midden/core';
import { addUser, as, login, testApp } from '../test/helpers.js';
import { CaseRuntime } from '../cases/runtime.js';
import { NOTIFICATIONS_KEPT, pruneNotifications } from './notifications.js';

describe('tasks on the server', () => {
  let app: FastifyInstance;
  let ann: string;
  let bob: string;
  let vic: string;
  let ids: Record<string, string>;
  let caseId: string;

  beforeEach(async () => {
    app = testApp();
    ids = {
      admin: addUser(app, 'admin', 'admin'),
      ann: addUser(app, 'ann'),
      bob: addUser(app, 'bob'),
      vic: addUser(app, 'vic', 'viewer'),
    };
    await app.ready();
    ann = await login(app, 'ann');
    bob = await login(app, 'bob');
    vic = await login(app, 'vic');
    const c = await app.inject({
      method: 'POST',
      url: '/api/cases',
      ...as(ann),
      payload: { name: 'Op Tasks', restricted: false },
    });
    caseId = c.json().case.id as string;
  });
  afterEach(async () => {
    await app.close();
  });

  const submit = (cookie: string, op: Op) =>
    app.inject({ method: 'POST', url: `/api/cases/${caseId}/ops`, ...as(cookie), payload: { op } });

  const newTask = (extra: Partial<Task> = {}): Task => ({
    ...blankTask({ id: ids.ann!, name: 'ANN' }),
    title: 'Sweep the DCs',
    ...extra,
  });

  const inbox = async (cookie: string, unread = false) =>
    (
      await app.inject({
        method: 'GET',
        url: `/api/notifications${unread ? '?unread=1' : ''}`,
        ...as(cookie),
      })
    ).json() as {
      notifications: Array<{
        id: string;
        kind: string;
        text: string;
        actor: { name: string };
        taskId: string | null;
        caseName: string;
      }>;
      unread: number;
    };

  it('lists the people who can read a case, and only them', async () => {
    const open = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/people`,
      ...as(bob),
    });
    expect(
      open
        .json()
        .people.map((p: { username: string }) => p.username)
        .sort(),
    ).toEqual(['admin', 'ann', 'bob', 'vic']);
    expect(open.json().people.find((p: { username: string }) => p.username === 'vic').canEdit).toBe(
      false,
    );
    await app.inject({
      method: 'PATCH',
      url: `/api/cases/${caseId}`,
      ...as(ann),
      payload: { restricted: true },
    });
    const restricted = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/people`,
      ...as(ann),
    });
    expect(
      restricted
        .json()
        .people.map((p: { username: string }) => p.username)
        .sort(),
    ).toEqual(['admin', 'ann']);
  });

  it('tells someone when they are assigned, and not the person who did it', async () => {
    const task = newTask({ assignees: [ids.bob!] });
    expect((await submit(ann, { type: 'task.add', task })).statusCode).toBe(200);
    const b = await inbox(bob);
    expect(b.unread).toBe(1);
    expect(b.notifications[0]).toMatchObject({
      kind: 'assigned',
      taskId: task.id,
      caseName: 'Op Tasks',
      actor: { name: 'ANN' },
      text: 'assigned you to “Sweep the DCs”',
    });
    expect((await inbox(ann)).unread).toBe(0);
  });

  it('lets anyone who can read follow a task, and tells followers about changes', async () => {
    const task = newTask({ assignees: [ids.bob!] });
    await submit(ann, { type: 'task.add', task });
    const follow = await app.inject({
      method: 'PUT',
      url: `/api/cases/${caseId}/tasks/${task.id}/follow`,
      ...as(vic),
    });
    expect(follow.statusCode).toBe(200);
    const list = await app.inject({
      method: 'GET',
      url: `/api/cases/${caseId}/follows`,
      ...as(ann),
    });
    expect(list.json().follows).toEqual([{ taskId: task.id, userId: ids.vic }]);

    await submit(bob, { type: 'task.set', id: task.id, patch: { status: 'doing' } });
    const v = await inbox(vic);
    expect(v.notifications[0]).toMatchObject({
      kind: 'status',
      text: 'moved “Sweep the DCs” to In progress',
    });
    // bob made the change; he is told nothing new
    expect((await inbox(bob)).notifications.map((n) => n.kind)).toEqual(['assigned']);

    await app.inject({
      method: 'DELETE',
      url: `/api/cases/${caseId}/tasks/${task.id}/follow`,
      ...as(vic),
    });
    await submit(bob, { type: 'task.set', id: task.id, patch: { status: 'done' } });
    expect((await inbox(vic)).notifications).toHaveLength(1);
  });

  it('refuses to follow a task that does not exist', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/cases/${caseId}/tasks/task_nope/follow`,
      ...as(bob),
    });
    expect(res.statusCode).toBe(404);
  });

  it('does not tell people who can no longer read the case', async () => {
    const task = newTask({ assignees: [ids.bob!] });
    await submit(ann, { type: 'task.add', task });
    await app.inject({
      method: 'PATCH',
      url: `/api/cases/${caseId}`,
      ...as(ann),
      payload: { restricted: true },
    });
    await submit(ann, { type: 'task.set', id: task.id, patch: { status: 'done' } });
    const b = await inbox(bob);
    // the earlier notice is hidden too, now that bob cannot open the case
    expect(b.notifications).toEqual([]);
    expect(b.unread).toBe(0);
  });

  it('marks notices read, one at a time or all at once', async () => {
    for (const title of ['one', 'two', 'three'])
      await submit(ann, { type: 'task.add', task: newTask({ title, assignees: [ids.bob!] }) });
    const b = await inbox(bob);
    expect(b.unread).toBe(3);
    const one = await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      ...as(bob),
      payload: { ids: [b.notifications[0]!.id] },
    });
    expect(one.json().unread).toBe(2);
    expect((await inbox(bob, true)).notifications).toHaveLength(2);
    // someone else's id does nothing
    await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      ...as(ann),
      payload: { all: true },
    });
    expect((await inbox(bob)).unread).toBe(2);
    const all = await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      ...as(bob),
      payload: { all: true },
    });
    expect(all.json().unread).toBe(0);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      ...as(bob),
      payload: {},
    });
    expect(bad.statusCode).toBe(400);
  });

  it('sums up a bulk assignment in one notice', async () => {
    const ops: Op[] = Array.from({ length: 8 }, (_, i) => ({
      type: 'task.add',
      task: newTask({ title: `t${i}`, assignees: [ids.bob!] }),
    }));
    await submit(ann, { type: 'batch', ops });
    const b = await inbox(bob);
    expect(b.notifications).toHaveLength(1);
    expect(b.notifications[0]).toMatchObject({
      kind: 'summary',
      taskId: null,
      text: 'assigned you 8 tasks',
    });
  });

  it('pushes notices to every socket the person has open', async () => {
    const got: unknown[] = [];
    app.channels.add(ids.bob!, 'sock1', (m) => got.push(m));
    await submit(ann, { type: 'task.add', task: newTask({ assignees: [ids.bob!] }) });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ t: 'notify', notification: { kind: 'assigned' } });
    app.channels.remove(ids.bob!, 'sock1');
    await submit(ann, { type: 'task.add', task: newTask({ assignees: [ids.bob!] }) });
    expect(got).toHaveLength(1);
  });

  it('keeps each inbox bounded, dropping the oldest', async () => {
    for (let i = 0; i < NOTIFICATIONS_KEPT + 5; i++)
      app.db.run(
        "INSERT INTO notifications (id, user_id, case_id, task_id, seq, kind, actor_id, actor_name, text, created_at) VALUES (?,?,?,NULL,1,'updated','x','X','t',?)",
        `n${String(i).padStart(4, '0')}`,
        ids.bob!,
        caseId,
        new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      );
    pruneNotifications(app.db, ids.bob!);
    const rows = app.db.all<{ id: string }>(
      'SELECT id FROM notifications WHERE user_id = ? ORDER BY id',
      ids.bob!,
    );
    expect(rows).toHaveLength(NOTIFICATIONS_KEPT);
    expect(rows[0]!.id).toBe('n0005');
  });

  it('rejects comments on tasks that do not exist, and edits to missing tasks', async () => {
    const c = await submit(ann, {
      type: 'comment.add',
      comment: {
        id: 'cm1',
        taskId: 'task_nope',
        authorId: ids.ann!,
        authorName: 'ANN',
        ts: '',
        text: 'x',
      },
    });
    expect(c.statusCode).toBe(404);
    const s = await submit(ann, { type: 'task.set', id: 'task_nope', patch: { title: 'x' } });
    expect(s.statusCode).toBe(404);
  });

  it('stops a viewer from changing tasks', async () => {
    const res = await submit(vic, { type: 'task.add', task: newTask() });
    expect(res.statusCode).toBe(403);
  });

  it('exports and imports tasks with the case file', async () => {
    const task = newTask();
    await submit(ann, { type: 'task.add', task });
    const file = (
      await app.inject({ method: 'GET', url: `/api/cases/${caseId}/export`, ...as(ann) })
    ).json();
    expect(file.tasks.map((t: Task) => t.id)).toEqual([task.id]);
    const other = await app.inject({
      method: 'POST',
      url: '/api/cases',
      ...as(ann),
      payload: { name: 'Second' },
    });
    const otherId = other.json().case.id as string;
    await app.inject({
      method: 'POST',
      url: `/api/cases/${otherId}/import`,
      ...as(ann),
      payload: { file },
    });
    const st = await app.inject({ method: 'GET', url: `/api/cases/${otherId}/state`, ...as(ann) });
    expect(Object.keys(st.json().state.tasks)).toEqual([task.id]);
  });

  it('loads a case whose snapshot was written before tasks existed', () => {
    const db = app.db;
    const old = { ...emptyState() } as Record<string, unknown>;
    delete old.tasks;
    delete old.comments;
    const seq = Number(db.get<{ seq: number }>('SELECT seq FROM cases WHERE id = ?', caseId)?.seq);
    db.run(
      'INSERT OR REPLACE INTO case_snapshots (case_id, seq, state, created_at) VALUES (?,?,?,?)',
      caseId,
      seq,
      JSON.stringify(old),
      '2026-01-01T00:00:00.000Z',
    );
    const rt = new CaseRuntime(db, caseId);
    expect(rt.state.tasks).toEqual({});
    const r = rt.appendOp(
      { id: ids.ann!, name: 'ANN' },
      { type: 'task.add', task: newTask() },
      { canEdit: true },
    );
    expect(r.ok).toBe(true);
  });
});
