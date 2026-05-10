import { UiohookKey, type UiohookKeyboardEvent } from 'uiohook-napi';

export type AcceleratorMatcher = (e: UiohookKeyboardEvent) => boolean;

interface ParsedModifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

const isMac = process.platform === 'darwin';

const MODIFIER_TOKENS: Record<string, keyof ParsedModifiers> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};

/** Tokens that depend on platform: CommandOrControl → Ctrl on non-Mac, Cmd on Mac. */
const PLATFORM_MODIFIER_TOKENS = new Set([
  'commandorcontrol', 'cmdorctrl', 'commandorctrl',
]);

/** Map accelerator key tokens (lowercased) to libuiohook keycodes. */
const KEY_TOKEN_TO_UIOHOOK: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  // Letters A-Z
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const k = (UiohookKey as Record<string, number | undefined>)[c];
    if (k !== undefined) m[c.toLowerCase()] = k;
  }
  // Digits 0-9 (Electron uses bare '0'..'9')
  for (let i = 0; i <= 9; i++) {
    const k = (UiohookKey as Record<string, number | undefined>)[`Digit${i}`];
    if (k !== undefined) m[String(i)] = k;
  }
  // Function keys F1-F24
  for (let i = 1; i <= 24; i++) {
    const k = (UiohookKey as Record<string, number | undefined>)[`F${i}`];
    if (k !== undefined) m[`f${i}`] = k;
  }
  // Arrows
  if (UiohookKey.ArrowUp    !== undefined) m['up']    = UiohookKey.ArrowUp;
  if (UiohookKey.ArrowDown  !== undefined) m['down']  = UiohookKey.ArrowDown;
  if (UiohookKey.ArrowLeft  !== undefined) m['left']  = UiohookKey.ArrowLeft;
  if (UiohookKey.ArrowRight !== undefined) m['right'] = UiohookKey.ArrowRight;
  // Common specials
  const specials: Array<[string, keyof typeof UiohookKey]> = [
    ['space', 'Space'],
    ['tab', 'Tab'],
    ['return', 'Enter'],
    ['enter', 'Enter'],
    ['backspace', 'Backspace'],
    ['delete', 'Delete'],
    ['insert', 'Insert' as keyof typeof UiohookKey],
    ['home', 'Home' as keyof typeof UiohookKey],
    ['end', 'End' as keyof typeof UiohookKey],
    ['pageup', 'PageUp' as keyof typeof UiohookKey],
    ['pagedown', 'PageDown' as keyof typeof UiohookKey],
    ['escape', 'Escape' as keyof typeof UiohookKey],
    ['esc', 'Escape' as keyof typeof UiohookKey],
  ];
  for (const [token, uiohookName] of specials) {
    const k = (UiohookKey as Record<string, number | undefined>)[uiohookName];
    if (k !== undefined) m[token] = k;
  }
  // Punctuation
  const punct: Array<[string, string]> = [
    ['=', 'Equal'], ['-', 'Minus'],
    ['[', 'BracketLeft'], [']', 'BracketRight'],
    [';', 'Semicolon'], ["'", 'Quote'],
    [',', 'Comma'], ['.', 'Period'], ['/', 'Slash'], ['\\', 'Backslash'],
    ['`', 'Backquote'],
  ];
  for (const [token, uiohookName] of punct) {
    const k = (UiohookKey as Record<string, number | undefined>)[uiohookName];
    if (k !== undefined) m[token] = k;
  }
  // Numpad: num0..num9
  for (let i = 0; i <= 9; i++) {
    const k = (UiohookKey as Record<string, number | undefined>)[`Numpad${i}`];
    if (k !== undefined) m[`num${i}`] = k;
  }
  return m;
})();

export function parseAccelerator(s: string): AcceleratorMatcher | null {
  if (!s || typeof s !== 'string') return null;
  const tokens = s.split('+').map(t => t.trim()).filter(t => t.length > 0);
  if (tokens.length === 0) return null;

  const mods: ParsedModifiers = { ctrl: false, alt: false, shift: false, meta: false };
  // Last token is the key; preceding are modifiers.
  const keyToken = tokens[tokens.length - 1]!;
  const modTokens = tokens.slice(0, -1);

  for (const t of modTokens) {
    const lower = t.toLowerCase();
    if (PLATFORM_MODIFIER_TOKENS.has(lower)) {
      if (isMac) mods.meta = true;
      else       mods.ctrl = true;
      continue;
    }
    const target = MODIFIER_TOKENS[lower];
    if (!target) return null;
    mods[target] = true;
  }

  const keycode = KEY_TOKEN_TO_UIOHOOK[keyToken.toLowerCase()];
  if (keycode === undefined) return null;

  return (e) => (
    e.keycode === keycode
    && Boolean(e.ctrlKey)  === mods.ctrl
    && Boolean(e.altKey)   === mods.alt
    && Boolean(e.shiftKey) === mods.shift
    && Boolean(e.metaKey)  === mods.meta
  );
}
