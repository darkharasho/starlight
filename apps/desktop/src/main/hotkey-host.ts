import { uIOhook, type UiohookKeyboardEvent } from 'uiohook-napi';
import { BrowserWindow } from 'electron';
import { isValueCheat, type StarlightTrainer, type StarlightSupportedCheat } from '@starlight/ct-importer';
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

type AgentSlot = 'yes' | 'no' | 'stop';
interface AgentBinding { matcher: AcceleratorMatcher; handler: () => void }
const agentBindings = new Map<AgentSlot, AgentBinding>();
const AGENT_SLOTS: AgentSlot[] = ['yes', 'no', 'stop'];

/**
 * Global hotkeys for the agent (yes/no for a question, Stop). They live apart
 * from cheat bindings, so `registerForTrainer` and `unregisterAll` never clear
 * them. A slot present in `b` is rebound (`null` unbinds it); a slot absent
 * from `b` keeps its binding and handler. `b === null` clears every slot.
 */
export function setAgentHotkeys(
  b: { yes?: string | null; no?: string | null; stop?: string | null } | null,
  on: { yes?(): void; no?(): void; stop?(): void } = {},
): { ok: true } | { ok: false; invalid: string[] } {
  if (b === null) {
    agentBindings.clear();
    return { ok: true };
  }
  const invalid: string[] = [];
  const next = new Map<AgentSlot, AgentBinding | null>();
  for (const slot of AGENT_SLOTS) {
    if (!(slot in b)) continue;
    const accel = b[slot];
    if (accel == null) { next.set(slot, null); continue; }
    const matcher = parseAccelerator(accel);
    const handler = on[slot];
    if (!matcher) { invalid.push(accel); continue; }
    if (!handler) continue;
    next.set(slot, { matcher, handler });
  }
  if (invalid.length > 0) return { ok: false, invalid };
  for (const [slot, binding] of next) {
    if (binding) agentBindings.set(slot, binding);
    else agentBindings.delete(slot);
  }
  if (agentBindings.size > 0) ensureStarted();
  return { ok: true };
}

export type AgentHotkeysPort = { set: typeof setAgentHotkeys };

interface SessionBinding { id: number; matcher: AcceleratorMatcher }
const sessionBindings: SessionBinding[] = [];
let onSessionPress: ((id: number) => void) | null = null;

/**
 * Hotkeys of the running native table session. A third slot, apart from the
 * trainer's and the agent's: `registerForTrainer` and `unregisterAll` never
 * clear it. Each call replaces the previous session bindings. `id`s are opaque
 * to the host; a press calls `onPress(id)`. Bindings whose accelerator can't
 * be read are skipped.
 */
export function setSessionHotkeys(bindings: Array<{ id: number; accelerator: string }>, onPress: (id: number) => void): void {
  sessionBindings.length = 0;
  for (const b of bindings) {
    const matcher = parseAccelerator(b.accelerator);
    if (matcher) sessionBindings.push({ id: b.id, matcher });
  }
  onSessionPress = onPress;
  if (sessionBindings.length > 0) ensureStarted();
}

export function clearSessionHotkeys(): void {
  sessionBindings.length = 0;
  onSessionPress = null;
}

async function onKeyDown(e: UiohookKeyboardEvent): Promise<void> {
  for (const slot of AGENT_SLOTS) {
    const binding = agentBindings.get(slot);
    if (binding?.matcher(e)) {
      try { binding.handler(); } catch { /* a handler's failure must not break the listener */ }
      return;
    }
  }
  const press = onSessionPress;
  for (const b of [...sessionBindings]) {
    if (!press || !b.matcher(e)) continue;
    try { press(b.id); } catch { /* a handler's failure must not break the listener */ }
  }
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
      if (!isValueCheat(cheat)) continue;
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
