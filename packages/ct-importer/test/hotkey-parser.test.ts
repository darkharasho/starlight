import { describe, it, expect } from 'vitest';
import { parseHotkeys, vkKeysToAccelerator } from '../src/hotkey-parser.js';
// The renderer's accelerator -> VK mapping; vkKeysToAccelerator must be its full inverse (R14).
import { acceleratorToVk } from '../../../apps/desktop/src/shared/vk.js';
import type { CtHotkey } from '../src/xml-parser.js';

describe('parseHotkeys', () => {
  it('returns undefined for empty input', () => {
    expect(parseHotkeys(undefined)).toBeUndefined();
    expect(parseHotkeys([])).toBeUndefined();
  });

  it('parses a single Toggle Activation with F1 (VK 112)', () => {
    const input: CtHotkey[] = [{ Action: 'Toggle Activation', Keys: { Key: 112 } }];
    expect(parseHotkeys(input)).toEqual({ toggle: 'F1' });
  });

  it('parses Increase / Decrease Value with PageUp/PageDown', () => {
    const input: CtHotkey[] = [
      { Action: 'Toggle Activation', Keys: { Key: 115 } }, // F4
      { Action: 'Increase Value', Keys: { Key: 33 } },     // PageUp
      { Action: 'Decrease Value', Keys: { Key: 34 } },     // PageDown
    ];
    expect(parseHotkeys(input)).toEqual({ toggle: 'F4', inc: 'PageUp', dec: 'PageDown' });
  });

  it('combines modifiers Ctrl/Shift/Alt with the main key', () => {
    const input: CtHotkey[] = [
      { Action: 'Toggle Activation', Keys: { Key: [17, 112] } }, // Ctrl + F1
    ];
    expect(parseHotkeys(input)).toEqual({ toggle: 'Ctrl+F1' });
  });

  it('returns undefined toggle for unmapped keys', () => {
    const input: CtHotkey[] = [{ Action: 'Toggle Activation', Keys: { Key: 99999 } }];
    expect(parseHotkeys(input)).toBeUndefined();
  });

  it('ignores actions we do not recognise', () => {
    const input: CtHotkey[] = [
      { Action: 'Toggle Activation', Keys: { Key: 112 } },
      { Action: 'Set Value to', Keys: { Key: 113 } }, // not in our action set
    ];
    expect(parseHotkeys(input)).toEqual({ toggle: 'F1' });
  });
});

describe('vkKeysToAccelerator', () => {
  it('vkKeysToAccelerator maps letters and numpad', () => {
    expect(vkKeysToAccelerator([17, 65])).toBe('Ctrl+A');
    expect(vkKeysToAccelerator([90])).toBe('Z');
    expect(vkKeysToAccelerator([96])).toBe('Num0');
    expect(vkKeysToAccelerator([105])).toBe('Num9');
    expect(vkKeysToAccelerator([32])).toBe('Space');
    expect(vkKeysToAccelerator([16, 18, 112])).toBe('Shift+Alt+F1');
    expect(vkKeysToAccelerator([17])).toBeUndefined();
    expect(vkKeysToAccelerator([])).toBeUndefined();
  });

  it('is the full inverse of the renderer acceleratorToVk (R14)', () => {
    const vks: number[] = [];
    for (let k = 0; k < 256; k++) if (k < 16 || k > 18) vks.push(k);
    const mapped = vks.filter((k) => vkKeysToAccelerator([k]) !== undefined);
    // Every key the renderer can produce has a name, and the name maps back to the key.
    for (const k of mapped) {
      expect(acceleratorToVk(vkKeysToAccelerator([k])!)).toEqual([k]);
      expect(acceleratorToVk(vkKeysToAccelerator([17, 16, k])!)).toEqual([17, 16, k]);
    }
    const tokens = [
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
      ...Array.from({ length: 10 }, (_, i) => `num${i}`),
      'Up', 'Down', 'Left', 'Right', 'Space', 'Tab', 'Enter', 'Return', 'Backspace',
      'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
      '=', '-', '[', ']', ';', "'", ',', '.', '/', '\\', '`',
    ];
    for (const t of tokens) {
      const vk = acceleratorToVk(t);
      expect(vk, t).not.toBeNull();
      const back = vkKeysToAccelerator(vk!);
      expect(back, t).toBeDefined();
      expect(acceleratorToVk(back!)).toEqual(vk);
    }
    expect(mapped.length).toBe(new Set(tokens.map((t) => acceleratorToVk(t)![0])).size);
  });
});
