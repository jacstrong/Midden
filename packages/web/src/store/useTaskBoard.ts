/** How the task board is filtered and what is selected. Kept apart from the case so it survives edits. */
import { create } from 'zustand';
import type { TaskPriority, TaskScope } from '@midden/core';

interface TaskBoardState {
  scope: TaskScope;
  query: string;
  priority: TaskPriority | '';
  hostId: string;
  /** Selected task ids, for bulk actions. */
  selected: string[];
  /** The last card clicked, so shift-click can select a range. */
  anchor: string | null;
  setScope(scope: TaskScope): void;
  setQuery(q: string): void;
  setPriority(p: TaskPriority | ''): void;
  setHostId(id: string): void;
  toggle(id: string): void;
  selectOnly(ids: string[]): void;
  addToSelection(ids: string[]): void;
  clearSelection(): void;
  setAnchor(id: string | null): void;
}

export const useTaskBoard = create<TaskBoardState>((set) => ({
  scope: 'all',
  query: '',
  priority: '',
  hostId: '',
  selected: [],
  anchor: null,
  setScope: (scope) => set({ scope }),
  setQuery: (query) => set({ query }),
  setPriority: (priority) => set({ priority }),
  setHostId: (hostId) => set({ hostId }),
  toggle: (id) =>
    set((s) => ({
      selected: s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id],
      anchor: id,
    })),
  selectOnly: (selected) => set({ selected }),
  addToSelection: (ids) => set((s) => ({ selected: [...new Set([...s.selected, ...ids])] })),
  clearSelection: () => set({ selected: [], anchor: null }),
  setAnchor: (anchor) => set({ anchor }),
}));
