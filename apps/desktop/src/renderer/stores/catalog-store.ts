import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { CatalogIndex } from '../../shared/ipc.js';
import type { StarlightTrainer } from '@starlight/catalog/schema';

interface CatalogState {
  index: CatalogIndex | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  trainer: (trainerPath: string) => Promise<StarlightTrainer | null>;
}

const trainerCache = new Map<string, StarlightTrainer>();

export const useCatalogStore = create<CatalogState>((set) => ({
  index: null,
  loading: false,
  error: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const r = await starlight().fetchCatalog();
      if (r.ok) set({ index: r.index, loading: false });
      else      set({ loading: false, error: r.error });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
  trainer: async (trainerPath) => {
    const cached = trainerCache.get(trainerPath);
    if (cached) return cached;
    const r = await starlight().fetchTrainer({ trainerPath });
    if (!r.ok) return null;
    trainerCache.set(trainerPath, r.trainer);
    return r.trainer;
  },
}));

