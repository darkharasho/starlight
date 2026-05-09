import { create } from 'zustand';
import { api } from '../ipc-client.js';
import type { DetectedGame } from '../../shared/ipc.js';

interface LibraryStore {
  games: DetectedGame[];
  loading: boolean;
  error: string | null;
  scan: () => Promise<void>;
}

export const useLibraryStore = create<LibraryStore>((set) => ({
  games: [],
  loading: false,
  error: null,
  scan: async () => {
    set({ loading: true, error: null });
    try {
      const r = await api().scanLibrary();
      set({ games: r.games, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
