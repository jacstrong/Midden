/** Task notices for the signed-in person: fetched on a timer, and pushed over any open case socket. */
import { create } from 'zustand';
import type { TaskNotification } from '@midden/core';
import { api } from '../lib/api';

interface NotificationsState {
  items: TaskNotification[];
  unread: number;
  loaded: boolean;
  load(): Promise<void>;
  received(n: TaskNotification): void;
  markRead(ids: string[] | 'all'): Promise<void>;
}

export const useNotifications = create<NotificationsState>((set, get) => ({
  items: [],
  unread: 0,
  loaded: false,
  async load() {
    try {
      const r = await api<{ notifications: TaskNotification[]; unread: number }>(
        'GET',
        '/api/notifications?limit=50',
      );
      set({ items: r.notifications, unread: r.unread, loaded: true });
    } catch {
      // Offline or signed out; the next poll tries again.
    }
  },
  received(n) {
    if (get().items.some((x) => x.id === n.id)) return;
    set((s) => ({ items: [n, ...s.items].slice(0, 100), unread: s.unread + (n.readAt ? 0 : 1) }));
  },
  async markRead(ids) {
    const now = new Date().toISOString();
    const hit = (n: TaskNotification): boolean => ids === 'all' || ids.includes(n.id);
    set((s) => ({
      items: s.items.map((n) => (hit(n) && !n.readAt ? { ...n, readAt: now } : n)),
      unread:
        ids === 'all'
          ? 0
          : Math.max(0, s.unread - s.items.filter((n) => hit(n) && !n.readAt).length),
    }));
    try {
      const r = await api<{ unread: number }>(
        'POST',
        '/api/notifications/read',
        ids === 'all' ? { all: true } : { ids },
      );
      set({ unread: r.unread });
    } catch {
      void get().load();
    }
  },
}));
