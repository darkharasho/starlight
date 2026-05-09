import { create } from 'zustand';
import { api } from '../ipc-client.js';
import type { DetectedProcess } from '../../shared/ipc.js';

interface ProcessState {
  processes: DetectedProcess[];
  matchedPid: number | null;
  refresh: () => Promise<void>;
}

export const useProcessStore = create<ProcessState>((set) => ({
  processes: [],
  matchedPid: null,
  refresh: async () => {
    try {
      const r = await api().listProcesses();
      set({ processes: r.processes });
    } catch { /* swallow — picker stays usable */ }
  },
}));

let unsub: (() => void) | null = null;

export function attachProcessEvents(): void {
  if (unsub) return;
  unsub = api().onEvent((e) => {
    if (e.type === 'process:list') useProcessStore.setState({ processes: e.processes });
    else if (e.type === 'process:matched') useProcessStore.setState({ matchedPid: e.pid });
  });
}

export function detachProcessEvents(): void {
  unsub?.();
  unsub = null;
}
