import { create } from 'zustand';
import type { TerrainStore } from '../lib/terrain';
import { MemoryTerrain } from '../lib/terrain';

interface TerrainState {
  store: TerrainStore;
  /** Bumped whenever a scan's rows change, so views refetch. */
  version: number;
  setStore(store: TerrainStore): void;
  bump(): void;
}

export const useTerrain = create<TerrainState>((set) => ({
  store: new MemoryTerrain(),
  version: 0,
  setStore: (store) => set({ store, version: 0 }),
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
