import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { applyTaskOp, type ServerMessage, type TaskState } from '@midden/core';
import { addUser, as, login, testApp } from '../test/helpers.js';
import { findUserById } from '../auth/sessions.js';

type Msg = Extract<ServerMessage, { t: 'tasks.op' | 'tasks.snapshot' }>;

/** A fake browser on the task channel that keeps its own copy of the state, as the web client does. */
class Mirror {
  msgs: Msg[] = [];
  state: TaskState | null = null;
  closed = false;
  constructor(
    readonly app: FastifyInstance,
    readonly id: string,
    userId: string,
  ) {
    app.taskChannel.join({
      id,
      user: findUserById(app.db, userId)!,
      send: (m) => {
        const msg = m as Msg;
        this.msgs.push(msg);
        if (msg.t === 'tasks.snapshot') this.state = msg.state;
        if (msg.t === 'tasks.op' && this.state) {
          let s = applyTaskOp(this.state, msg.op, { actorId: msg.actor.id, ts: msg.ts });
          if (msg.show) {
            s = { ...s, tasks: { ...s.tasks }, comments: { ...s.comments } };
            for (const t of msg.show.tasks) s.tasks[t.id] = t;
            for (const c of msg.show.comments) s.comments[c.id] = c;
          }
          if (msg.hide) {
            s = { ...s, tasks: { ...s.tasks } };
            for (const id of msg.hide) delete s.tasks[id];
          }
          this.state = s;
        }
      },
      close: () => {
        this.closed = true;
      },
    });
  }
  titles(): string[] {
    return Object.values(this.state!.tasks)
      .map((t) => `${t.num}:${t.title}`)
      .sort();
  }
  last(): Msg {
    return this.msgs.at(-1)!;
  }
}

