import { create } from 'zustand';
import { api } from '../ipc-client.js';
import type { DetectedProcess } from '../../shared/ipc.js';
import { useDetectionStore } from './detection-store.js';
import { useCatalogStore } from './catalog-store.js';
import { useConfigStore } from './config-store.js';
import { useCeSessionStore } from './ce-session-store.js';

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
    else if (e.type === 'game:detected') {
      useDetectionStore.getState().setDetected({
        game: e.game,
        pid: e.pid,
        name: e.name,
        confidence: e.confidence,
      });
      // Setting A: auto-fire latch on exact match when preference enabled
      if (
        useConfigStore.getState().config?.preferences.autoAttachOnDetect &&
        e.confidence === 'exact'
      ) {
        const entry = useCatalogStore.getState().index?.games.find((g) => g.id === e.game.id);
        const source = entry?.trainerPath ?? entry?.trainerSource;
        if (source) {
          void useCeSessionStore.getState().start({
            source,
            cacheKey: e.game.id,
            pid: e.pid,
            processName: e.name,
            game: e.game,
          }).finally(() => {
            useDetectionStore.getState().clear();
          });
        }
      }
    }
  });
}

export function detachProcessEvents(): void {
  unsub?.();
  unsub = null;
}
