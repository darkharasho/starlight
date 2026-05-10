import { uIOhook, type UiohookKeyboardEvent } from 'uiohook-napi';
import { BrowserWindow } from 'electron';
import type { StarlightTrainer, StarlightSupportedCheat } from '@starlight/ct-importer';
import * as engineHost from './engine-host.js';
import { CHANNELS, type StarlightEvent } from '../shared/ipc.js';
import { parseAccelerator, type AcceleratorMatcher } from './hotkey-matcher.js';

export interface CheatHotkeyOverrideMap {
  toggle?: string | null;
  inc?: string | null;
  dec?: string | null;
}
export type TrainerHotkeyOverrides = Record<string, CheatHotkeyOverrideMap>;

interface RegisteredCheat {
  cheatId: string;
  toggleMatcher?: AcceleratorMatcher;
  incMatcher?: AcceleratorMatcher;
  decMatcher?: AcceleratorMatcher;
  isValueCheat: boolean;
}

const cheats: RegisteredCheat[] = [];
const isOn = new Map<string, boolean>();
let started = false;
let onInitFailure: ((message: string) => void) | null = null;

function broadcast(e: StarlightEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CHANNELS.event, e);
}

function isSupported(c: unknown): c is StarlightSupportedCheat {
  return !!c && typeof c === 'object' && !('unsupported' in c && (c as { unsupported: unknown }).unsupported === true);
}

function resolveHotkeys(
  cheat: StarlightSupportedCheat,
  override: CheatHotkeyOverrideMap | undefined,
): { toggle?: string; inc?: string; dec?: string } {
  const base = cheat.hotkeys ?? {};
  const out: { toggle?: string; inc?: string; dec?: string } = {};
  for (const slot of ['toggle', 'inc', 'dec'] as const) {
    if (override && slot in override) {
      const v = override[slot];
      if (v != null) out[slot] = v;
    } else if (base[slot]) {
      out[slot] = base[slot];
    }
  }
  return out;
}

async function onKeyDown(e: UiohookKeyboardEvent): Promise<void> {
  for (const reg of cheats) {
    if (reg.toggleMatcher?.(e)) {
      const next = !(isOn.get(reg.cheatId) ?? false);
      const r = await engineHost.toggleCheat(reg.cheatId, next);
      if (r.ok) {
        isOn.set(reg.cheatId, next);
        broadcast({ type: 'cheat:toggled', cheatId: reg.cheatId, on: next, cause: 'hotkey' });
      }
      continue;
    }
    if (reg.isValueCheat && reg.incMatcher?.(e)) {
      const r = await engineHost.incCheat(reg.cheatId);
      if (r.ok) broadcast({ type: 'hotkey:inc', cheatId: reg.cheatId });
      continue;
    }
    if (reg.isValueCheat && reg.decMatcher?.(e)) {
      const r = await engineHost.decCheat(reg.cheatId);
      if (r.ok) broadcast({ type: 'hotkey:dec', cheatId: reg.cheatId });
      continue;
    }
  }
}

function ensureStarted(): void {
  if (started) return;
  try {
    uIOhook.on('keydown', onKeyDown);
    uIOhook.start();
    started = true;
  } catch (err) {
    try { uIOhook.off('keydown', onKeyDown); } catch { /* ignore */ }
    const message = err instanceof Error ? err.message : String(err);
    onInitFailure?.(message);
  }
}

export function registerForTrainer(t: StarlightTrainer | null, overrides: TrainerHotkeyOverrides = {}): void {
  unregisterAll();
  if (!t) return;
  for (const cat of t.categories) {
    for (const cheat of cat.cheats) {
      if (!isSupported(cheat)) continue;
      const hk = resolveHotkeys(cheat, overrides[cheat.id]);
      const reg: RegisteredCheat = {
        cheatId: cheat.id,
        isValueCheat: cheat.type === 'set',
      };
      if (hk.toggle) {
        const m = parseAccelerator(hk.toggle);
        if (m) reg.toggleMatcher = m;
      }
      if (reg.isValueCheat && hk.inc) {
        const m = parseAccelerator(hk.inc);
        if (m) reg.incMatcher = m;
      }
      if (reg.isValueCheat && hk.dec) {
        const m = parseAccelerator(hk.dec);
        if (m) reg.decMatcher = m;
      }
      if (reg.toggleMatcher || reg.incMatcher || reg.decMatcher) {
        cheats.push(reg);
      }
    }
  }
  ensureStarted();
}

export function unregisterAll(): void {
  cheats.length = 0;
  isOn.clear();
}

export function syncCheatState(cheatId: string, on: boolean): void {
  isOn.set(cheatId, on);
}

export function shutdown(): void {
  if (!started) return;
  try {
    uIOhook.off('keydown', onKeyDown);
    uIOhook.stop();
  } catch { /* ignore — best-effort cleanup */ }
  started = false;
}

export function setInitFailureHandler(fn: (message: string) => void): void {
  onInitFailure = fn;
}
