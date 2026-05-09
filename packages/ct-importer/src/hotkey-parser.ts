import type { CtHotkey } from './xml-parser.js';

const VK_TO_ACCEL: Record<number, string> = {
  // Modifiers — handled separately, mapped to '' so they don't leak into the result key
  16: '',  17: '',  18: '',
  // F-keys
  112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4', 116: 'F5', 117: 'F6',
  118: 'F7', 119: 'F8', 120: 'F9', 121: 'F10', 122: 'F11', 123: 'F12',
  // Navigation
  33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
  37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down',
  45: 'Insert', 46: 'Delete',
  // Letters/numbers (subset; expand as needed)
  48: '0', 49: '1', 50: '2', 51: '3', 52: '4',
  53: '5', 54: '6', 55: '7', 56: '8', 57: '9',
};

const MODIFIERS: Record<number, string> = { 16: 'Shift', 17: 'Ctrl', 18: 'Alt' };

const ACTION_TO_SLOT: Record<string, 'toggle' | 'inc' | 'dec'> = {
  'Toggle Activation': 'toggle',
  'Increase Value': 'inc',
  'Decrease Value': 'dec',
};

interface ParsedHotkeys { toggle?: string; inc?: string; dec?: string }

function keysToAccel(keys: number | number[]): string | undefined {
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
    const accel = hk.Keys ? keysToAccel(hk.Keys.Key) : undefined;
    if (accel) out[slot] = accel;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}
