import { create } from 'zustand';
import { starlight } from '../ipc-client.js';

export type LatchState = 'waiting' | 'detected' | 'latched';

interface LatchStore {
  state: LatchState;
  detectedGame: { name: string; coverUrl: string; processName: string } | null;
  error: string | null;
  /** Free-text PID input from the UI; Phase 4.5 will replace with auto-detection. */
  pidInput: string;

  setPidInput: (s: string) => void;
  detect: (game: { name: string; coverUrl: string; processName: string }) => void;
  latch:  () => Promise<void>;
  detach: () => Promise<void>;
}

export const useLatchState = create<LatchStore>((set, get) => ({
  state: 'waiting',
  detectedGame: null,
  error: null,
  pidInput: '',

  setPidInput: (s) => set({ pidInput: s }),
  detect: (game) => set({ state: 'detected', detectedGame: game, error: null }),

  async latch() {
    const pid = parseInt(get().pidInput.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      set({ error: 'Enter a numeric PID before latching.' });
      return;
    }
    const r = await starlight().attach({ pid });
    if (r.ok) {
      set({ state: 'latched', error: null });
    } else {
      set({ error: r.message });
    }
  },

  async detach() {
    await starlight().detach();
    set({ state: 'waiting', detectedGame: null, error: null });
  },
}));
