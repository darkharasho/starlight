import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { DeepPartial, UserConfig } from '../../shared/ipc.js';

interface ConfigState {
  config: UserConfig | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  update: (patch: DeepPartial<UserConfig>) => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set) => ({
  config: null,
  loading: false,
  error: null,
  load: async () => {
    set({ loading: true, error: null });
    try {
      const config = await starlight().getConfig();
      set({ config, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },
  update: async (patch) => {
    try {
      const config = await starlight().updateConfig({ patch });
      set({ config });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));

let unsub: (() => void) | null = null;

export function attachConfigEvents(): void {
  if (unsub) return;
  unsub = starlight().onEvent((e) => {
    if (e.type === 'config:changed') useConfigStore.setState({ config: e.config });
  });
}

export function detachConfigEvents(): void { unsub?.(); unsub = null; }
