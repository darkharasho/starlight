import { describe, it, expect } from 'vitest';
import { keyboardEventToAccelerator } from '../../src/renderer/lib/accelerator.js';

function ev(opts: Partial<KeyboardEventInit> & { code?: string; key?: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', opts as KeyboardEventInit);
}

describe('keyboardEventToAccelerator', () => {
  it('converts plain letter keys (uppercase)', () => {
    expect(keyboardEventToAccelerator(ev({ code: 'KeyA', key: 'a' }))).toBe('A');
    expect(keyboardEventToAccelerator(ev({ code: 'KeyZ', key: 'z' }))).toBe('Z');
  });

  it('converts digit keys', () => {
    expect(keyboardEventToAccelerator(ev({ code: 'Digit5', key: '5' }))).toBe('5');
    expect(keyboardEventToAccelerator(ev({ code: 'Numpad7', key: '7' }))).toBe('num7');
  });

  it('converts function keys', () => {
    expect(keyboardEventToAccelerator(ev({ code: 'F4', key: 'F4' }))).toBe('F4');
    expect(keyboardEventToAccelerator(ev({ code: 'F12', key: 'F12' }))).toBe('F12');
  });

  it('converts arrow keys', () => {
    expect(keyboardEventToAccelerator(ev({ code: 'ArrowUp', key: 'ArrowUp' }))).toBe('Up');
    expect(keyboardEventToAccelerator(ev({ code: 'ArrowDown', key: 'ArrowDown' }))).toBe('Down');
    expect(keyboardEventToAccelerator(ev({ code: 'ArrowLeft', key: 'ArrowLeft' }))).toBe('Left');
    expect(keyboardEventToAccelerator(ev({ code: 'ArrowRight', key: 'ArrowRight' }))).toBe('Right');
  });

  it('prepends modifiers in canonical order', () => {
    expect(keyboardEventToAccelerator(ev({
      code: 'KeyA', key: 'a', ctrlKey: true,
    }))).toBe('Ctrl+A');
    expect(keyboardEventToAccelerator(ev({
      code: 'KeyA', key: 'a', ctrlKey: true, shiftKey: true,
    }))).toBe('Ctrl+Shift+A');
    expect(keyboardEventToAccelerator(ev({
      code: 'KeyA', key: 'a', ctrlKey: true, altKey: true, shiftKey: true,
    }))).toBe('Ctrl+Alt+Shift+A');
  });

  it('uses CommandOrControl when meta is held alone', () => {
    expect(keyboardEventToAccelerator(ev({
      code: 'KeyA', key: 'a', metaKey: true,
    }))).toBe('CommandOrControl+A');
  });

  it('returns null when only modifiers are pressed', () => {
    expect(keyboardEventToAccelerator(ev({ code: 'ControlLeft', key: 'Control', ctrlKey: true }))).toBeNull();
    expect(keyboardEventToAccelerator(ev({ code: 'ShiftRight', key: 'Shift', shiftKey: true }))).toBeNull();
  });

  it('returns null for Escape so the user can cancel', () => {
    expect(keyboardEventToAccelerator(ev({ code: 'Escape', key: 'Escape' }))).toBeNull();
  });

  it('handles common punctuation', () => {
    expect(keyboardEventToAccelerator(ev({ code: 'Space', key: ' ' }))).toBe('Space');
    expect(keyboardEventToAccelerator(ev({ code: 'Tab', key: 'Tab' }))).toBe('Tab');
    expect(keyboardEventToAccelerator(ev({ code: 'Enter', key: 'Enter' }))).toBe('Return');
    expect(keyboardEventToAccelerator(ev({ code: 'Backspace', key: 'Backspace' }))).toBe('Backspace');
    expect(keyboardEventToAccelerator(ev({ code: 'Delete', key: 'Delete' }))).toBe('Delete');
    expect(keyboardEventToAccelerator(ev({ code: 'Equal', key: '=' }))).toBe('=');
    expect(keyboardEventToAccelerator(ev({ code: 'Minus', key: '-' }))).toBe('-');
  });
});

import { findConflict, resolveCheatHotkeys } from '../../src/renderer/lib/accelerator.js';
import type { StarlightSupportedCheat } from '../../src/shared/ipc.js';

describe('findConflict', () => {
  const cheats: StarlightSupportedCheat[] = [
    { id: 'a', name: 'A', type: 'toggle', valueType: 'uint32',
      address: { kind: 'absolute', address: '0x0' },
      hotkeys: { toggle: 'F1' } } as never,
    { id: 'b', name: 'B', type: 'set', valueType: 'float',
      address: { kind: 'absolute', address: '0x0' },
      min: 0, max: 10, step: 1, default: 0,
      hotkeys: { toggle: 'F2', inc: 'F2+Up', dec: 'F2+Down' } } as never,
  ];

  it('returns null when candidate doesnt collide', () => {
    expect(findConflict(cheats, {}, 'a', 'toggle', 'F9')).toBeNull();
  });

  it('detects collision against another cheat default', () => {
    const c = findConflict(cheats, {}, 'a', 'toggle', 'F2');
    expect(c).toEqual({ cheatId: 'b', slot: 'toggle' });
  });

  it('ignores self when collision check', () => {
    expect(findConflict(cheats, {}, 'a', 'toggle', 'F1')).toBeNull();
  });

  it('respects null override (cleared slot doesnt count as collision)', () => {
    const overrides = { b: { toggle: null as string | null } };
    expect(findConflict(cheats, overrides, 'a', 'toggle', 'F2')).toBeNull();
  });

  it('respects non-null override (overridden slot is the conflict target)', () => {
    const overrides = { b: { toggle: 'F9' } };
    expect(findConflict(cheats, overrides, 'a', 'toggle', 'F9')).toEqual({ cheatId: 'b', slot: 'toggle' });
    expect(findConflict(cheats, overrides, 'a', 'toggle', 'F2')).toBeNull();   // default replaced
  });
});

describe('resolveCheatHotkeys', () => {
  const cheat = {
    id: 'x', name: 'X', type: 'set', valueType: 'float',
    address: { kind: 'absolute', address: '0x0' },
    min: 0, max: 10, step: 1, default: 0,
    hotkeys: { toggle: 'F4', inc: 'F4+Up', dec: 'F4+Down' },
  } as never as StarlightSupportedCheat;

  it('returns defaults when no override', () => {
    expect(resolveCheatHotkeys(cheat, undefined)).toEqual({
      toggle: 'F4', inc: 'F4+Up', dec: 'F4+Down',
    });
  });

  it('replaces a slot with a non-null override', () => {
    expect(resolveCheatHotkeys(cheat, { toggle: 'F5' })).toEqual({
      toggle: 'F5', inc: 'F4+Up', dec: 'F4+Down',
    });
  });

  it('clears a slot with null override', () => {
    expect(resolveCheatHotkeys(cheat, { toggle: null })).toEqual({
      inc: 'F4+Up', dec: 'F4+Down',
    });
  });
});
