import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { parseCsv } from '@midden/core';
import { addUser, as, login, testApp } from '../test/helpers.js';
import { withStatuses } from './playbookRoutes.js';

const CSV = [
  'key,title,status,priority,assignees,labels,due,blocked_by,checklist,approver',
  'a,Baseline DNS,,high,ann,dns,+1d,,Pull logs;[x] Check resolvers,',
  'b,Hunt beacons,Triage,,,,+2d,a,,',
  'c,Accept risk on legacy box,,,,,,,,root',
].join('\n');

describe('playbooks, import and export', () => {
  let app: FastifyInstance;
  const c: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const call = async (
    who: string,
    method: InjectOptions['method'],
    url: string,
    payload?: unknown,
  ) => {
    const res = await app.inject({
      method,
      url,
      ...as(c[who]!),
      ...(payload !== undefined ? { payload } : {}),
    });
    const text = res.body;
    return {
      status: res.statusCode,
      headers: res.headers,
      text,
      body: res.headers['content-type']?.toString().startsWith('application/json')
        ? res.json()
        : null,
    };
  };
  const ok = async (who: string, method: InjectOptions['method'], url: string, p?: unknown) => {
    const r = await call(who, method, url, p);
    expect(r.status, r.text).toBeLessThan(300);
    return r.body;
  };

  beforeEach(async () => {
    app = testApp();
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
    await ok('root', 'PUT', `/api/teams/${ids.host}/members/${ids.ann}`, { role: 'member' });
    await ok('root', 'PUT', `/api/teams/${ids.net}/members/${ids.bob}`, { role: 'member' });
  });
  afterEach(async () => {
    await app.close();
  });

  it('keeps playbooks per team: leads change their own, admins the shared ones', async () => {
    const created = await call('lena', 'POST', '/api/playbooks', {
      name: 'Kickoff',
      teamId: ids.host,
      csv: CSV,
    });
    expect(created.status).toBe(201);
    const pb = created.body.playbook;
    expect(pb).toMatchObject({ name: 'Kickoff', teamId: ids.host, version: 1, rows: 3 });

    expect(
      (await call('ann', 'POST', '/api/playbooks', { name: 'X', teamId: ids.host, csv: CSV }))
        .status,
    ).toBe(403);
    expect((await call('lena', 'POST', '/api/playbooks', { name: 'X', csv: CSV })).status).toBe(
      403,
    );
    expect(
      (await call('lena', 'PATCH', `/api/playbooks/${pb.id}`, { teamId: ids.net })).status,
    ).toBe(403);
    const bad = await call('lena', 'POST', '/api/playbooks', {
      name: 'Bad',
      teamId: ids.host,
      csv: 'title,priority\nOne,whenever',
    });
    expect(bad.status).toBe(400);
    expect(bad.text).toMatch(/line 2: Priority \\"whenever\\"/);

    // Renames keep the version; content changes bump it.
    expect(
      (await ok('lena', 'PATCH', `/api/playbooks/${pb.id}`, { name: 'Kick-off' })).playbook.version,
    ).toBe(1);
    expect(
      (await ok('lena', 'PATCH', `/api/playbooks/${pb.id}`, { csv: `${CSV}\nd,One more,,,,,,,,` }))
        .playbook,
    ).toMatchObject({ version: 2, rows: 4 });
    expect((await ok('vic', 'GET', `/api/playbooks/${pb.id}`)).playbook.csv).toContain('One more');
    expect((await ok('ann', 'GET', '/api/playbooks')).playbooks).toHaveLength(1);
    expect((await call('ann', 'DELETE', `/api/playbooks/${pb.id}`)).status).toBe(403);
    await ok('root', 'DELETE', `/api/playbooks/${pb.id}`);
  });

  it('previews an import without changing anything, then commits it as one undoable op', async () => {
    const pb = (
      await ok('lena', 'POST', '/api/playbooks', { name: 'Kickoff', teamId: ids.host, csv: CSV })
    ).playbook;
    const body = {
      playbookId: pb.id,
      run: { name: 'Hunt 7', teamId: ids.host, startDate: '2026-11-02T08:00:00Z' },
    };
    const before = (await ok('lena', 'GET', '/api/tasks/state')).seq;

    let p = await ok('lena', 'POST', '/api/tasks/import?preview=1', body);
    expect(p.ok).toBe(false);
    expect(p.unknownStatuses).toEqual(['Triage']);
    // shown as written, not as the status it would fall back to
    expect(p.tasks[1]).toMatchObject({ key: 'b', status: 'Triage' });
    expect(p.issues).toEqual([
      {
        line: 3,
        severity: 'error',
        message: 'Status "Triage" is not in workflow "Hunt 7 workflow"',
      },
    ]);
    expect((await call('lena', 'POST', '/api/tasks/import', body)).status).toBe(400);

    const fixed = { ...body, addStatuses: [{ name: 'Triage', category: 'in_progress' }] };
    p = await ok('lena', 'POST', '/api/tasks/import?preview=1', fixed);
    expect(p.ok).toBe(true);
    expect(p.workflow.statuses.map((s: { name: string }) => s.name)).toEqual([
      'Backlog',
      'To do',
      'In progress',
      'Triage',
      'Blocked',
      'Done',
      'Cancelled',
    ]);
    expect(p.tasks).toMatchObject([
      {
        key: 'a',
        title: 'Baseline DNS',
        status: 'To do',
        assignees: ['ANN'],
        team: 'Host',
        dueAt: '2026-11-03T08:00:00.000Z',
        checklist: 2,
      },
      { key: 'b', status: 'Triage', blockedBy: ['a'] },
      { key: 'c', approver: 'ROOT' },
    ]);
    expect((await ok('lena', 'GET', '/api/tasks/state')).seq).toBe(before);

    const done = await call('lena', 'POST', '/api/tasks/import', fixed);
    expect(done.status).toBe(201);
    expect(done.body).toMatchObject({
      created: 3,
      run: { name: 'Hunt 7', playbookId: pb.id, total: 3 },
    });
    const { tasks } = await ok('lena', 'GET', `/api/tasks?run=${done.body.run.id}`);
    const byTitle = Object.fromEntries(tasks.map((t: { title: string }) => [t.title, t]));
    expect(byTitle['Baseline DNS'].checklist.map((i: { done: boolean }) => i.done)).toEqual([
      false,
      true,
    ]);
    expect(byTitle['Hunt beacons'].blockedBy).toEqual([byTitle['Baseline DNS'].id]);
    expect(byTitle['Accept risk on legacy box'].approval).toMatchObject({ state: 'pending' });

    // The whole import is one op: undoing it removes run, workflow and tasks.
    await ok('lena', 'POST', '/api/tasks/revert', { seq: done.body.seq });
    expect((await ok('lena', 'GET', `/api/tasks?run=${done.body.run.id}`)).total).toBe(0);
  });

  it('takes a lead of the run’s team, and holds bulk assignment to that team', async () => {
    const csv = 'title,assignees\nOne,ann\nTwo,bob';
    const run = { name: 'R', teamId: ids.host };
    expect((await call('ann', 'POST', '/api/tasks/import?preview=1', { csv, run })).status).toBe(
      403,
    );
    expect((await call('vic', 'POST', '/api/tasks/import?preview=1', { csv, run })).status).toBe(
      403,
    );
    expect(
      (
        await call('lena', 'POST', '/api/tasks/import?preview=1', {
          csv,
          run: { name: 'R', teamId: ids.net },
        })
      ).status,
    ).toBe(403);
    const p = await ok('lena', 'POST', '/api/tasks/import?preview=1', { csv, run });
    expect(p.ok).toBe(false);
    expect(p.issues).toEqual([
      {
        line: 0,
        severity: 'error',
        message: "BOB isn't on a team you lead, so can't be bulk-assigned",
      },
    ]);
    // An admin may.
    expect((await call('root', 'POST', '/api/tasks/import', { csv, run })).status).toBe(201);
  });

  it('flags unknown and disabled people, bad rows and oversized batches up front', async () => {
    await ok('root', 'PATCH', `/api/users/${ids.bob}`, { disabled: true });
    const csv =
      'key,title,assignees,approver,blocked_by,case\na,One,bob,nobody,b,CASE-9\nb,Two,,,a,';
    const p = await ok('root', 'POST', '/api/tasks/import?preview=1', { csv, run: { name: 'R' } });
    expect(
      p.issues.map((i: { line: number; message: string }) => `${i.line} ${i.message}`),
    ).toEqual([
      '2 Dependency cycle: a → b → a',
      '2 BOB is disabled',
      '2 Unknown case "CASE-9"',
      '2 Unknown approver "nobody"',
    ]);
  });

  it('adds to an existing run, using and extending its workflow', async () => {
    const run = (await ok('lena', 'POST', '/api/task-runs', { name: 'Hunt 8', teamId: ids.host }))
      .run;
    const r = await call('lena', 'POST', '/api/tasks/import', {
      csv: 'title,status\nLate add,Waiting on owner',
      runId: run.id,
      addStatuses: [{ name: 'Waiting on owner', category: 'blocked' }],
    });
    expect(r.status, r.text).toBe(201);
    const wf = (await ok('lena', 'GET', '/api/workflows')).workflows.find(
      (w: { id: string }) => w.id === run.workflowId,
    );
    expect(wf.statuses.map((s: { name: string }) => s.name)).toContain('Waiting on owner');
    const t = (await ok('lena', 'GET', `/api/tasks?run=${run.id}`)).tasks[0];
    expect(t).toMatchObject({
      statusName: 'Waiting on owner',
      category: 'blocked',
      teamId: ids.host,
    });
  });

  it('exports in the import format, round-trips, and leaves out what you can’t see', async () => {
    const secret = (await ok('ann', 'POST', '/api/cases', { name: 'Insider', restricted: true }))
      .case.id;
    const run = (
      await ok('lena', 'POST', '/api/tasks/import', {
        csv: CSV.replace('Triage', 'In progress'),
        run: { name: 'Hunt 9', teamId: ids.host, startDate: '2026-11-02T08:00:00Z' },
      })
    ).run;
    const listed = (await ok('ann', 'GET', `/api/tasks?run=${run.id}`)).tasks;
    const dns = listed.find((t: { title: string }) => t.title === 'Baseline DNS');
    await ok('ann', 'PATCH', `/api/tasks/${dns.id}`, { caseId: secret });
    await ok('ann', 'POST', `/api/tasks/${dns.id}/comments`, { body: '=HYPERLINK("x") found it' });

    const mine = await call('ann', 'GET', `/api/tasks/export?run=${run.id}&comments=1`);
    expect(mine.status).toBe(200);
    expect(mine.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(mine.headers['content-disposition']).toMatch(
      /^attachment; filename="hunt-9-\d{4}-\d\d-\d\d\.csv"$/,
    );
    const rows = parseCsv(mine.text).map((r) => r.cells);
    expect(rows[0]).toEqual([
      'key',
      'title',
      'description',
      'status',
      'priority',
      'assignees',
      'team',
      'labels',
      'due',
      'blocked_by',
      'checklist',
      'approver',
      'case',
      'id',
      'created',
      'completed',
      'approval_state',
      'approval_comment',
      'comments',
    ]);
    expect(rows).toHaveLength(4);
    expect(mine.text).toContain('[x] Check resolvers');

    // Lena can't read the restricted case, so its task isn't in her export.
    const hers = await call('lena', 'GET', `/api/tasks/export?run=${run.id}&due=relative&state=0`);
    const hrows = parseCsv(hers.text).map((r) => r.cells);
    expect(hrows.map((r) => r[1])).toEqual(['title', 'Hunt beacons', 'Accept risk on legacy box']);
    // Cells starting + - = @ are guarded against spreadsheet formulas; import strips the guard.
    expect(hrows[1]![8]).toBe("'+2d");
    expect(hrows[0]).toHaveLength(13);
    expect(hers.text).not.toContain('Baseline DNS');

    // Re-importing Lena's export reproduces what she could see.
    const again = await call('lena', 'POST', '/api/tasks/import', {
      csv: hers.text,
      run: { name: 'Hunt 10', teamId: ids.host, startDate: '2026-12-01T00:00:00Z' },
    });
    expect(again.status, again.text).toBe(201);
    expect(again.body.created).toBe(2);
    expect((await call('lena', 'GET', '/api/tasks/export?due=relative')).status).toBe(400);
  });

  it('saves a run as a playbook, fresh for the next hunt', async () => {
    const secret = (await ok('lena', 'POST', '/api/cases', { name: 'Insider', restricted: true }))
      .case.id;
    const run = (
      await ok('lena', 'POST', '/api/tasks/import', {
        csv: CSV.replace('Triage', 'Done'),
        run: { name: 'Hunt 11', teamId: ids.host, startDate: '2026-11-02T08:00:00Z' },
      })
    ).run;
    const { tasks } = await ok('root', 'GET', `/api/tasks?run=${run.id}`);
    const risk = tasks.find((t: { title: string }) => t.title.startsWith('Accept'));
    await ok('root', 'PATCH', `/api/tasks/${risk.id}`, { caseId: secret });

    expect((await call('ann', 'POST', `/api/task-runs/${run.id}/playbook`, {})).status).toBe(403);
    const saved = await ok('lena', 'POST', `/api/task-runs/${run.id}/playbook`, {
      name: 'Kickoff v2',
    });
    expect(saved.skipped).toBe(1);
    expect(saved.playbook).toMatchObject({ name: 'Kickoff v2', teamId: ids.host, rows: 2 });
    expect(saved.playbook.statuses.length).toBeGreaterThan(0);
    const csv = (await ok('lena', 'GET', `/api/playbooks/${saved.playbook.id}`)).playbook
      .csv as string;
    const rows = parseCsv(csv).map((r) => r.cells);
    expect(rows[0]).toHaveLength(13);
    expect(rows.slice(1).map((r) => [r[1], r[3], r[5], r[8], r[10]])).toEqual([
      ['Baseline DNS', '', '', "'+1d", 'Pull logs; Check resolvers'],
      ['Hunt beacons', '', '', "'+2d", ''],
    ]);
  });
});

describe('withStatuses', () => {
  it('slots new statuses in after their category and keeps ids unique', () => {
    const base = [
      { id: 'st_todo', name: 'To do', category: 'todo' as const, color: '', wipLimit: null },
      { id: 'st_done', name: 'Done', category: 'done' as const, color: '', wipLimit: null },
    ];
    const out = withStatuses(base, [
      { name: 'Review', category: 'in_progress' },
      { name: 'to do', category: 'todo' },
      { name: 'Done!', category: 'done' },
      { name: 'Backlog', category: 'backlog' },
    ]);
    expect(out.map((s) => `${s.id}:${s.category}`)).toEqual([
      'st_backlog:backlog',
      'st_todo:todo',
      'st_review:in_progress',
      'st_done:done',
      'st_done_2:done',
    ]);
  });
});
