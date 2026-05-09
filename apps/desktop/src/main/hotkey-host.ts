import { globalShortcut, BrowserWindow } from 'electron';
import type { StarlightTrainer, StarlightSupportedCheat } from '@starlight/ct-importer';
import * as engineHost from './engine-host.js';
import { CHANNELS, type StarlightEvent } from '../shared/ipc.js';

const registered: string[] = [];
const isOn = new Map<string, boolean>();

function broadcast(e: StarlightEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CHANNELS.event, e);
}

function isSupported(c: unknown): c is StarlightSupportedCheat {
  return !!c && typeof c === 'object' && !('unsupported' in c && (c as { unsupported: unknown }).unsupported === true);
}

function tryRegister(accel: string, cb: () => void | Promise<void>): boolean {
  try {
    const ok = globalShortcut.register(accel, () => { void cb(); });
    if (ok) registered.push(accel);
    return ok;
  } catch {
    return false;
  }
}

function registerCheat(cheat: StarlightSupportedCheat): void {
  const hk = cheat.hotkeys;
  if (!hk) return;
  if (hk.toggle) {
    tryRegister(hk.toggle, async () => {
      const next = !(isOn.get(cheat.id) ?? false);
      const r = await engineHost.toggleCheat(cheat.id, next);
      if (!r.ok) return;
      isOn.set(cheat.id, next);
      broadcast({ type: 'cheat:toggled', cheatId: cheat.id, on: next, cause: 'hotkey' });
    });
  }
  if (cheat.kind === 'value' && hk.inc) {
    tryRegister(hk.inc, async () => {
      const r = await engineHost.incCheat(cheat.id);
      if (r.ok) broadcast({ type: 'hotkey:inc', cheatId: cheat.id });
    });
  }
  if (cheat.kind === 'value' && hk.dec) {
    tryRegister(hk.dec, async () => {
      const r = await engineHost.decCheat(cheat.id);
      if (r.ok) broadcast({ type: 'hotkey:dec', cheatId: cheat.id });
    });
  }
}

export function registerForTrainer(t: StarlightTrainer | null): void {
  unregisterAll();
  if (!t) return;
  for (const cat of t.categories) {
    for (const cheat of cat.cheats) {
      if (!isSupported(cheat)) continue;
      registerCheat(cheat);
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