describe('task channel', () => {
  let app: FastifyInstance;
  let ann: string;
  let admin: string;
  const ids: Record<string, string> = {};
  let secret: string;

  const ok = async (
    cookie: string,
    method: InjectOptions['method'],
    url: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({
      method,
      url,
      ...as(cookie),
      ...(payload !== undefined ? { payload } : {}),
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json();
  };

  beforeEach(async () => {
    app = testApp();
    ids.root = addUser(app, 'root', 'admin');
    ids.ann = addUser(app, 'ann');
    ids.bob = addUser(app, 'bob');
    await app.ready();
    admin = await login(app, 'root');
    ann = await login(app, 'ann');
    secret = (await ok(ann, 'POST', '/api/cases', { name: 'Insider', restricted: true })).case.id;
  });
  afterEach(async () => {
    await app.close();
  });

  it('keeps every viewer in step with what they may see, numbers included', async () => {
    const a = new Mirror(app, 'c_ann', ids.ann);
    const b = new Mirror(app, 'c_bob', ids.bob);
    expect(b.last()).toMatchObject({ t: 'tasks.snapshot', directory: { cases: [] } });
    expect(a.last()).toMatchObject({
      t: 'tasks.snapshot',
      directory: { cases: [{ name: 'Insider' }] },
    });

    // one batch: a secret task, then a public one. Bob must still see the public one as T-2.
    await ok(admin, 'POST', '/api/tasks/ops', {
      op: {
        type: 'batch',
        ops: [
          {
            type: 'task.add',
            task: { id: 'tk_s', title: 'Secret', statusId: 'st_todo', caseId: secret },
          },
          { type: 'task.add', task: { id: 'tk_p', title: 'Public', statusId: 'st_todo' } },
          { type: 'task.assign', ids: ['tk_s', 'tk_p'], mode: 'add', users: [ids.ann] },
        ],
      },
    });
    expect(a.titles()).toEqual(['1:Secret', '2:Public']);
    expect(b.titles()).toEqual(['2:Public']);
    expect(JSON.stringify(b.last())).not.toContain('Secret');
    expect(b.state!.tasks.tk_p!.assignees).toEqual([ids.ann]);

    // a change Bob can't see reaches him as a noop, so his seq still advances
    await ok(ann, 'PATCH', '/api/tasks/tk_s', { title: 'Still secret' });
    expect(b.last()).toMatchObject({ t: 'tasks.op', op: { type: 'noop' } });
    expect(JSON.stringify(b.last())).not.toContain('secret');

    // moving the public task into the restricted case hides it from him
    await ok(ann, 'POST', '/api/tasks/tk_p/comments', { body: 'about to move' });
    await ok(ann, 'PATCH', '/api/tasks/tk_p', { caseId: secret });
    expect(b.last()).toMatchObject({ hide: ['tk_p'] });
    expect(b.titles()).toEqual([]);

    // and moving it back shows it again, comments and all
    await ok(ann, 'PATCH', '/api/tasks/tk_p', { caseId: '' });
    expect(b.last().t === 'tasks.op' && b.last()).toMatchObject({
      show: { tasks: [{ id: 'tk_p' }], comments: [{ body: 'about to move' }] },
    });
    expect(b.titles()).toEqual(['2:Public']);

    // and both mirrors agree with the server, task for task, wherever they can see
    const server = app.tasks.state;
    expect(a.state!.tasks).toEqual(server.tasks);
    expect(b.state!.tasks.tk_p).toEqual(server.tasks.tk_p);
  });

  it('learns about a case created after it joined', async () => {
    const a = new Mirror(app, 'c_ann', ids.ann);
    const b = new Mirror(app, 'c_bob', ids.bob);
    const open = (await ok(ann, 'POST', '/api/cases', { name: 'Phish', restricted: false })).case
      .id as string;
    const fresh = (await ok(ann, 'POST', '/api/cases', { name: 'Badge', restricted: true })).case
      .id as string;
    expect(a.state!.tasks).toEqual({});
    await ok(ann, 'POST', '/api/tasks', { title: 'Open case work', caseId: open });
    await ok(ann, 'POST', '/api/tasks', { title: 'Badge office', caseId: fresh });
    // The owner sees both; Bob sees the open case's task and not the restricted one.
    expect(a.titles()).toEqual(['1:Open case work', '2:Badge office']);
    expect(b.titles()).toEqual(['1:Open case work']);
  });

  it('drops archived tasks and closed runs from the live set', async () => {
    const b = new Mirror(app, 'c_bob', ids.bob);
    const t = (await ok(ann, 'POST', '/api/tasks', { title: 'Old news' })).task;
    expect(b.titles()).toEqual(['1:Old news']);
    await ok(ann, 'PATCH', `/api/tasks/${t.id}`, { archived: true });
    expect(b.last()).toMatchObject({ hide: [t.id] });
    await ok(ann, 'PATCH', `/api/tasks/${t.id}`, { archived: false });
    expect(b.titles()).toEqual(['1:Old news']);

    const team = (await ok(admin, 'POST', '/api/teams', { name: 'Host' })).team.id;
    const run = (await ok(admin, 'POST', '/api/task-runs', { name: 'R', teamId: team })).run;
    await ok(ann, 'POST', '/api/tasks', { title: 'In run', runId: run.id });
    expect(b.titles()).toEqual(['1:Old news', '2:In run']);
    await ok(admin, 'PATCH', `/api/task-runs/${run.id}`, { closed: true });
    expect(b.titles()).toEqual(['1:Old news']);
    await ok(admin, 'PATCH', `/api/task-runs/${run.id}`, { closed: false });
    expect(b.titles()).toEqual(['1:Old news', '2:In run']);
  });

  it('resends snapshots when access changes, and drops disabled users', async () => {
    await ok(ann, 'POST', '/api/tasks', { title: 'Secret', caseId: secret });
    const b = new Mirror(app, 'c_bob', ids.bob);
    expect(b.titles()).toEqual([]);
    await ok(ann, 'PUT', `/api/cases/${secret}/members/${ids.bob}`, { role: 'viewer' });
    expect(b.last().t).toBe('tasks.snapshot');
    expect(b.titles()).toEqual(['1:Secret']);
    await ok(admin, 'POST', '/api/teams', { name: 'Network' });
    expect(b.last()).toMatchObject({
      t: 'tasks.snapshot',
      directory: { teams: [{ name: 'Network' }] },
    });
    await ok(admin, 'PATCH', `/api/users/${ids.bob}`, { disabled: true });
    expect(b.closed).toBe(true);
    expect(app.taskChannel.has('c_bob')).toBe(false);
  });
});
