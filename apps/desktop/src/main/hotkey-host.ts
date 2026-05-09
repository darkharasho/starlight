import { globalShortcut, BrowserWindow } from 'electron';
import type { StarlightTrainer, StarlightSupportedCheat } from '@starlight/ct-importer';
import * as engineHost from './engine-host.js';
import { CHANNELS, type StarlightEvent } from '../shared/ipc.js';

const registered: string[] = []; // accelerator strings we own

function isSupported(c: unknown): c is StarlightSupportedCheat {
  return !!c && typeof c === 'object' && !('unsupported' in c && (c as { unsupported: unknown }).unsupported === true);
}

function broadcast(e: StarlightEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CHANNELS.event, e);
}

/** State per cheat to know whether the next hotkey press should turn ON or OFF. */
const isOn = new Map<string, boolean>();

export function registerForTrainer(t: StarlightTrainer | null): void {
  unregisterAll();
  if (!t) return;
  for (const cat of t.categories) {
    for (const cheat of cat.cheats) {
      if (!isSupported(cheat)) continue;
      const accel = cheat.hotkeys?.toggle;
      if (!accel) continue;
      try {
        const ok = globalShortcut.register(accel, async () => {
          const next = !(isOn.get(cheat.id) ?? false);
          const r = await engineHost.toggleCheat(cheat.id, next);
          if (!r.ok) return; // failure: do not flip local state
          isOn.set(cheat.id, next);
          broadcast({ type: 'cheat:toggled', cheatId: cheat.id, on: next, cause: 'hotkey' });
        });
        if (ok) registered.push(accel);
      } catch {
        // accelerator string Electron does not understand — skip
      }
    }
  }
}

export function unregisterAll(): void {
  for (const a of registered) globalShortcut.unregister(a);
  registered.length = 0;
  isOn.clear();
}

export function syncCheatState(cheatId: string, on: boolean): void {
  isOn.set(cheatId, on);
}
