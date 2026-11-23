import psList from 'ps-list';
import { BrowserWindow } from 'electron';
import { ProcessHost } from './process-host.js';
import { isAttached } from './engine-host.js';
import { CHANNELS } from '../shared/ipc.js';
import type { StarlightEvent, DetectedProcess } from '../shared/ipc.js';
import { readExeName } from './proc-exe-name.js';

let onProcessListHook: ((processes: DetectedProcess[]) => void) | null = null;

// Single subscriber by design (last-write-wins).
export function setOnProcessList(cb: (processes: DetectedProcess[]) => void): void {
  onProcessListHook = cb;
}

function broadcast(e: StarlightEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CHANNELS.event, e);
  if (e.type === 'process:list' && onProcessListHook) onProcessListHook(e.processes);
}

const COMM_MAX = 15; // Linux clips a process name (comm) to TASK_COMM_LEN - 1

/**
 * Linux reports "BeekeeperSimulator.exe" as "BeekeeperSimula": the clipped name
 * loses its `.exe`, so the game vanishes from every "running games" list and
 * can't be matched or attached by name. Recover the full name from the
 * command line for any process whose name was long enough to be clipped.
 */
export async function withFullExeNames(procs: DetectedProcess[]): Promise<DetectedProcess[]> {
  return Promise.all(procs.map(async (p) => {
    if (p.name.length < COMM_MAX) return p;
    const full = await readExeName(p.pid, p.name).catch(() => undefined);
    return full && full !== p.name ? { ...p, name: full } : p;
  }));
}

export const processHost = new ProcessHost({
  intervalMs: 2000,
  emit: broadcast,
  isAttached: () => isAttached(),
  psList: async () => withFullExeNames((await psList()).map(p => ({ pid: p.pid, name: p.name }))),
});

let windowVisible = true;
let engineAttached = false;

function reconcile(): void {
  if (windowVisible && !engineAttached) processHost.resume();
  else                                  processHost.pause();
}

export function setWindowVisible(v: boolean): void { windowVisible = v; reconcile(); }
export function setEngineAttached(a: boolean): void { engineAttached = a; reconcile(); }
