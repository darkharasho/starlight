import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { CeRuntimeStatus } from '../../shared/ipc.js';

interface CeRuntimeState {
  status: CeRuntimeStatus | null;
  installing: boolean;
  installError: string | null;
  refresh: () => Promise<void>;
  install: () => Promise<void>;
}

export const useCeRuntimeStore = create<CeRuntimeState>((set) => ({
  status: null,
  installing: false,
  installError: null,
  refresh: async () => {
    try {
      const s = await starlight().ceRuntimeStatus();
      set({ status: s });
    } catch (err) {
      set({ installError: err instanceof Error ? err.message : String(err) });
    }
  },
  install: async () => {
    set({ installing: true, installError: null });
    const off = starlight().onCeRuntimeProgress((e) => {
      const next: CeRuntimeStatus = { status: 'installing', phase: e.phase };
      if (e.current !== undefined) (next as { status: 'installing'; phase: string; current?: number; total?: number }).current = e.current;
      if (e.total !== undefined) (next as { status: 'installing'; phase: string; current?: number; total?: number }).total = e.total;
      set({ status: next });
    });
    try {
      const r = await starlight().ceRuntimeInstall();
      if (!r.ok) set({ installError: r.error });
      const next = await starlight().ceRuntimeStatus();
      set({ status: next });
    } catch (err) {
      set({ installError: err instanceof Error ? err.message : String(err) });
    } finally {
      off();
      set({ installing: false });
    }
  },
}));
