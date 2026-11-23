/**
 * Electron-style accelerator ("Ctrl+F1", "num1") → Windows virtual-key codes,
 * which is what Cheat Engine's hotkey handler takes. Hotkeys are registered
 * inside Cheat Engine (i.e. inside the game's Wine prefix for Proton games), so
 * they fire while the game has focus — no desktop-wide key grab needed.
 */

const MODIFIERS: Record<string, number> = {
  ctrl: 0x11, control: 0x11, commandorcontrol: 0x11, cmdorctrl: 0x11,
  alt: 0x12, option: 0x12,
  shift: 0x10,
};

const KEYS: Record<string, number> = {
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  space: 0x20, tab: 0x09, return: 0x0d, enter: 0x0d, backspace: 0x08,
  delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  '=': 0xbb, '-': 0xbd, '[': 0xdb, ']': 0xdd, ';': 0xba, "'": 0xde,
  ',': 0xbc, '.': 0xbe, '/': 0xbf, '\\': 0xdc, '`': 0xc0,
};

function keyCode(token: string): number | null {
  const t = token.toLowerCase();
  if (/^[a-z]$/.test(t)) return t.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(t)) return 0x30 + Number(t);
  const fn = /^f(\d{1,2})$/.exec(t);
  if (fn) { const n = Number(fn[1]); return n >= 1 && n <= 24 ? 0x6f + n : null; }
  const num = /^num([0-9])$/.exec(t);
  if (num) return 0x60 + Number(num[1]);
  return KEYS[t] ?? null;
}

/** Returns the key codes (modifiers first), or null if the accelerator can't be expressed. */
export function acceleratorToVk(accelerator: string): number[] | null {
  const tokens = accelerator.split('+').map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) return null;
  const out: number[] = [];
  for (const t of tokens.slice(0, -1)) {
    const m = MODIFIERS[t.toLowerCase()];
    if (m === undefined) return null;
    if (!out.includes(m)) out.push(m);
  }
  const key = keyCode(tokens[tokens.length - 1]!);
  if (key === null) return null;
  out.push(key);
  return out;
}

/** "num1" → "Num 1", "Ctrl+F1" stays as is — for showing on a key chip. */
export function acceleratorLabel(accelerator: string): string {
  return accelerator.split('+').map((t) => t.trim().replace(/^num([0-9])$/i, 'Num $1').replace(/^CommandOrControl$/i, 'Ctrl')).join('+');
}
