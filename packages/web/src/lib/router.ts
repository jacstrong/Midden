import { useEffect } from 'react';
import { create } from 'zustand';
import { useUiStore, VIEW_IDS, type ViewId } from '../store/useUiStore';

export type CaseView = ViewId | 'history';
export const CASE_VIEWS: CaseView[] = [...VIEW_IDS, 'history'];

export type Route =
  | { kind: 'login' }
  | { kind: 'cases' }
  | { kind: 'users' }
  | { kind: 'tokens' }
  | { kind: 'password' }
  | { kind: 'case'; caseId: string; view: CaseView }
  /** A task board or table; `taskNum` opens that task's drawer over it. */
  | { kind: 'tasks'; viewId: string; taskNum: number | null }
  /** Counts for leads: open work, throughput, cycle time, burndown. */
  | { kind: 'insights' }
  | { kind: 'teams' }
  | { kind: 'playbooks' }
  /** Notifications, or the preferences for them. */
  | { kind: 'inbox'; tab: 'inbox' | 'prefs' }
  | { kind: 'standalone'; view: ViewId };

const isView = (v: string | undefined): v is ViewId => !!v && (VIEW_IDS as string[]).includes(v);
const isCaseView = (v: string | undefined): v is CaseView =>
  !!v && (CASE_VIEWS as string[]).includes(v);

/**
 * Hash routes work from file:// too. Hosted: #/cases, #/c/<id>/<view>, #/tasks/<view>[/t/<num>], #/tasks/insights,
 * #/teams, #/playbooks, #/inbox[/prefs], #/users, #/login. Standalone: #/<view>.
 */
export function parseRoute(hash: string, mode: 'server' | 'standalone'): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (mode === 'standalone')
    return { kind: 'standalone', view: isView(parts[0]) ? parts[0] : 'graph' };
  switch (parts[0]) {
    case 'login':
      return { kind: 'login' };
    case 'users':
      return { kind: 'users' };
    case 'tokens':
      return { kind: 'tokens' };
    case 'password':
      return { kind: 'password' };
    case 'teams':
      return { kind: 'teams' };
    case 'playbooks':
      return { kind: 'playbooks' };
    case 'inbox':
      return { kind: 'inbox', tab: parts[1] === 'prefs' ? 'prefs' : 'inbox' };
    case 'tasks': {
      if (parts[1] === 'insights') return { kind: 'insights' };
      // #/tasks, #/tasks/<view>, #/tasks/<view>/t/<num>, and #/tasks/t/<num> for a bare link
      const bare = parts[1] === 't';
      const viewId = bare ? 'mine' : parts[1] || 'mine';
      const numPart = bare ? parts[2] : parts[2] === 't' ? parts[3] : undefined;
      const n = numPart ? Number(numPart.replace(/^T-/i, '')) : NaN;
      return { kind: 'tasks', viewId, taskNum: Number.isInteger(n) && n > 0 ? n : null };
    }
    case 'c': {
      const caseId = parts[1];
      if (!caseId) return { kind: 'cases' };
      return { kind: 'case', caseId, view: isCaseView(parts[2]) ? parts[2] : 'graph' };
    }
    default:
      return { kind: 'cases' };
  }
}

export function routeHash(r: Route): string {
  switch (r.kind) {
    case 'login':
      return '#/login';
    case 'cases':
      return '#/cases';
    case 'users':
      return '#/users';
    case 'tokens':
      return '#/tokens';
    case 'password':
      return '#/password';
    case 'case':
      return `#/c/${r.caseId}/${r.view}`;
    case 'tasks':
      return `#/tasks/${r.viewId}` + (r.taskNum ? `/t/${r.taskNum}` : '');
    case 'insights':
      return '#/tasks/insights';
    case 'teams':
      return '#/teams';
    case 'playbooks':
      return '#/playbooks';
    case 'inbox':
      return r.tab === 'prefs' ? '#/inbox/prefs' : '#/inbox';
    case 'standalone':
      return `#/${r.view}`;
  }
}

/** Back-compat helper used by tests: which UI view a hash points at in standalone mode. */
export function parseHash(hash: string): ViewId | null {
  const m = /^#\/?([a-z]+)/.exec(hash);
  const v = m?.[1];
  return isView(v) ? v : null;
}

interface RouteState {
  route: Route;
  navigate(r: Route): void;
}

const MODE = __MIDDEN_MODE__ === 'standalone' ? 'standalone' : 'server';

export const useRoute = create<RouteState>((set) => ({
  route: parseRoute(typeof location !== 'undefined' ? location.hash : '', MODE),
  navigate(r) {
    const h = routeHash(r);
    if (location.hash !== h) location.hash = h;
    set({ route: { ...r } });
  },
}));

/** Keeps the route store and the UI view in sync with the address bar. */
export function useHashRouter(): void {
  const navigate = useRoute((s) => s.navigate);
  const setView = useUiStore((s) => s.setView);
  useEffect(() => {
    const sync = (): void => {
      const r = parseRoute(location.hash, MODE);
      useRoute.setState({ route: r });
      if (r.kind === 'standalone') setView(r.view);
      if (r.kind === 'case' && r.view !== 'history') setView(r.view);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [navigate, setView]);
}

/** Navigate to a view within the current context (standalone view or case view). */
export function goToView(view: CaseView): void {
  const { route, navigate } = useRoute.getState();
  if (route.kind === 'case') navigate({ ...route, view });
  else if (route.kind === 'standalone' && view !== 'history')
    navigate({ kind: 'standalone', view });
}
