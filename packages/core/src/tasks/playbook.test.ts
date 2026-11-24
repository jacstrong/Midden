import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { guardCell, joinList, parseCsv, splitList, unguardCell, writeCsv } from './csv.js';
import {
  exportTasksCsv,
  formatRelative,
  parseDue,
  parsePlaybookCsv,
  planImport,
  type ImportDirectory,
} from './playbook.js';
import { applyTaskOp, checkTaskOp, emptyTaskState, statusOf } from './reducer.js';
import { mentionsIn, taskRefsIn, tokenizeRefs } from './refs.js';
import type { TaskOp } from './ops.js';
import type { TaskState } from './types.js';

describe('csv', () => {
  it('reads quotes, embedded newlines, CRLF and a BOM', () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","he said ""hi""","line1\nline2"\r\n\r\nlast,,\n');
    expect(rows).toEqual([
      { line: 1, cells: ['a', 'b', 'c'] },
      { line: 2, cells: ['x, y', 'he said "hi"', 'line1\nline2'] },
      { line: 5, cells: ['last', '', ''] },
    ]);
  });

  it('round-trips any table', () => {
    const cell = fc.string({ unit: fc.constantFrom('a', ',', '"', '\n', '\r\n', ' ', 'é', ';') });
    fc.assert(
      fc.property(
        fc.array(fc.array(cell, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 5 }),
        (table) => {
          // a row that is a single empty cell is indistinguishable from a blank line
          const rows = table.filter((r) => !(r.length === 1 && r[0] === ''));
          const back = parseCsv(writeCsv(rows, { guard: false })).map((r) => r.cells);
          expect(back).toEqual(rows);
        },
      ),
    );
  });

  it('guards spreadsheet formulas and reverses the guard', () => {
    expect(guardCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(guardCell('+1d')).toBe("'+1d");
    expect(guardCell('plain')).toBe('plain');
    expect(unguardCell("'+1d")).toBe('+1d');
    expect(unguardCell("'quoted")).toBe("'quoted");
  });

  it('escapes list separators', () => {
    expect(splitList('a; b ;;c\\;d')).toEqual(['a', 'b', 'c;d']);
    expect(splitList(joinList(['x;y', 'back\\slash', 'z']))).toEqual(['x;y', 'back\\slash', 'z']);
  });
});

describe('due dates', () => {
  it('parses offsets and dates', () => {
    expect(parseDue('+1d4h')).toEqual({ kind: 'rel', ms: 28 * 3_600_000 });
    expect(parseDue('+2w')).toEqual({ kind: 'rel', ms: 14 * 86_400_000 });
    expect(parseDue('2026-12-01')).toEqual({ kind: 'abs', at: '2026-12-01T23:59:59.999Z' });
    expect(parseDue('2026-12-01T08:00:00Z')).toEqual({
      kind: 'abs',
      at: '2026-12-01T08:00:00.000Z',
    });
    expect(parseDue('')).toBeNull();
    expect(parseDue('tomorrow')).toBe('invalid');
    expect(parseDue('2026-13-45')).toBe('invalid');
  });

  it('formats offsets', () => {
    expect(formatRelative(28 * 3_600_000)).toBe('+1d4h');
    expect(formatRelative(90_000)).toBe('+2m');
    expect(formatRelative(-5)).toBe('+0m');
  });
});

const dir: ImportDirectory = {
  users: [
    { id: 'u_j', username: 'jstrong', displayName: 'Jacob' },
    { id: 'u_a', username: 'alee', displayName: 'Alex' },
  ],
  teams: [
    { id: 'tm_host', name: 'Host' },
    { id: 'tm_net', name: 'Network' },
  ],
  cases: [{ id: 'c1', name: 'Acme', number: 'HUNT-7' }],
};

const PLAYBOOK = [
  'key,title,description,status,priority,assignees,team,labels,due,blocked_by,checklist,approver,case',
  'recon,Pull firewall logs,"Last 30 days",todo,high,jstrong;alee,Network,logs,+1d,,Export;[x] Hash;Upload,,HUNT-7',
  'sweep,Sweep for PsExec,,,medium,,,lateral,+3d,recon,,alee,',
].join('\n');

let n = 0;
const newId = (p: string): string => `${p}_${++n}`;

function importInto(s: TaskState, text: string): { s: TaskState; ops: TaskOp[] } {
  const { rows, issues } = parsePlaybookCsv(text);
  expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  const plan = planImport(rows, {
    directory: dir,
    workflow: s.workflows[s.defaultWorkflowId]!,
    runId: '',
    startDate: '2026-11-23T00:00:00.000Z',
    defaultTeamId: 'tm_host',
    newId,
  });
  expect(plan.issues.filter((i) => i.severity === 'error')).toEqual([]);
  const op: TaskOp = { type: 'batch', ops: plan.ops };
  const ctx = { actorId: 'u_j', ts: '2026-11-23T09:00:00.000Z' };
  expect(checkTaskOp(s, op, ctx)).toBeNull();
  return { s: applyTaskOp(s, op, ctx), ops: plan.ops };
}

describe('playbook import', () => {
  it('imports tasks with people, teams, deps, checklists, approvers and cases', () => {
    const { s } = importInto(emptyTaskState(), PLAYBOOK);
    const [recon, sweep] = Object.values(s.tasks).sort((a, b) => a.num - b.num);
    expect(recon).toMatchObject({
      title: 'Pull firewall logs',
      priority: 'high',
      assignees: ['u_j', 'u_a'],
      teamId: 'tm_net',
      labels: ['logs'],
      dueAt: '2026-11-24T00:00:00.000Z',
      caseId: 'c1',
    });
    expect(recon!.checklist.map((c) => [c.text, c.done])).toEqual([
      ['Export', false],
      ['Hash', true],
      ['Upload', false],
    ]);
    expect(sweep).toMatchObject({ teamId: 'tm_host', blockedBy: [recon!.id] });
    expect(sweep!.approval).toMatchObject({ approverId: 'u_a', state: 'pending' });
    expect(statusOf(s, sweep!)?.category).toBe('todo');
  });

  it('reports every problem with its line', () => {
    const { rows, issues } = parsePlaybookCsv(
      [
        'key,title,priority,due,blocked_by,extra',
        'a,,urgent,+1d,b,',
        'a,Dup key,meh,soon,,',
        'b,Bee,,,a,',
      ].join('\n'),
    );
    const msgs = issues.map((i) => `${i.line}:${i.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        '1:Ignoring unknown column "extra"',
        '2:Title is empty',
        '3:Key "a" is also used on line 2',
        '3:Priority "meh" is not one of urgent, high, medium, low',
        '3:Due "soon" is not a date or an offset like +2d',
      ]),
    );
    expect(msgs.some((m) => m.includes('Dependency cycle'))).toBe(true);
    const plan = planImport(
      [
        {
          ...rows[0]!,
          title: 'x',
          assignees: ['nobody'],
          team: 'Ghosts',
          status: 'Waiting',
          case: 'nope',
        },
      ],
      {
        directory: dir,
        workflow: emptyTaskState().workflows.wf_default!,
        runId: '',
        startDate: '',
        defaultTeamId: '',
        newId,
      },
    );
    expect(plan.issues.map((i) => i.message)).toEqual([
      'Status "Waiting" is not in workflow "Default"',
      'Unknown user "nobody"',
      'Unknown team "Ghosts"',
      'Unknown case "nope"',
    ]);
    expect(plan.unknownStatuses).toEqual(['Waiting']);
  });

  it('needs a title column', () => {
    expect(parsePlaybookCsv('name,status\nx,todo').issues[0]?.message).toMatch(/no "title" column/);
    expect(parsePlaybookCsv('').issues[0]?.message).toMatch(/empty/);
  });
});

describe('playbook export', () => {
  const exportOpts = (s: TaskState) => ({
    users: new Map(dir.users.map((u) => [u.id, u])),
    teams: new Map(dir.teams.map((t) => [t.id, t])),
    cases: new Map(dir.cases.map((c) => [c.id, c])),
    statusName: (t: TaskState['tasks'][string]) => statusOf(s, t)?.name ?? '',
  });

  it('exports in the import format, and re-imports to the same tasks', () => {
    const { s } = importInto(emptyTaskState(), PLAYBOOK);
    const csv = exportTasksCsv(Object.values(s.tasks), {
      ...exportOpts(s),
      relativeTo: '2026-11-23T00:00:00.000Z',
    });
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(
      'key,title,description,status,priority,assignees,team,labels,due,blocked_by,checklist,approver,case,id,created,completed,approval_state,approval_comment',
    );
    expect(lines[1]).toContain(
      `T-1,Pull firewall logs,Last 30 days,To do,high,jstrong; alee,Network,logs,'+1d,,Export; [x] Hash; Upload,,HUNT-7,T-1`,
    );

    const { s: again } = importInto(emptyTaskState(), csv);
    const strip = (st: TaskState) =>
      Object.values(st.tasks)
        .sort((a, b) => a.num - b.num)
        .map((t) => ({
          title: t.title,
          description: t.description,
          statusId: t.statusId,
          priority: t.priority,
          assignees: t.assignees,
          teamId: t.teamId,
          labels: t.labels,
          dueAt: t.dueAt,
          caseId: t.caseId,
          deps: t.blockedBy.map((b) => st.tasks[b]!.num),
          checklist: t.checklist.map((c) => [c.text, c.done]),
          approver: t.approval?.approverId ?? '',
        }));
    expect(strip(again)).toEqual(strip(s));
  });

  it('includes comments when asked, and drops approvers from done tasks on re-import', () => {
    let { s } = importInto(emptyTaskState(), PLAYBOOK);
    const sweep = Object.values(s.tasks).find((t) => t.title === 'Sweep for PsExec')!;
    const ctx = { actorId: 'u_a', ts: '2026-11-24T00:00:00.000Z' };
    for (const op of [
      { type: 'comment.add', comment: { id: 'cm1', taskId: sweep.id, body: 'Found one on WS-14' } },
      { type: 'approval.decide', taskId: sweep.id, decision: 'approved', comment: 'Accepted' },
      { type: 'task.set', id: sweep.id, patch: { statusId: 'st_done' } },
    ] satisfies TaskOp[])
      s = applyTaskOp(s, op, ctx);
    const csv = exportTasksCsv(Object.values(s.tasks), {
      ...exportOpts(s),
      comments: new Map([[sweep.id, [s.comments.cm1!]]]),
    });
    expect(csv).toContain('approved,Accepted,Alex (2026-11-24T00:00:00.000Z): Found one on WS-14');
    const { rows } = parsePlaybookCsv(csv);
    const plan = planImport(rows, {
      directory: dir,
      workflow: s.workflows.wf_default!,
      runId: '',
      startDate: '',
      defaultTeamId: '',
      newId,
    });
    expect(plan.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        message: expect.stringMatching(/without approver "alee"/),
      }),
    ]);
  });
});

describe('refs', () => {
  it('finds task numbers, links and mentions', () => {
    const t = tokenizeRefs(
      'See T-12 and https://x.mil/a?b=1. cc @jstrong, @jane.doe@af.mil; not XT-3 or a@b',
    );
    expect(t.filter((x) => x.kind !== 'text')).toEqual([
      { kind: 'task', text: 'T-12', num: 12 },
      { kind: 'url', text: 'https://x.mil/a?b=1', href: 'https://x.mil/a?b=1' },
      { kind: 'mention', text: '@jstrong', username: 'jstrong' },
      { kind: 'mention', text: '@jane.doe@af.mil', username: 'jane.doe@af.mil' },
    ]);
    expect(t.map((x) => x.text).join('')).toBe(
      'See T-12 and https://x.mil/a?b=1. cc @jstrong, @jane.doe@af.mil; not XT-3 or a@b',
    );
    expect(mentionsIn('@A @a @b')).toEqual(['a', 'b']);
    expect(taskRefsIn('T-1, T-2 and T-1')).toEqual([1, 2]);
  });
});

describe('the CSV guide', () => {
  it('has an example that imports cleanly', async () => {
    const { readFileSync } = await import('node:fs');
    const guide = readFileSync(new URL('../../../../docs/tasks.md', import.meta.url), 'utf8');
    const csv = /```csv\n([\s\S]*?)```/.exec(guide)?.[1];
    expect(csv).toBeTruthy();
    const { rows, issues } = parsePlaybookCsv(csv!);
    expect(issues).toEqual([]);
    expect(rows.map((r) => r.key)).toEqual(['dns', 'base', 'smb', 'beac']);
    expect(rows[3]!.checklist).toEqual([
      { text: 'Pull NetFlow', done: true },
      { text: 'Run the jitter query', done: false },
    ]);
    expect(rows[3]!.due).toEqual({ kind: 'rel', ms: 36 * 3_600_000 });
    expect(rows[2]!.blockedBy).toEqual(['base']);
  });
});
