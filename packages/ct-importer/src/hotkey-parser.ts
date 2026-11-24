import type { CtHotkey } from './xml-parser.js';

/**
 * Windows virtual-key code -> accelerator key name. This is the full inverse of the
 * renderer's `acceleratorToVk` (apps/desktop/src/shared/vk.ts), using names
 * `parseAccelerator` (apps/desktop/src/main/hotkey-matcher.ts) accepts.
 */
const VK_TO_ACCEL: Record<number, string> = (() => {
  const m: Record<number, string> = {
    8: 'Backspace', 9: 'Tab', 13: 'Enter', 32: 'Space',
    33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
    37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down',
    45: 'Insert', 46: 'Delete',
    0xba: ';', 0xbb: '=', 0xbc: ',', 0xbd: '-', 0xbe: '.', 0xbf: '/', 0xc0: '`',
    0xdb: '[', 0xdc: '\\', 0xdd: ']', 0xde: "'",
  };
  for (let i = 0; i <= 9; i++) m[48 + i] = String(i);          // 0-9
  for (let i = 0; i < 26; i++) m[65 + i] = String.fromCharCode(65 + i); // A-Z
  for (let i = 0; i <= 9; i++) m[96 + i] = `Num${i}`;          // Num0-Num9
  for (let i = 1; i <= 24; i++) m[111 + i] = `F${i}`;          // F1-F24
  return m;
})();

const MODIFIERS: Record<number, string> = { 16: 'Shift', 17: 'Ctrl', 18: 'Alt' };

const ACTION_TO_SLOT: Record<string, 'toggle' | 'inc' | 'dec'> = {
  'Toggle Activation': 'toggle',
  'Increase Value': 'inc',
  'Decrease Value': 'dec',
};

interface ParsedHotkeys { toggle?: string; inc?: string; dec?: string }

/**
 * CE hotkey keys (VK codes, modifiers anywhere) -> an accelerator such as "Ctrl+A".
 * Modifiers keep their order; the last non-modifier key wins; unknown keys are ignored.
 * Undefined when there is no key besides modifiers.
 */
export function vkKeysToAccelerator(keys: number | number[]): string | undefined {
  const arr = Array.isArray(keys) ? keys : [keys];
  const mods: string[] = [];
  let main: string | undefined;
  for (const k of arr) {
    if (MODIFIERS[k]) { mods.push(MODIFIERS[k]); continue; }
    const m = VK_TO_ACCEL[k];
    if (m) main = m;
  }
  if (!main) return undefined;
  return mods.length ? `${mods.join('+')}+${main}` : main;
}

export function parseHotkeys(hotkeys: CtHotkey[] | undefined): ParsedHotkeys | undefined {
  if (!hotkeys || hotkeys.length === 0) return undefined;
  const out: ParsedHotkeys = {};
  for (const hk of hotkeys) {
    const slot = hk.Action ? ACTION_TO_SLOT[hk.Action] : undefined;
    if (!slot) continue;
    const accel = hk.Keys ? vkKeysToAccelerator(hk.Keys.Key) : undefined;
    if (accel) out[slot] = accel;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
