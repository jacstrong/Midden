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
import { useTasks } from './TaskStore';
import { namesFor } from './shared';

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
  ...extra,
});
const dir: TaskDirectory = {
  users: [
    { id: 'u_ann', username: 'ann', displayName: 'Ann', role: 'analyst', disabled: false },
    { id: 'u_bob', username: 'bob', displayName: 'Bob', role: 'analyst', disabled: false },
    { id: 'u_vic', username: 'vic', displayName: 'Vic', role: 'viewer', disabled: false },
  ],
  teams: [],
  cases: [],
};

function setup(): { state: TaskState; sent: TaskOp[] } {
  let state = emptyTaskState();
  for (const op of [
    { type: 'task.add', task: { ...nt('a', { assignees: ['u_ann'] }), num: 1 } },
    { type: 'task.add', task: { ...nt('b', { statusId: 'st_doing' }), num: 2 } },
  ] as TaskOp[])
    state = applyTaskOp(state, op, { actorId: 'u_ann', ts: T0 });
  const sent: TaskOp[] = [];
  useTasks.setState({
    directory: dir,
    dispatch: async (op) => {
      sent.push(op);
      return { ok: true };
    },
  });
  return { state, sent };
}

describe('Board', () => {
  it('shows a status column for each status, with WIP counts', () => {
    const { state } = setup();
    render(
      <Board
        state={state}
        tasks={Object.values(state.tasks)}
        config={defaultViewConfig()}
        names={namesFor(dir, 'u_ann')}
        canEdit
        selectedNum={null}
      />,
    );
    const cols = screen.getAllByTestId('board-col');
    expect(cols.map((c) => c.dataset.col)).toEqual([
      'st_backlog',
      'st_todo',
      'st_doing',
      'st_blocked',
      'st_done',
      'st_cancelled',
    ]);
    expect(within(cols[1]!).getByText('Task a')).toBeInTheDocument();
    expect(within(cols[2]!).getByText('Task b')).toBeInTheDocument();
  });

  it('keeps an empty column for everyone who can take work, and moves cards by keyboard', async () => {
    const { state, sent } = setup();
    render(
      <Board
        state={state}
        tasks={Object.values(state.tasks)}
        config={defaultViewConfig({ groupBy: 'assignee' })}
        names={namesFor(dir, 'u_ann')}
        canEdit
        selectedNum={null}
      />,
    );
    // the queue first, then people; viewers get no column
    expect(screen.getAllByTestId('board-col').map((c) => c.dataset.col)).toEqual([
      '',
      'u_ann',
      'u_bob',
    ]);
    fireEvent.keyDown(screen.getByLabelText('T-1 Task a'), { key: 'ArrowRight', shiftKey: true });
    await Promise.resolve();
    expect(sent).toEqual([
      {
        type: 'batch',
        ops: [
          { type: 'task.assign', ids: ['a'], mode: 'remove', users: ['u_ann'] },
          { type: 'task.assign', ids: ['a'], mode: 'add', users: ['u_bob'] },
        ],
      },
    ]);
  });

  it('does not move cards for a read-only viewer', () => {
    const { state, sent } = setup();
    render(
      <Board
        state={state}
        tasks={Object.values(state.tasks)}
        config={defaultViewConfig()}
        names={namesFor(dir, 'u_vic')}
        canEdit={false}
        selectedNum={null}
      />,
    );
    const card = screen.getByLabelText('T-1 Task a');
    expect(card).toHaveAttribute('draggable', 'false');
    fireEvent.keyDown(card, { key: 'ArrowRight', shiftKey: true });
    expect(sent).toEqual([]);
  });
});
