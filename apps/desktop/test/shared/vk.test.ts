import { describe, it, expect } from 'vitest';
import { acceleratorToVk, acceleratorLabel } from '../../src/shared/vk.js';

describe('acceleratorToVk', () => {
  it('maps keys to Windows virtual-key codes, modifiers first', () => {
    expect(acceleratorToVk('F1')).toEqual([0x70]);
    expect(acceleratorToVk('num1')).toEqual([0x61]);
    expect(acceleratorToVk('Ctrl+Shift+G')).toEqual([0x11, 0x10, 0x47]);
    expect(acceleratorToVk('Alt+5')).toEqual([0x12, 0x35]);
    expect(acceleratorToVk('CommandOrControl+Up')).toEqual([0x11, 0x26]);
    expect(acceleratorToVk('`')).toEqual([0xc0]);
  });
  it('rejects what Cheat Engine could not register', () => {
    expect(acceleratorToVk('')).toBeNull();
    expect(acceleratorToVk('Ctrl')).toBeNull();
    expect(acceleratorToVk('Hyper+F1')).toBeNull();
    expect(acceleratorToVk('F25')).toBeNull();
  });
  it('labels keys for display', () => {
    expect(acceleratorLabel('num1')).toBe('Num 1');
    expect(acceleratorLabel('Ctrl+num0')).toBe('Ctrl+Num 0');
    expect(acceleratorLabel('F5')).toBe('F5');
  });
});
