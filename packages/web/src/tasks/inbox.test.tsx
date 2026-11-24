import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { NotificationView } from '@midden/core';
import { parseRoute, routeHash, useRoute } from '../lib/router';
import { Bell } from './Bell';
import { notificationAlso, notificationText, useInbox } from './inbox';
import { TaskStore } from './TaskStore';
import type { SocketHub } from '../lib/socket';

const NOW = new Date().toISOString();

const n = (extra: Partial<NotificationView> = {}): NotificationView => ({
  id: 'nt_1',
  kind: 'assigned',
  kinds: ['assigned'],
  tasks: [{ id: 't1', num: 12, title: 'Pull DNS logs' }],
  actors: [{ id: 'u_lena', name: 'Lena' }],
  comments: [],
  count: 1,
  // One fixed moment, so two copies built a millisecond apart are still equal.
  createdAt: NOW,
  updatedAt: NOW,
  read: false,
  ...extra,
});

describe('notifications in the browser', () => {
  afterEach(() => {
    useInbox.getState().reset();
    vi.restoreAllMocks();
  });

  it('words notifications', () => {
    expect(notificationText(n())).toBe('Lena assigned you T-12 Pull DNS logs');
    expect(
      notificationText(
        n({
          kind: 'comment',
          actors: [
            { id: 'a', name: 'Ann' },
            { id: 'b', name: 'Bob' },
            { id: 'c', name: 'Cy' },
          ],
        }),
      ),
    ).toBe('Ann, Bob and Cy commented on T-12 Pull DNS logs');
    expect(
      notificationText(
        n({
          kind: 'overdue',
          actors: [],
          tasks: [
            { id: 'a', num: 1, title: 'A' },
            { id: 'b', num: 2, title: 'B' },
          ],
        }),
      ),
    ).toBe('2 tasks are overdue');
    expect(notificationAlso(n({ kinds: ['assigned', 'comment', 'status'] }))).toBe(
      'also commented, changed status',
    );
  });

  it('routes the inbox', () => {
    expect(parseRoute('#/inbox', 'server')).toEqual({ kind: 'inbox', tab: 'inbox' });
    expect(parseRoute('#/inbox/prefs', 'server')).toEqual({ kind: 'inbox', tab: 'prefs' });
    expect(routeHash({ kind: 'inbox', tab: 'prefs' })).toBe('#/inbox/prefs');
  });

  it('shows the unread count and opens a notification’s task', () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"unread":0}'));
    useInbox.setState({ loaded: true, items: [n(), n({ id: 'nt_2', read: true })], unread: 1 });
    render(<Bell />);
    expect(screen.getByTestId('bell-count').textContent).toBe('1');
    fireEvent.click(screen.getByTestId('bell'));
    const items = screen.getAllByTestId('notification');
    expect(items).toHaveLength(2);
    fireEvent.click(items[0]!);
    expect(useRoute.getState().route).toEqual({ kind: 'tasks', viewId: 'mine', taskNum: 12 });
    expect(useInbox.getState().items[0]!.read).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      '/api/notifications/read',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ ids: ['nt_1'] }) }),
    );
  });

  it('takes live updates from the socket', () => {
    const got: unknown[] = [];
    const hub = { add() {}, remove() {}, send() {} } as unknown as SocketHub;
    const store = new TaskStore(
      { id: 'u_ann', name: 'Ann' },
      {
        setState() {},
        setConnection() {},
        notify() {},
        inbox: (m) => got.push(m),
      },
      hub,
    );
    store.onMessage({ t: 'notify', unread: 3, notification: n() });
    expect(got).toEqual([{ t: 'notify', unread: 3, notification: n() }]);

    useInbox.setState({ items: [n({ id: 'old' })], unread: 1 });
    useInbox.getState().receive({ t: 'notify', unread: 2, notification: n() });
    expect(useInbox.getState().items.map((x) => x.id)).toEqual(['nt_1', 'old']);
    useInbox.getState().receive({ t: 'notify', unread: 0, read: 'all' });
    expect(useInbox.getState()).toMatchObject({ unread: 0 });
    expect(useInbox.getState().items.every((x) => x.read)).toBe(true);
  });
});
