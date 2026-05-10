import { describe, it, expect, vi } from 'vitest';

// Minimal mock of uiohook-napi's UiohookKey constants — only those we need.
vi.mock('uiohook-napi', () => ({
  UiohookKey: {
    A: 0x1e, Z: 0x2c, F: 0x21,
    F1: 0x3b, F4: 0x3e, F12: 0x58,
    Digit0: 0x0b, Digit1: 0x02, Digit5: 0x06,
    ArrowUp: 0xc8, ArrowDown: 0xd0, ArrowLeft: 0xcb, ArrowRight: 0xcd,
    Space: 0x39, Tab: 0x0f, Enter: 0x1c, Backspace: 0x0e, Delete: 0xd3,
    Equal: 0x0d, Minus: 0x0c, Slash: 0x35,
    Numpad0: 0x52, Numpad7: 0x47,
  },
}));

import { parseAccelerator, type AcceleratorMatcher } from '../../src/main/hotkey-matcher.js';

interface TestEvent {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

function ev(over: Partial<TestEvent>): TestEvent {
  return { keycode: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over };
}

describe('parseAccelerator', () => {
  it('parses single key tokens', () => {
    const m = parseAccelerator('F4');
    expect(m).not.toBeNull();
    expect(m!(ev({ keycode: 0x3e }) as never)).toBe(true);
    expect(m!(ev({ keycode: 0x3b }) as never)).toBe(false);                // F1, not F4
  });

  it('parses single-modifier combos', () => {
    const m = parseAccelerator('Ctrl+F4');
    expect(m!(ev({ keycode: 0x3e, ctrlKey: true }) as never)).toBe(true);
    expect(m!(ev({ keycode: 0x3e }) as never)).toBe(false);                // missing modifier
  });

  it('parses multi-modifier combos in any order', () => {
    const a = parseAccelerator('Ctrl+Shift+F4');
    const b = parseAccelerator('Shift+Ctrl+F4');
    const evt = ev({ keycode: 0x3e, ctrlKey: true, shiftKey: true });
    expect(a!(evt as never)).toBe(true);
    expect(b!(evt as never)).toBe(true);
  });

  it('CommandOrControl maps to Ctrl on Linux/Win, Cmd on macOS', () => {
    const m = parseAccelerator('CommandOrControl+A');
    if (process.platform === 'darwin') {
      expect(m!(ev({ keycode: 0x1e, metaKey: true }) as never)).toBe(true);
      expect(m!(ev({ keycode: 0x1e, ctrlKey: true }) as never)).toBe(false);
    } else {
      expect(m!(ev({ keycode: 0x1e, ctrlKey: true }) as never)).toBe(true);
      expect(m!(ev({ keycode: 0x1e, metaKey: true }) as never)).toBe(false);
    }
  });

  it('matcher requires EXACT modifier match (Ctrl+F4 does NOT fire on Ctrl+Shift+F4)', () => {
    const m = parseAccelerator('Ctrl+F4');
    expect(m!(ev({ keycode: 0x3e, ctrlKey: true, shiftKey: true }) as never)).toBe(false);
  });

  it('returns null on unknown key tokens', () => {
    expect(parseAccelerator('F99')).toBeNull();
    expect(parseAccelerator('Mystery')).toBeNull();
    expect(parseAccelerator('')).toBeNull();
  });

  it('returns null on unknown modifier tokens', () => {
    expect(parseAccelerator('Hyper+A')).toBeNull();
  });

  it('parses arrow and special keys', () => {
    expect(parseAccelerator('Up')!(ev({ keycode: 0xc8 }) as never)).toBe(true);
    expect(parseAccelerator('Space')!(ev({ keycode: 0x39 }) as never)).toBe(true);
    expect(parseAccelerator('Return')!(ev({ keycode: 0x1c }) as never)).toBe(true);
  });

  it('parses numpad keys via num<n> tokens', () => {
    expect(parseAccelerator('num7')!(ev({ keycode: 0x47 }) as never)).toBe(true);
  });
});
