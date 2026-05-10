/**
 * Convert a browser KeyboardEvent to an Electron accelerator string
 * (https://www.electronjs.org/docs/latest/api/accelerator).
 *
 * Returns null for events that should NOT bind (modifier-only, Escape, unsupported key).
 */

const CODE_MAP: Record<string, string> = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Space: 'Space', Tab: 'Tab', Enter: 'Return', Backspace: 'Backspace',
  Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown',
  Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  Backquote: '`',
};

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'OSLeft', 'OSRight',
]);

function codeToToken(code: string, key: string): string | null {
  // Letters: KeyA → A
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  // Digits: Digit0–9 → 0–9
  if (/^Digit\d$/.test(code)) return code.slice(5);
  // Numpad digits → num0..num9 (Electron accelerator uses lowercase 'num')
  if (/^Numpad\d$/.test(code)) return 'num' + code.slice(6);
  // Function keys F1–F24 (check code first, then key as fallback for test envs)
  if (/^F\d{1,2}$/.test(code)) return code;
  if (/^F\d{1,2}$/.test(key)) return key;
  // Mapped specials
  if (code in CODE_MAP) return CODE_MAP[code]!;
  // Last-resort: single-character key value
  if (key.length === 1) return key.toUpperCase();
  return null;
}

export function keyboardEventToAccelerator(e: KeyboardEvent): string | null {
  if (e.code === 'Escape' || e.key === 'Escape') return null;
  if (MODIFIER_CODES.has(e.code)) return null;

  const token = codeToToken(e.code, e.key);
  if (token === null) return null;

  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (!e.ctrlKey && e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(token);
  return parts.join('+');
}

import type { StarlightSupportedCheat } from '../../shared/ipc.js';

export interface ResolvedHotkeys { toggle?: string; inc?: string; dec?: string }

/** Resolve effective hotkeys for a cheat by overlaying overrides on the cheat's defaults. */
export function resolveCheatHotkeys(
  cheat: StarlightSupportedCheat,
  override: { toggle?: string | null; inc?: string | null; dec?: string | null } | undefined,
): ResolvedHotkeys {
  const base = cheat.hotkeys ?? {};
  const out: ResolvedHotkeys = {};
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

export function findConflict(
  cheats: StarlightSupportedCheat[],
  overrides: Record<string, { toggle?: string | null; inc?: string | null; dec?: string | null }>,
  selfCheatId: string,
  selfSlot: 'toggle' | 'inc' | 'dec',
  candidate: string,
): { cheatId: string; slot: string } | null {
  for (const c of cheats) {
    const hk = resolveCheatHotkeys(c, overrides[c.id]);
    for (const slot of ['toggle', 'inc', 'dec'] as const) {
      if (c.id === selfCheatId && slot === selfSlot) continue;
      if (hk[slot] === candidate) return { cheatId: c.id, slot };
    }
  }
  return null;
}
