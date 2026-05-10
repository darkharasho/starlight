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
