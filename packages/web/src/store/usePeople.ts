/**
 * Who can be put on a task in the open case, and who follows what. Hosted only: the standalone
 * build has no accounts, so its assignees are typed names and nobody follows anything.
 */
import { create } from 'zustand';
import { api } from '../lib/api';
import { useCaseStore } from './useCaseStore';
import { toast } from './useToasts';

export interface Person {
  id: string;
  username: string;
  displayName: string;
  canEdit: boolean;
}

export interface Follow {
  taskId: string;
  userId: string;
}

interface PeopleState {
  caseId: string | null;
  people: Person[];
  follows: Follow[];
  load(caseId: string): Promise<void>;
  loadFollows(): Promise<void>;
  reset(): void;
  setFollowing(taskId: string, on: boolean): Promise<void>;
}

export const usePeople = create<PeopleState>((set, get) => ({
  caseId: null,
  people: [],
  follows: [],
  async load(caseId) {
    set({ caseId, people: [], follows: [] });
    try {
      const [p, f] = await Promise.all([
        api<{ people: Person[] }>('GET', `/api/cases/${caseId}/people`),
        api<{ follows: Follow[] }>('GET', `/api/cases/${caseId}/follows`),
      ]);
      if (get().caseId === caseId) set({ people: p.people, follows: f.follows });
    } catch {
      // The board still works without names; ids show instead.
    }
  },
  async loadFollows() {
    const caseId = get().caseId;
    if (!caseId) return;
    try {
      const f = await api<{ follows: Follow[] }>('GET', `/api/cases/${caseId}/follows`);
      if (get().caseId === caseId) set({ follows: f.follows });
    } catch {
      // keep what we had
    }
  },
  reset() {
    set({ caseId: null, people: [], follows: [] });
  },
  async setFollowing(taskId, on) {
    const caseId = get().caseId;
    const me = useCaseStore.getState().me;
    if (!caseId || !me) return;
    const before = get().follows;
    set({
      follows: on
        ? [
            ...before.filter((f) => !(f.taskId === taskId && f.userId === me.id)),
            { taskId, userId: me.id },
          ]
        : before.filter((f) => !(f.taskId === taskId && f.userId === me.id)),
    });
    try {
      await api(on ? 'PUT' : 'DELETE', `/api/cases/${caseId}/tasks/${taskId}/follow`);
    } catch (err) {
      set({ follows: before });
      toast(err instanceof Error ? err.message : 'Could not change following', 'bad');
    }
  },
}));

/** A display name for an assignee id. Standalone assignees are names already. */
export function usePersonName(): (id: string) => string {
  const people = usePeople((s) => s.people);
  const byId = new Map(people.map((p) => [p.id, p.displayName]));
  return (id) => byId.get(id) ?? id;
}

/** Task ids the signed-in person follows. */
export function useMyFollows(): Set<string> {
  const follows = usePeople((s) => s.follows);
  const me = useCaseStore((s) => s.me);
  return new Set(me ? follows.filter((f) => f.userId === me.id).map((f) => f.taskId) : []);
}
