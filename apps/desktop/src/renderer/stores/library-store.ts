import { create } from 'zustand';
import { api, starlight } from '../ipc-client.js';
import type { DetectedGame } from '../../shared/ipc.js';

function slugify(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'unnamed';
}

function shortHash(s: string): string {
  // djb2 — deterministic, sync, cross-platform, 6-char base36 output.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6).padStart(6, '0');
}

interface LibraryStore {
  games: DetectedGame[];
  loading: boolean;
  error: string | null;
  scan: () => Promise<void>;
  addManual: (name: string, exePath: string) => Promise<void>;
  removeManual: (id: string) => Promise<void>;
}

export const useLibraryStore = create<LibraryStore>((set, get) => ({
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
  addManual: async (name, exePath) => {
    const id = `manual-${slugify(name)}-${shortHash(exePath)}`;
    const cfg = await starlight().getConfig();
    const existing = cfg.manualGames;
    const dedupedRest = existing.filter(g => g.id !== id);
    const next = [
      ...dedupedRest,
      { id, name, exePath, addedAt: new Date().toISOString() },
    ];
    await starlight().updateConfig({ patch: { manualGames: next } });
    await get().scan();
  },
  removeManual: async (id) => {
    const cfg = await starlight().getConfig();
    const next = cfg.manualGames.filter(g => g.id !== id);
    await starlight().updateConfig({ patch: { manualGames: next } });
    await get().scan();
  },
}));
