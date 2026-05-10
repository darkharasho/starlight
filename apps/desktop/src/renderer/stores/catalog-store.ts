import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { CatalogIndex, FetchTrainerRequest } from '../../shared/ipc.js';
import type { CatalogIndexEntry, StarlightTrainer } from '@starlight/catalog/schema';

interface CatalogState {
  index: CatalogIndex | null;
  loading: boolean;
  error: string | null;
  /** Catalog id of the trainer currently being fetched, or null. */
  fetchingTrainerId: string | null;
  /** Last trainer-fetch error, cleared on the next attempt. */
  trainerError: string | null;
  load: () => Promise<void>;
  /**
   * Fetch the trainer JSON for a catalog entry. Routes to a static CDN
   * lookup when `trainerPath` is set, or to a live fearlessrevolution fetch
   * via `trainerSource` otherwise. Cached in-memory by entry id.
   */
  trainer: (entry: CatalogIndexEntry) => Promise<StarlightTrainer | null>;
}

const trainerCache = new Map<string, StarlightTrainer>();

function buildRequest(entry: CatalogIndexEntry): FetchTrainerRequest | null {
  const base: FetchTrainerRequest = {
    id: entry.id,
    name: entry.name,
    processName: entry.processName,
    platform: entry.platform,
  };
  if (entry.trainerPath) return { ...base, trainerPath: entry.trainerPath };
  if (entry.trainerSource) return { ...base, trainerSource: entry.trainerSource };
  return null;
}

export const useCatalogStore = create<CatalogState>((set) => ({
  index: null,
  loading: false,
  error: null,
  fetchingTrainerId: null,
  trainerError: null,
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
  trainer: async (entry) => {
    const cached = trainerCache.get(entry.id);
    if (cached) return cached;
    const req = buildRequest(entry);
    if (!req) return null;
    set({ fetchingTrainerId: entry.id, trainerError: null });
    try {
      const r = await starlight().fetchTrainer(req);
      if (!r.ok) {
        set({ fetchingTrainerId: null, trainerError: r.error });
        return null;
      }
      trainerCache.set(entry.id, r.trainer);
      set({ fetchingTrainerId: null });
      return r.trainer;
    } catch (err) {
      set({ fetchingTrainerId: null, trainerError: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },
}));
