import { describe, it, expect } from 'vitest';
import { parseHotkeys } from '../src/hotkey-parser.js';
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
