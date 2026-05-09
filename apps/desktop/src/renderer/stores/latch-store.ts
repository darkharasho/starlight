import { create } from 'zustand';

export type LatchState = 'idle' | 'waiting' | 'detected' | 'latched';

interface LatchStore {
  state: LatchState;
  /** The game currently associated with this latch — null until detected. */
  detectedGame: { name: string; coverUrl: string; processName: string } | null;
  setState: (state: LatchState) => void;
  detect: (game: { name: string; coverUrl: string; processName: string }) => void;
  latch: () => void;
  detach: () => void;
}

export const useLatchState = create<LatchStore>((set) => ({
  state: 'waiting',
  detectedGame: null,
  setState: (state) => set({ state }),
  detect: (game) => set({ state: 'detected', detectedGame: game }),
  latch: () => set({ state: 'latched' }),
  detach: () => set({ state: 'waiting', detectedGame: null }),
}));
