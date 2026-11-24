import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import type { TaskOp } from '@midden/core';
import { addUser, as, login, testApp } from '../test/helpers.js';
import { findUserById } from '../auth/sessions.js';
import { loadTaskState } from './runtime.js';
import { rebuildTaskProjections } from './projection.js';

describe('tasks', () => {
  let app: FastifyInstance;
  let admin: string;
  let lead: string;
  let ann: string;
  let bob: string;
  let vic: string;
  const ids: Record<string, string> = {};
  let hostTeam: string;
  let netTeam: string;

  const call = async (
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
    return { status: res.statusCode, body: res.json() };
  };
  const ok = async (
    cookie: string,
    method: InjectOptions['method'],
    url: string,
    payload?: unknown,
  ) => {
    const r = await call(cookie, method, url, payload);
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body;
  };
  const op = (cookie: string, o: TaskOp) => call(cookie, 'POST', '/api/tasks/ops', { op: o });
  const create = async (cookie: string, body: Record<string, unknown>) =>
    (await ok(cookie, 'POST', '/api/tasks', body)).task;

  beforeEach(async () => {
    app = testApp();
    ids.admin = addUser(app, 'root', 'admin');
    ids.lead = addUser(app, 'lena');
    ids.ann = addUser(app, 'ann');
    ids.bob = addUser(app, 'bob');
    ids.vic = addUser(app, 'vic', 'viewer');
    await app.ready();
    [admin, lead, ann, bob, vic] = await Promise.all(
      ['root', 'lena', 'ann', 'bob', 'vic'].map((u) => login(app, u)),
    );
    hostTeam = (await ok(admin, 'POST', '/api/teams', { name: 'Host' })).team.id;
    netTeam = (await ok(admin, 'POST', '/api/teams', { name: 'Network' })).team.id;
    await ok(admin, 'PUT', `/api/teams/${hostTeam}/members/${ids.lead}`, { role: 'lead' });
    await ok(lead, 'PUT', `/api/teams/${hostTeam}/members/${ids.ann}`, { role: 'member' });
    await ok(admin, 'PUT', `/api/teams/${netTeam}/members/${ids.bob}`, { role: 'member' });
  });
  afterEach(async () => {
    await app.close();
  });

  describe('teams', () => {
    it('lets admins appoint leads and leads manage members, but not leads', async () => {
      const teams = (await ok(ann, 'GET', '/api/teams')).teams as {
        name: string;
        members: { username: string; role: string }[];
      }[];
      expect(teams.map((t) => t.name)).toEqual(['Host', 'Network']);
      expect(teams[0]!.members.map((m) => `${m.username}:${m.role}`)).toEqual([
        'lena:lead',
        'ann:member',
      ]);
      expect(
        (await call(lead, 'PUT', `/api/teams/${hostTeam}/members/${ids.bob}`, { role: 'lead' }))
          .status,
      ).toBe(403);
      expect(
        (await call(lead, 'PUT', `/api/teams/${netTeam}/members/${ids.ann}`, { role: 'member' }))
          .status,
      ).toBe(403);
      expect((await call(ann, 'POST', '/api/teams', { name: 'Mine' })).status).toBe(403);
      expect((await call(admin, 'POST', '/api/teams', { name: 'host' })).status).toBe(409);
      await ok(lead, 'DELETE', `/api/teams/${hostTeam}/members/${ids.ann}`);
      expect(
        (await call(lead, 'DELETE', `/api/teams/${hostTeam}/members/${ids.lead}`)).status,
      ).toBe(403);
    });
  });

  describe('basics', () => {
    it('creates, finds by number, changes status by name, comments and keeps history', async () => {
      const t = await create(ann, {
        title: 'Pull firewall logs',
        assignees: [ids.ann],
        teamId: hostTeam,
        checklist: ['Export', 'Hash'],
      });
      expect(t).toMatchObject({
        ref: 'T-1',
        category: 'todo',
        statusName: 'To do',
        createdBy: ids.ann,
        teamId: hostTeam,
      });
      expect(t.checklist).toHaveLength(2);
      const got = await ok(bob, 'GET', '/api/tasks/T-1');
      expect(got.task.id).toBe(t.id);
      const moved = await ok(bob, 'PATCH', `/api/tasks/1`, { status: 'In progress' });
      expect(moved.task).toMatchObject({ category: 'in_progress', statusId: 'st_doing' });
      await ok(bob, 'PATCH', `/api/tasks/${t.id}`, { status: 'done' });
      await ok(ann, 'POST', `/api/tasks/${t.id}/comments`, { body: 'Done, see T-1' });
      const hist = (await ok(ann, 'GET', `/api/tasks/${t.id}/history`)).ops as {
        type: string;
        actor: { name: string };
      }[];
      // Creating is logged with the creator's auto-follow; Ann already follows when she comments.
      expect(hist.map((h) => h.type)).toEqual(['batch', 'task.set', 'task.set', 'comment.add']);
      expect(hist[1]!.actor.name).toBe('BOB');
      expect((await ok(ann, 'GET', `/api/tasks/${t.id}`)).comments[0]).toMatchObject({
        body: 'Done, see T-1',
        authorId: ids.ann,
      });
      expect((await call(ann, 'PATCH', `/api/tasks/${t.id}`, { status: 'Nope' })).status).toBe(400);
      expect((await call(ann, 'GET', '/api/tasks/T-99')).status).toBe(404);
    });

    it('lists with filters', async () => {
      await create(ann, { title: 'Mine', assignees: [ids.ann] });
      await create(ann, {
        title: 'Network thing',
        teamId: netTeam,
        dueAt: '2020-01-01T00:00:00.000Z',
      });
      const done = await create(bob, { title: 'Finished', status: 'done' });
      const titles = async (q: string) =>
        ((await ok(ann, 'GET', `/api/tasks?${q}`)).tasks as { title: string }[]).map(
          (t) => t.title,
        );
      expect(await titles('mine=1')).toEqual(['Mine']);
      expect(await titles(`team=${netTeam}`)).toEqual(['Network thing']);
      expect(await titles('overdue=1')).toEqual(['Network thing']);
      expect(await titles('open=1')).toEqual(['Network thing', 'Mine']);
      expect(await titles('category=done')).toEqual(['Finished']);
      expect(await titles('q=network')).toEqual(['Network thing']);
      await ok(bob, 'PATCH', `/api/tasks/${done.id}`, { archived: true });
      expect(await titles('archived=only')).toEqual(['Finished']);
      expect(await titles('')).toEqual(['Network thing', 'Mine']);
    });

    it('undoes an operation, and the undo too', async () => {
      const t = await create(ann, { title: 'Original' });
      const r = await ok(ann, 'PATCH', `/api/tasks/${t.id}`, { title: 'Renamed' });
      const undo = await ok(bob, 'POST', '/api/tasks/revert', { seq: r.seq });
      expect((await ok(ann, 'GET', `/api/tasks/${t.id}`)).task.title).toBe('Original');
      await ok(ann, 'POST', '/api/tasks/revert', { seq: undo.seq });
      expect((await ok(ann, 'GET', `/api/tasks/${t.id}`)).task.title).toBe('Renamed');
    });

    it('refuses internal operations and dependency cycles', async () => {
      const a = await create(ann, { title: 'A' });
      const b = await create(ann, { title: 'B', blockedBy: ['T-1'] });
      expect(b.blockedBy).toEqual([a.id]);
      expect((await op(ann, { type: 'task.drop', id: a.id, nextNum: 1 })).status).toBe(400);
      const cyc = await op(ann, { type: 'dep.add', taskId: a.id, blockedById: b.id });
      expect(cyc.status).toBe(409);
      expect(cyc.body.error.message).toMatch(/cycle/);
    });

    it('does not let viewers change tasks', async () => {
      const t = await create(ann, { title: 'Read only' });
      const r = await call(vic, 'PATCH', `/api/tasks/${t.id}`, { title: 'x' });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('readonly');
      expect((await ok(vic, 'GET', '/api/tasks')).total).toBe(1);
    });
  });

  describe('approvals', () => {
    it('blocks done until the named approver approves', async () => {
      const t = await create(ann, { title: 'Accept the risk of WS-14', approverId: ids.lead });
      expect(t.approval).toMatchObject({
        approverId: ids.lead,
        state: 'pending',
        requestedBy: ids.ann,
      });
      const blocked = await call(ann, 'PATCH', `/api/tasks/${t.id}`, { status: 'done' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.message).toMatch(/needs approval/);
      const decide: TaskOp = {
        type: 'approval.decide',
        taskId: t.id,
        decision: 'approved',
        comment: 'Accepted until patch',
      };
      const notMine = await op(ann, decide);
      expect(notMine.status).toBe(403);
      expect(notMine.body.error.message).toMatch(/Only LENA/);
      await ok(lead, 'POST', '/api/tasks/ops', { op: decide });
      await ok(ann, 'PATCH', `/api/tasks/${t.id}`, { status: 'done' });
    });

    it('lets a viewer approve what they were named for, and nothing else', async () => {
      const t = await create(ann, { title: 'Commander sign-off', approverId: ids.vic });
      await ok(vic, 'POST', '/api/tasks/ops', {
        op: { type: 'approval.decide', taskId: t.id, decision: 'rejected', comment: 'No' },
      });
      expect((await ok(ann, 'GET', `/api/tasks/${t.id}`)).task.approval.state).toBe('rejected');
      expect(
        (
          await op(vic, {
            type: 'batch',
            ops: [
              { type: 'approval.decide', taskId: t.id, decision: 'approved', comment: '' },
              { type: 'task.set', id: t.id, patch: { title: 'x' } },
            ],
          })
        ).status,
      ).toBe(403);
    });

    it('never takes an approval from an API token', () => {
      const user = findUserById(app.db, ids.lead)!;
      const t = app.tasks.appendOp(
        { id: user.id, name: 'LENA' },
        {
          type: 'task.add',
          task: {
            id: 'tk_x',
            title: 'x',
            statusId: 'st_todo',
            description: '',
            priority: 'medium',
            runId: '',
            labels: [],
            dueAt: '',
            caseId: '',
            hostId: '',
            eventId: '',
          },
        },
        { user, viaToken: false },
      );
      expect(t.ok).toBe(true);
      app.tasks.appendOp(
        { id: user.id, name: 'LENA' },
        { type: 'approval.set', taskId: 'tk_x', approverId: user.id },
        { user, viaToken: false },
      );
      const r = app.tasks.appendOp(
        { id: user.id, name: 'LENA via agent', via: 'agent' },
        { type: 'approval.decide', taskId: 'tk_x', decision: 'approved', comment: '' },
        { user, viaToken: true },
      );
      expect(r).toMatchObject({
        ok: false,
        code: 'perm',
        message: expect.stringMatching(/browser session/),
      });
    });
  });

  describe('bulk assignment and runs', () => {
    it('keeps assigning many tasks at once to leads, within their teams', async () => {
      const a = await create(ann, { title: 'A' });
      const b = await create(ann, { title: 'B' });
      const bulk = (users: string[], teamId?: string): TaskOp => ({
        type: 'task.assign',
        ids: [a.id, b.id],
        mode: 'add',
        users,
        ...(teamId !== undefined ? { teamId } : {}),
      });
      // a single task: anyone may assign anyone
      await ok(ann, 'PATCH', `/api/tasks/${a.id}`, { assignees: [ids.vic] });
      const analyst = await op(ann, bulk([ids.ann]));
      expect(analyst.status).toBe(403);
      expect(analyst.body.error.message).toMatch(/team leads and admins/);
      const outsider = await op(lead, bulk([ids.bob]));
      expect(outsider.body.error.message).toMatch(/BOB isn't on a team you lead/);
      const otherTeam = await op(lead, bulk([ids.ann], netTeam));
      expect(otherTeam.body.error.message).toMatch(/team you don't lead/);
      await ok(lead, 'POST', '/api/tasks/ops', { op: bulk([ids.ann], hostTeam) });
      // a batch of single assigns is still a bulk assign
      const sneaky = await op(ann, {
        type: 'batch',
        ops: [
          { type: 'task.assign', ids: [a.id], mode: 'set', users: [] },
          { type: 'task.assign', ids: [b.id], mode: 'set', users: [] },
        ],
      });
      expect(sneaky.status).toBe(403);
      await ok(admin, 'POST', '/api/tasks/ops', { op: bulk([ids.bob], netTeam) });
    });

    it('starts runs for leads, each with its own workflow', async () => {
      expect(
        (await call(ann, 'POST', '/api/task-runs', { name: 'Acme hunt', teamId: hostTeam })).status,
      ).toBe(403);
      expect(
        (await call(lead, 'POST', '/api/task-runs', { name: 'Net hunt', teamId: netTeam })).status,
      ).toBe(403);
      const run = (
        await ok(lead, 'POST', '/api/task-runs', {
          name: 'Acme hunt',
          teamId: hostTeam,
          startDate: '2026-11-23',
        })
      ).run;
      expect(run).toMatchObject({
        name: 'Acme hunt',
        teamId: hostTeam,
        startDate: '2026-11-23T00:00:00.000Z',
        total: 0,
      });
      const wfs = (await ok(ann, 'GET', '/api/workflows')).workflows as { id: string }[];
      expect(wfs.map((w) => w.id)).toContain(run.workflowId);
      // the lead can reshape the run's workflow; an analyst can't, nor touch the default
      const statuses = [
        { id: 'st_todo', name: 'Queued', category: 'todo', color: '', wipLimit: null },
        { id: 'st_triage', name: 'Triage', category: 'in_progress', color: '', wipLimit: 2 },
        { id: 'st_done', name: 'Closed', category: 'done', color: '', wipLimit: null },
      ];
      expect(
        (await call(ann, 'PUT', `/api/workflows/${run.workflowId}`, { name: 'Hunt', statuses }))
          .status,
      ).toBe(403);
      await ok(lead, 'PUT', `/api/workflows/${run.workflowId}`, { name: 'Hunt', statuses });
      expect(
        (await call(lead, 'PUT', '/api/workflows/wf_default', { name: 'X', statuses })).status,
      ).toBe(403);
      const t = await create(ann, { title: 'In run', runId: run.id, status: 'Triage' });
      expect(t).toMatchObject({
        statusId: 'st_triage',
        statusName: 'Triage',
        category: 'in_progress',
      });
      const runs = (await ok(ann, 'GET', '/api/task-runs')).runs as {
        counts: Record<string, number>;
      }[];
      expect(runs[0]!.counts.in_progress).toBe(1);
      expect((await call(ann, 'PATCH', `/api/task-runs/${run.id}`, { closed: true })).status).toBe(
        403,
      );
      const closed = (await ok(lead, 'PATCH', `/api/task-runs/${run.id}`, { closed: true })).run;
      expect(closed.closed).toBe(true);
      expect(closed.closedAt).not.toBe('');
    });
  });

  describe('restricted cases', () => {
    let secret: string;
    beforeEach(async () => {
      secret = (await ok(ann, 'POST', '/api/cases', { name: 'Insider', restricted: true })).case.id;
    });

    it('hides linked tasks from everyone who cannot read the case', async () => {
      const t = await create(ann, { title: 'Interview the suspect', caseId: secret });
      await create(ann, { title: 'Public task' });
      expect(
        ((await ok(bob, 'GET', '/api/tasks')).tasks as { title: string }[]).map((x) => x.title),
      ).toEqual(['Public task']);
      expect((await call(bob, 'GET', `/api/tasks/${t.id}`)).status).toBe(404);
      expect(Object.keys((await ok(bob, 'GET', '/api/tasks/state')).state.tasks)).toHaveLength(1);
      const ops = (await ok(bob, 'GET', '/api/tasks/ops')).ops as { op: unknown }[];
      expect(JSON.stringify(ops)).not.toContain('Interview');
      expect((await op(bob, { type: 'task.set', id: t.id, patch: { title: 'x' } })).status).toBe(
        404,
      );
      expect((await call(bob, 'POST', '/api/tasks/revert', { seq: 1 })).status).toBe(404);
      // the admin and members see it
      expect((await ok(admin, 'GET', `/api/tasks/${t.id}`)).task.title).toBe(
        'Interview the suspect',
      );
      await ok(ann, 'PUT', `/api/cases/${secret}/members/${ids.bob}`, { role: 'editor' });
      expect((await ok(bob, 'GET', `/api/tasks/${t.id}`)).task.title).toBe('Interview the suspect');
    });

    it('refuses links, assignees and approvers who cannot see the case', async () => {
      expect((await call(bob, 'POST', '/api/tasks', { title: 'x', caseId: secret })).status).toBe(
        404,
      );
      const assign = await call(ann, 'POST', '/api/tasks', {
        title: 'x',
        caseId: secret,
        assignees: [ids.bob],
      });
      expect(assign.status).toBe(403);
      expect(assign.body.error.message).toMatch(/BOB cannot see this task's case/);
      const appr = await call(ann, 'POST', '/api/tasks', {
        title: 'x',
        caseId: secret,
        approverId: ids.bob,
      });
      expect(appr.body.error.message).toMatch(/cannot be its approver/);
      const t = await create(ann, { title: 'Was public', assignees: [ids.bob] });
      const move = await call(ann, 'PATCH', `/api/tasks/${t.id}`, { caseId: secret });
      expect(move.body.error.message).toMatch(/BOB cannot see/);
    });

    it('keeps tasks of a deleted case for admins only', async () => {
      const t = await create(ann, { title: 'Orphan', caseId: secret });
      await ok(admin, 'DELETE', `/api/cases/${secret}`);
      expect((await call(ann, 'GET', `/api/tasks/${t.id}`)).status).toBe(404);
      expect((await ok(admin, 'GET', `/api/tasks/${t.id}`)).task.title).toBe('Orphan');
    });
  });

  describe('storage', () => {
    it('reloads the same state from the log and keeps projections in step', async () => {
      const run = (await ok(lead, 'POST', '/api/task-runs', { name: 'R', teamId: hostTeam })).run;
      const a = await create(ann, {
        title: 'A',
        runId: run.id,
        assignees: [ids.ann],
        labels: ['x'],
      });
      const b = await create(ann, { title: 'B', blockedBy: [a.id], approverId: ids.lead });
      await ok(ann, 'POST', `/api/tasks/${a.id}/comments`, { body: 'hello' });
      await ok(ann, 'PATCH', `/api/tasks/${a.id}`, { status: 'In progress' });
      await ok(ann, 'PATCH', `/api/tasks/${a.id}`, { status: 'Done' });
      await ok(bob, 'POST', '/api/tasks/ops', {
        op: { type: 'task.follow', id: b.id, userId: ids.bob, on: true },
      });

      expect(loadTaskState(app.db)).toEqual({ state: app.tasks.state, seq: app.tasks.seq });

      const dump = () => ({
        tasks: app.db.all(
          'SELECT id, num, title, status_id, category, run_id, team_id, approver_id, approval_state, done_at, data FROM tasks ORDER BY num',
        ),
        assignees: app.db.all('SELECT * FROM task_assignees ORDER BY task_id, user_id'),
        followers: app.db.all('SELECT * FROM task_followers ORDER BY task_id, user_id'),
        deps: app.db.all('SELECT * FROM task_deps ORDER BY task_id'),
        comments: app.db.all('SELECT * FROM task_comments ORDER BY id'),
        runs: app.db.all('SELECT * FROM task_runs ORDER BY id'),
      });
      const incremental = dump();
      rebuildTaskProjections(app.db, app.tasks.state, 'now');
      expect(dump()).toEqual(incremental);
      expect(incremental.tasks[0]).toMatchObject({ category: 'done', team_id: '' });
      expect(incremental.tasks[1]).toMatchObject({
        approver_id: ids.lead,
        approval_state: 'pending',
      });

      const transitions = app.db.all<{ to_category: string }>(
        'SELECT to_category FROM task_transitions WHERE task_id = ? ORDER BY id',
        a.id,
      );
      expect(transitions.map((x) => x.to_category)).toEqual(['todo', 'in_progress', 'done']);
    });
  });
});
