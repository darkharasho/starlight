import { create } from 'zustand';
import { starlight } from '../ipc-client.js';
import type { CeRuntimeStatus } from '../../shared/ipc.js';

// The trainer engine installs itself in the background (main process). This
// store mirrors its state so the UI can show progress or a failed download.

interface CeRuntimeState {
  status: CeRuntimeStatus | null;
  error: string | null;
  refresh: () => Promise<void>;
  /** Try the download again now (after a failure). */
  retry: () => Promise<void>;
}

export const useCeRuntimeStore = create<CeRuntimeState>((set) => ({
  status: null,
  error: null,
  refresh: async () => {
    try {
      set({ status: await starlight().ceRuntimeStatus() });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
  retry: async () => {
    set({ error: null });
    const r = await starlight().ceRuntimeInstall()
      .catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) }));
    if (!r.ok) set({ error: r.error });
  },
}));

/** Follows the main process's install state. Returns the unsubscribe. */
export function attachCeRuntimeEvents(): () => void {
  void useCeRuntimeStore.getState().refresh();
  return starlight().onEvent((e) => {
    if (e.type === 'ceRuntime:status') useCeRuntimeStore.setState({ status: e.status, error: e.error ?? null });
  });
}
