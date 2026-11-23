import { create } from 'zustand';
import { api } from '../ipc-client.js';
import type { DetectedProcess } from '../../shared/ipc.js';
import { useDetectionStore } from './detection-store.js';
import { useConfigStore } from './config-store.js';
import { useCeSessionStore } from './ce-session-store.js';
import { useLibraryStore } from './library-store.js';
import { sessionRequestFor, findCatalogEntry } from '../lib/open-game.js';

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
    else if (e.type === 'session:progress') useCeSessionStore.setState({ progress: e.message });
    else if (e.type === 'session:tables') useCeSessionStore.setState({ pickSteps: e.tables });
    else if (e.type === 'ce:hotkey') useCeSessionStore.getState().applyHotkey(e);
    else if (e.type === 'session:game-exited') void useCeSessionStore.getState().gameExited(e.sessionId);
    else if (e.type === 'library:scanned') useLibraryStore.setState({ games: e.games });
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
        e.confidence === 'exact' &&
        // Play is already bringing this game up and will attach itself.
        !useCeSessionStore.getState().launch && !useCeSessionStore.getState().starting &&
        // One game at a time: never take over from a connected game.
        !useCeSessionStore.getState().attached
      ) {
        const entry = findCatalogEntry(e.game);
        if (entry?.trainerSource) {
          void useCeSessionStore.getState()
            .start(sessionRequestFor(entry, { pid: e.pid, processName: e.name }))
            .then((ok) => { if (ok) useDetectionStore.getState().clear(); }).catch(() => {});
        }
      }
    }
  });
}

export function detachProcessEvents(): void {
  unsub?.();
  unsub = null;
}
