import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TaskInsights } from '@midden/core';
import { parseRoute, routeHash } from '../lib/router';
import { fmtDuration, InsightsPage } from './InsightsPage';

const insights = (extra: Partial<TaskInsights> = {}): TaskInsights => ({
  now: '2026-03-04T12:00:00.000Z',
  from: '2026-02-23T00:00:00.000Z',
  to: '2026-03-04T12:00:00.001Z',
  open: {
    total: 5,
    byCategory: { backlog: 1, todo: 2, in_progress: 1, blocked: 1, done: 3, cancelled: 0 },
    overdue: 2,
    unassigned: 1,
  },
  queues: [],
  people: [{ userId: 'u_ann', open: 3, inProgress: 1, blocked: 1, overdue: 2 }],
  throughput: [
    { week: '2026-02-23', created: 4, done: 1 },
    { week: '2026-03-02', created: 2, done: 2 },
  ],
  cycle: { count: 3, medianSec: 5 * 3600, p90Sec: 3 * 86400 },
  lead: { count: 3, medianSec: 86400, p90Sec: 4 * 86400 },
  stuck: [
    {
      id: 't1',
      num: 7,
      title: 'Pull DNS logs',
      statusId: 'st_blocked',
      category: 'blocked',
      since: '2026-03-01T12:00:00.000Z',
      assignees: ['u_ann'],
    },
  ],
  approvals: [],
  burndown: null,
  ...extra,
});

describe('insights page', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes and formats durations', () => {
    expect(parseRoute('#/tasks/insights', 'server')).toEqual({ kind: 'insights' });
    expect(routeHash({ kind: 'insights' })).toBe('#/tasks/insights');
    expect(fmtDuration(null)).toBe('–');
    expect(fmtDuration(600)).toBe('10m');
    expect(fmtDuration(5 * 3600)).toBe('5h');
    expect(fmtDuration(2.5 * 86400)).toBe('2.5d');
    expect(fmtDuration(40 * 86400)).toBe('40d');
  });

  it('shows the numbers and asks again when a filter changes', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ insights: insights() })));
    render(<InsightsPage />);
    await screen.findByText('Pull DNS logs');
    expect(screen.getByText('Cycle time').nextSibling?.textContent).toBe('5h');
    expect(screen.getByText(/p90 3d · 3 tasks/)).toBeTruthy();
    const asked = () =>
      fetch.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/tasks/insights'));
    expect(asked()).toEqual([
      expect.stringMatching(/^\/api\/tasks\/insights\?from=\d{4}-\d{2}-\d{2}$/),
    ]);

    fireEvent.click(screen.getByRole('button', { name: '4 wk' }));
    await waitFor(() => expect(asked()).toHaveLength(2));

    // Every chart has a table view.
    fireEvent.click(screen.getAllByRole('button', { name: 'Table' })[1]!);
    expect(screen.getByRole('columnheader', { name: 'Week of' })).toBeTruthy();
  });
});
