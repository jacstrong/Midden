import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  applyTaskOp,
  defaultViewConfig,
  emptyTaskState,
  type NewTask,
  type TaskDirectory,
  type TaskOp,
  type TaskState,
} from '@midden/core';
import { Board } from './Board';
import { BulkBar } from './BulkBar';
import { useTasks } from './TaskStore';
import { namesFor } from './shared';
import { statusUse, workflowSaveOp } from './WorkflowEditor';

const T0 = '2026-03-01T00:00:00.000Z';
const nt = (id: string, extra: Partial<NewTask> = {}): NewTask => ({
  id,
  title: `Task ${id}`,
  description: '',
  statusId: 'st_todo',
  priority: 'medium',
  runId: '',
  labels: [],
  dueAt: '',
  caseId: '',
  hostId: '',
  eventId: '',
  teamId: 'tm_host',
  ...extra,
});
const dir: TaskDirectory = {
  users: [
    { id: 'u_lena', username: 'lena', displayName: 'Lena', role: 'analyst', disabled: false },
    { id: 'u_ann', username: 'ann', displayName: 'Ann', role: 'analyst', disabled: false },
    { id: 'u_bob', username: 'bob', displayName: 'Bob', role: 'analyst', disabled: false },
  ],
  teams: [
    {
      id: 'tm_host',
      name: 'Host',
      description: '',
      members: [
        { userId: 'u_lena', role: 'lead' },
        { userId: 'u_ann', role: 'member' },
      ],
    },
    {
      id: 'tm_net',
      name: 'Network',
      description: '',
      members: [{ userId: 'u_bob', role: 'member' }],
    },
  ],
  cases: [],
};

function setup(): { state: TaskState; sent: TaskOp[] } {
  let state = emptyTaskState();
  const ops: TaskOp[] = [
    { type: 'task.add', task: { ...nt('a', { priority: 'urgent' }), num: 1 } },
    { type: 'task.add', task: { ...nt('b'), num: 2 } },
    { type: 'task.add', task: { ...nt('c', { priority: 'low' }), num: 3 } },
  ];
  for (const op of ops) state = applyTaskOp(state, op, { actorId: 'u_lena', ts: T0 });
  const sent: TaskOp[] = [];
  useTasks.setState({
    state,
    directory: dir,
    dispatch: async (op) => {
      sent.push(op);
      return { ok: true };
    },
  });
  return { state, sent };
}

describe('BulkBar', () => {
  it('lets a lead distribute a selection across their team, balanced by default', async () => {
    const { state, sent } = setup();
    render(
      <BulkBar
        state={state}
        picked={Object.values(state.tasks)}
        names={namesFor(dir, 'u_lena')}
        onClear={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('bulk-distribute'));
    // The selection's team is preselected; Bob isn't on a team Lena leads, so isn't offered.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('option', { name: 'Bob' })).toBeNull();
    const rows = within(screen.getByTestId('distribute-preview')).getAllByRole('row');
    expect(rows.slice(1).map((r) => r.textContent)).toEqual(['Lena20', 'Ann10']);
    fireEvent.click(screen.getByTestId('distribute-apply'));
    await Promise.resolve();
    expect(sent).toEqual([
      {
        type: 'batch',
        ops: [
          { type: 'task.assign', ids: ['a', 'c'], mode: 'set', users: ['u_lena'] },
          { type: 'task.assign', ids: ['b'], mode: 'set', users: ['u_ann'] },
        ],
      },
    ]);
  });

  it('hides bulk assignment from analysts who lead no team, and still sets status', async () => {
    const { state, sent } = setup();
    render(
      <BulkBar
        state={state}
        picked={Object.values(state.tasks)}
        names={namesFor(dir, 'u_ann')}
        onClear={() => {}}
      />,
    );
    expect(screen.queryByText('Assign…')).toBeNull();
    expect(screen.queryByTestId('bulk-distribute')).toBeNull();
    fireEvent.change(screen.getByLabelText('Set status'), { target: { value: 'st_done' } });
    await Promise.resolve();
    expect(sent).toEqual([
      {
        type: 'batch',
        ops: ['a', 'b', 'c'].map((id) => ({
          type: 'task.set',
          id,
          patch: { statusId: 'st_done' },
        })),
      },
    ]);
  });
});

describe('picking cards', () => {
  it('picks with the checkbox, X or a modified click, and opens on a plain click', () => {
    const { state } = setup();
    const picks: string[] = [];
    render(
      <Board
        state={state}
        tasks={Object.values(state.tasks)}
        config={defaultViewConfig()}
        names={namesFor(dir, 'u_lena')}
        canEdit
        selectedNum={null}
        picked={new Set(['b'])}
        onPick={(t) => picks.push(t.id)}
      />,
    );
    fireEvent.click(screen.getByLabelText('Select T-1'));
    fireEvent.keyDown(screen.getByLabelText('T-2 Task b'), { key: 'x' });
    fireEvent.click(screen.getByLabelText('T-3 Task c'), { metaKey: true });
    expect(picks).toEqual(['a', 'b', 'c']);
    expect(screen.getByLabelText('T-2 Task b')).toHaveClass('picked');
    fireEvent.click(screen.getByLabelText('T-3 Task c'));
    expect(location.hash).toMatch(/\/t\/3$/);
  });
});

describe('workflowSaveOp', () => {
  it('saves the statuses and moves tasks off removed ones in the same op', () => {
    const { state } = setup();
    const wf = state.workflows[state.defaultWorkflowId]!;
    expect(statusUse(state, wf.id).get('st_todo')).toBe(3);
    const statuses = wf.statuses.filter((s) => s.id !== 'st_todo');
    const op = workflowSaveOp(state, wf, { statuses, remap: { st_todo: 'st_backlog' } });
    expect(op).toEqual({
      type: 'batch',
      ops: [
        { type: 'workflow.set', workflow: { ...wf, statuses } },
        ...['a', 'b', 'c'].map((id) => ({
          type: 'task.set',
          id,
          patch: { statusId: 'st_backlog' },
        })),
      ],
    });
  });
});
