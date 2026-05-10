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

export interface CheatHotkeyOverrideMap {
  toggle?: string | null;
  inc?: string | null;
  dec?: string | null;
}

export type TrainerHotkeyOverrides = Record<string, CheatHotkeyOverrideMap>;

/** Resolve the effective hotkeys for a cheat by overlaying overrides on the trainer defaults.
 *  Override value `null` → slot is explicitly cleared (no binding). Missing → use default. */
function resolveHotkeys(
  cheat: StarlightSupportedCheat,
  override: CheatHotkeyOverrideMap | undefined,
): { toggle?: string; inc?: string; dec?: string } {
  const base = cheat.hotkeys ?? {};
  const out: { toggle?: string; inc?: string; dec?: string } = {};
  for (const slot of ['toggle', 'inc', 'dec'] as const) {
    if (override && slot in override) {
      const v = override[slot];
      if (v != null) out[slot] = v;                      // explicit non-null override
      // else: explicitly cleared → omit from out
    } else if (base[slot]) {
      out[slot] = base[slot];                             // default
    }
  }
  return out;
}

function registerCheat(cheat: StarlightSupportedCheat, override: CheatHotkeyOverrideMap | undefined): void {
  const hk = resolveHotkeys(cheat, override);
  if (hk.toggle) {
    tryRegister(hk.toggle, async () => {
      const next = !(isOn.get(cheat.id) ?? false);
      const r = await engineHost.toggleCheat(cheat.id, next);
      if (!r.ok) return;
      isOn.set(cheat.id, next);
      broadcast({ type: 'cheat:toggled', cheatId: cheat.id, on: next, cause: 'hotkey' });
    });
  }
  if (cheat.type === 'set' && hk.inc) {
    tryRegister(hk.inc, async () => {
      const r = await engineHost.incCheat(cheat.id);
      if (r.ok) broadcast({ type: 'hotkey:inc', cheatId: cheat.id });
    });
  }
  if (cheat.type === 'set' && hk.dec) {
    tryRegister(hk.dec, async () => {
      const r = await engineHost.decCheat(cheat.id);
      if (r.ok) broadcast({ type: 'hotkey:dec', cheatId: cheat.id });
    });
  }
}

export function registerForTrainer(t: StarlightTrainer | null, overrides: TrainerHotkeyOverrides = {}): void {
  unregisterAll();
  if (!t) return;
  for (const cat of t.categories) {
    for (const cheat of cat.cheats) {
      if (!isSupported(cheat)) continue;
      registerCheat(cheat, overrides[cheat.id]);
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
