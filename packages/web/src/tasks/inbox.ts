/**
 * The signed-in person's notifications: the bell's count and the inbox list. Loaded over REST
 * and kept current by `notify` messages on the shared socket (a new or updated notification,
 * or some read in another tab).
 */
import { create } from 'zustand';
import { taskRef, type NotificationView, type ServerMessage } from '@midden/core';
import { api } from '../lib/api';

type NotifyMessage = Extract<ServerMessage, { t: 'notify' }>;

interface InboxState {
  unread: number;
  items: NotificationView[];
  loaded: boolean;
  more: boolean;
  /** (Re)load the newest page; on sign-in and whenever the socket reconnects. */
  load(): Promise<void>;
  loadMore(): Promise<void>;
  markRead(ids: string[]): Promise<void>;
  markAll(): Promise<void>;
  receive(m: NotifyMessage): void;
  reset(): void;
}

const PAGE = 50;
let loading: Promise<void> | null = null;
type Page = { notifications: NotificationView[]; unread: number };

export const useInbox = create<InboxState>((set, get) => ({
  unread: 0,
  items: [],
  loaded: false,
  more: false,
  load() {
    // The bell, the inbox page and a reconnect can all ask at once; one request serves them.
    loading ??= (async () => {
      try {
        const r = await api<Page>('GET', `/api/notifications?limit=${PAGE}`);
        set({
          items: r.notifications,
          unread: r.unread,
          loaded: true,
          more: r.notifications.length === PAGE,
        });
      } catch {
        // Offline or signed out: the next reconnect loads again.
      } finally {
        loading = null;
      }
    })();
    return loading;
  },
  async loadMore() {
    const last = get().items.at(-1);
    if (!last) return;
    const r = await api<Page>(
      'GET',
      `/api/notifications?limit=${PAGE}&before=${encodeURIComponent(last.updatedAt)}`,
    );
    const have = new Set(get().items.map((n) => n.id));
    set({
      items: [...get().items, ...r.notifications.filter((n) => !have.has(n.id))],
      unread: r.unread,
      more: r.notifications.length === PAGE,
    });
  },
  async markRead(ids) {
    const fresh = ids.filter((id) => get().items.some((n) => n.id === id && !n.read));
    if (!fresh.length) return;
    set({ items: get().items.map((n) => (fresh.includes(n.id) ? { ...n, read: true } : n)) });
    const r = await api<{ unread: number }>('POST', '/api/notifications/read', { ids: fresh });
    set({ unread: r.unread });
  },
  async markAll() {
    set({ items: get().items.map((n) => ({ ...n, read: true })), unread: 0 });
    const r = await api<{ unread: number }>('POST', '/api/notifications/read', { all: true });
    set({ unread: r.unread });
  },
  receive(m) {
    let items = get().items;
    if (m.notification) {
      const n = m.notification;
      items = [n, ...items.filter((x) => x.id !== n.id)];
    }
    if (m.read === 'all') items = items.map((n) => ({ ...n, read: true }));
    else if (m.read) {
      const read = new Set(m.read);
      items = items.map((n) => (read.has(n.id) ? { ...n, read: true } : n));
    }
    set({ items, unread: m.unread });
  },
  reset() {
    set({ unread: 0, items: [], loaded: false, more: false });
  },
}));

const people = (actors: NotificationView['actors']): string => {
  const names = actors.map((a) => a.name);
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

/** The task(s) a notification is about, as words. */
export const notificationSubject = (n: NotificationView): string =>
  n.tasks.length === 1
    ? `${taskRef(n.tasks[0]!.num)} ${n.tasks[0]!.title}`
    : `${n.tasks.length} tasks`;

/**
 * One line saying what happened: "Lena assigned you T-12 Pull DNS logs". `statusName` is the
 * task's status now, for a status change to one task.
 */
export function notificationText(n: NotificationView, statusName?: string): string {
  const who = people(n.actors) || 'Someone';
  const what = notificationSubject(n);
  const are = n.tasks.length === 1 ? 'is' : 'are';
  switch (n.kind) {
    case 'assigned':
      return `${who} assigned you ${what}`;
    case 'mention':
      return `${who} mentioned you on ${what}`;
    case 'approval_requested':
      return `${who} asked you to approve ${what}`;
    case 'approval_decided':
      return `${who} decided the approval on ${what}`;
    case 'comment':
      return `${who} commented on ${what}`;
    case 'status':
      return statusName && n.tasks.length === 1
        ? `${who} moved ${what} to ${statusName}`
        : `${who} changed the status of ${what}`;
    case 'queued':
      return `${who} added ${what} to your team’s queue`;
    case 'due_soon':
      return `${what} ${are} due within a day`;
    case 'overdue':
      return `${what} ${are} overdue`;
    case 'edited':
    default:
      return `${who} edited ${what}`;
  }
}

/** The other things folded in: "also commented, changed status". */
export function notificationAlso(n: NotificationView): string {
  const words: Partial<Record<string, string>> = {
    assigned: 'assigned you',
    mention: 'mentioned you',
    approval_requested: 'asked for approval',
    approval_decided: 'decided approval',
    comment: 'commented',
    status: 'changed status',
    edited: 'edited',
    queued: 'queued it',
  };
  const rest = n.kinds.filter((k) => k !== n.kind && words[k]).map((k) => words[k]!);
  return rest.length ? `also ${rest.join(', ')}` : '';
}
