import { create } from 'zustand';
import type { StarlightTrainer, StarlightCheat, StarlightSupportedCheat, StarlightEvent } from '../../shared/ipc.js';
import { starlight } from '../ipc-client.js';

interface TrainerStore {
  trainer:     StarlightTrainer | null;
  /** cheatId → on/off */
  activeCheats: Record<string, boolean>;
  /** cheatId → current numeric value (for value/set cheats). */
  values: Record<string, number>;
  error: string | null;

  loadTrainer:    () => Promise<void>;
  toggleCheat:    (cheatId: string, on: boolean) => Promise<void>;
  setCheatValue:  (cheatId: string, value: number) => Promise<void>;
  setProcessName: (names: string[]) => Promise<void>;
  applyEvent:     (e: StarlightEvent) => void;
  clear:          () => void;
  /** Phase 5.0 stub — replaced by real impl in Task 11. */
  setActiveTrainerFromCatalog: (trainer: import('@starlight/catalog/schema').StarlightTrainer) => Promise<void>;
  rebindHotkey: (cheatId: string, slot: 'toggle' | 'inc' | 'dec', accelerator: string | null) => Promise<{ ok: boolean; error?: string }>;
}

function isSupported(c: StarlightCheat): c is StarlightSupportedCheat {
  return !('unsupported' in c) || c.unsupported !== true;
}

function findSupported(t: StarlightTrainer | null, id: string): StarlightSupportedCheat | undefined {
  if (!t) return undefined;
  for (const cat of t.categories) for (const c of cat.cheats) {
    if (c.id === id && isSupported(c)) return c as StarlightSupportedCheat;
  }
  return undefined;
}

function clamp(v: number, min?: number, max?: number): number {
  let r = v;
  if (typeof min === 'number' && r < min) r = min;
  if (typeof max === 'number' && r > max) r = max;
  return r;
}

function seedValues(t: StarlightTrainer): Record<string, number> {
  const out: Record<string, number> = {};
  for (const cat of t.categories) for (const c of cat.cheats) {
    if (isSupported(c) && c.type === 'set' && typeof c.default === 'number') {
      out[c.id] = c.default;
    }
  }
  return out;
}

export const useTrainerStore = create<TrainerStore>((set, get) => ({
  trainer: null,
  activeCheats: {},
  values: {},
  error: null,

  async loadTrainer() {
    const result = await starlight().loadTrainer();
    if (!result.ok) {
      set({ error: result.error });
      return;
    }
    set({
      trainer: result.trainer,
      activeCheats: {},
      values: seedValues(result.trainer),
      error: null,
    });
  },

  async toggleCheat(cheatId, on) {
    // Optimistic update: set the new value, remember the previous for rollback
    const prev = get().activeCheats[cheatId] ?? false;
    set((s) => ({ activeCheats: { ...s.activeCheats, [cheatId]: on } }));
    const r = await starlight().toggleCheat({ cheatId, on });
    if (!r.ok) {
      // Roll back to previous state
      set((s) => ({ activeCheats: { ...s.activeCheats, [cheatId]: prev }, error: r.error }));
      return;
    }
  },

  async setCheatValue(cheatId, value) {
    const cheat = findSupported(get().trainer, cheatId);
    const clamped = cheat ? clamp(value, cheat.min, cheat.max) : value;
    const r = await starlight().setCheatValue({ cheatId, value: clamped });
    if (!r.ok) {
      set({ error: r.error });
      return;
    }
    set((prev) => ({ values: { ...prev.values, [cheatId]: clamped } }));
  },

  async setProcessName(names) {
    await starlight().setProcessName({ names });
    const t = get().trainer;
    if (t) {
      try {
        await starlight().updateConfig({
          patch: { processNameOverrides: { [t.id]: names } },
        });
      } catch { /* swallow — UI override still applied to in-memory trainer */ }
    }
    set((s) => s.trainer
      ? { trainer: { ...s.trainer, game: { ...s.trainer.game, processName: names } } }
      : s);
  },

  applyEvent(e) {
    if (e.type === 'cheat:toggled') {
      set((prev) => ({ activeCheats: { ...prev.activeCheats, [e.cheatId]: e.on } }));
    } else if (e.type === 'cheat:value-changed') {
      set((prev) => ({ values: { ...prev.values, [e.cheatId]: e.value } }));
    } else if (e.type === 'session:detached') {
      set({ activeCheats: {}, error: e.reason === 'process-exit' ? 'Process exited.' : null });
    }
  },

  clear() { set({ trainer: null, activeCheats: {}, values: {}, error: null }); },

  async setActiveTrainerFromCatalog(trainer) {
    const r = await starlight().setTrainerFromCatalog({ trainer });
    if (!r.ok) {
      set({ error: r.error });
      return;
    }
    set({ trainer, activeCheats: {}, values: seedValues(trainer), error: null });
  },

  async rebindHotkey(cheatId, slot, accelerator) {
    const t = get().trainer;
    if (!t) return { ok: false, error: 'no trainer' };
    const r = await starlight().rebindHotkey({
      trainerId: t.id, cheatId, slot, accelerator,
    });
    if (!r.ok) {
      if (r.error === 'no-active-trainer') return { ok: false, error: 'No trainer is active' };
      return { ok: false, error: r.message ?? r.error };
    }
    return { ok: true };
  },
}));
