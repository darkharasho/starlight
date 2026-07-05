import psList from 'ps-list';
import { BrowserWindow } from 'electron';
import { ProcessHost } from './process-host.js';
import { isAttached } from './engine-host.js';
import { CHANNELS } from '../shared/ipc.js';
import type { StarlightEvent, DetectedProcess } from '../shared/ipc.js';

let onProcessListHook: ((processes: DetectedProcess[]) => void) | null = null;

export function setOnProcessList(cb: (processes: DetectedProcess[]) => void): void {
  onProcessListHook = cb;
}

function broadcast(e: StarlightEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CHANNELS.event, e);
  if (e.type === 'process:list' && onProcessListHook) onProcessListHook(e.processes);
}

export const processHost = new ProcessHost({
  intervalMs: 2000,
  emit: broadcast,
  isAttached: () => isAttached(),
  psList: async () => (await psList()).map(p => ({ pid: p.pid, name: p.name })),
});

let windowVisible = true;
let engineAttached = false;

function reconcile(): void {
  if (windowVisible && !engineAttached) processHost.resume();
  else                                  processHost.pause();
}

export function setWindowVisible(v: boolean): void { windowVisible = v; reconcile(); }
export function setEngineAttached(a: boolean): void { engineAttached = a; reconcile(); }
