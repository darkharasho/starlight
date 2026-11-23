import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import { PTRACE_MESSAGE } from '../../shared/ptrace.js';

export type LatchState = 'waiting' | 'detected' | 'latched';

interface LatchStore {
  state: LatchState;
  detectedGame: { name: string; coverUrl: string; processName: string } | null;
  error: string | null;
  /** The engine isn't permitted to read the game (ptrace); the UI offers Allow. */
  needsPermission: boolean;
  /** The permission prompt is up. */
  allowing: boolean;
  /** Free-text PID input from the UI; Phase 4.5 will replace with auto-detection. */
  pidInput: string;

  setPidInput: (s: string) => void;
  detect: (game: { name: string; coverUrl: string; processName: string }) => void;
  latch:  () => Promise<void>;
  /** Grants the engine permission to read games' memory, then latches again. */
  allowAccess: () => Promise<void>;
  detach: () => Promise<void>;
}

export const useLatchState = create<LatchStore>((set, get) => ({
  state: 'waiting',
  detectedGame: null,
  error: null,
  needsPermission: false,
  allowing: false,
  pidInput: '',

  setPidInput: (s) => set({ pidInput: s }),
  detect: (game) => set({ state: 'detected', detectedGame: game, error: null, needsPermission: false }),

  async latch() {
    const pid = parseInt(get().pidInput.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      set({ error: 'Enter a numeric PID before latching.', needsPermission: false });
      return;
    }
    const r = await starlight().attach({ pid });
    if (r.ok) {
      set({ state: 'latched', error: null, needsPermission: false });
    } else if (r.code === 'permission') {
      set({ error: PTRACE_MESSAGE, needsPermission: true });
    } else {
      set({ error: r.message, needsPermission: false });
    }
  },

  async allowAccess() {
    if (get().allowing) return;
    set({ allowing: true });
    const r = await starlight().allowMemoryAccess()
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    set({ allowing: false });
    if (!r.ok) {
      // A dismissed prompt leaves the explanation (and its button) up.
      if (!('cancelled' in r && r.cancelled)) set({ error: r.error, needsPermission: false });
      return;
    }
    await get().latch();
  },

  async detach() {
    await starlight().detach();
    set({ state: 'waiting', detectedGame: null, error: null, needsPermission: false });
  },
}));
