import { create } from 'zustand';
import { api, ApiError, setUnauthorizedHandler, type SessionUser } from '../lib/api';

export type SessionStatus = 'unknown' | 'anon' | 'authed';

interface SessionState {
  status: SessionStatus;
  user: SessionUser | null;
  mustChangePassword: boolean;
  openCases: boolean;
  load(): Promise<void>;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  changePassword(current: string | undefined, next: string): Promise<void>;
}

export const useSession = create<SessionState>((set, get) => {
  setUnauthorizedHandler(() => {
    if (get().status === 'authed') set({ status: 'anon', user: null });
  });
  return {
    status: 'unknown',
    user: null,
    mustChangePassword: false,
    openCases: true,
    async load() {
      try {
        const me = await api<{
          user: SessionUser;
          mustChangePassword: boolean;
          openCases: boolean;
        }>('GET', '/api/auth/me');
        set({
          status: 'authed',
          user: me.user,
          mustChangePassword: me.mustChangePassword,
          openCases: me.openCases,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) set({ status: 'anon', user: null });
        else throw err;
      }
    },
    async login(username, password) {
      const r = await api<{ user: SessionUser; mustChangePassword: boolean }>(
        'POST',
        '/api/auth/login',
        { username, password },
      );
      set({ status: 'authed', user: r.user, mustChangePassword: r.mustChangePassword });
    },
    async logout() {
      await api('POST', '/api/auth/logout');
      set({ status: 'anon', user: null, mustChangePassword: false });
    },
    async changePassword(current, next) {
      await api('POST', '/api/auth/password', { current, next });
      set({ mustChangePassword: false });
    },
  };
});
